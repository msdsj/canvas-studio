"""号池代理：ChatGPT 账号转发上游、通用 API Key 存本地。

设计说明
--------
平台号池页导入的凭据分两类，按 token 形态自动分流：

* **ChatGPT 登录凭据**（`eyJ...` 的 JWT）：真正生图的引擎是上游 chatgpt2api，
  账号必须存在它那里，额度也只能由它查询。因此这类 token 直接转发到
  上游 `/api/accounts*`，列表里把上游返回的真实额度一并带回。
* **通用 API Key**（`sk-...` 等）：无统一额度/OAuth 协议，存本地号池
  （`POOL_FILE`），由 gateway 轮询选用。

上游地址复用图片 provider 配置：`IMAGE_API_BASE_URL` 去掉尾部 `/v1`，
管理员密钥复用 `IMAGE_API_KEY`。上游不可达时自动降级为纯本地号池，
不会让整个号池页报错。
"""
from __future__ import annotations

import logging
from typing import Any

from app.services.account_pool import account_pool
from app.state import runtime_config
from app.upstream import provider_client
from app.utils.errors import ErrorCode, GatewayError

logger = logging.getLogger(__name__)

# 上游任务 id 登记表：用于 refresh_progress 判断该查上游还是本地池。
# 对外暴露的 job_id 与上游 progress_id 保持一致，不额外加前缀。
_UPSTREAM_JOBS: set[str] = set()
_UPSTREAM_JOBS_MAX = 200

# 上游状态（中文）→ 平台状态
_STATUS_MAP = {
    "正常": "normal",
    "限流": "limited",
    "异常": "abnormal",
    "禁用": "disabled",
    "封禁": "disabled",
    "normal": "normal",
    "limited": "limited",
    "abnormal": "abnormal",
    "disabled": "disabled",
}

_UPSTREAM_TIMEOUT = 25.0


def _upstream_base() -> str | None:
    """从图片 provider 地址推导上游服务根地址（去掉尾部 /v1）。"""
    base = (runtime_config.image_base_url or "").rstrip("/")
    if not base:
        return None
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base or None


def _upstream_headers() -> dict[str, str]:
    key = runtime_config.image_api_key or ""
    return {"Authorization": f"Bearer {key}"} if key else {}


def is_chatgpt_token(token: str) -> bool:
    """判断是否为 ChatGPT 登录凭据（JWT 形态）。"""
    tok = (token or "").strip()
    return tok.startswith("eyJ") and tok.count(".") == 2


def mask_token(token: str) -> str:
    """掩码显示 token。"""
    tok = (token or "").strip()
    if len(tok) <= 12:
        return tok
    return f"{tok[:6]}...{tok[-6:]}"


def _normalize_status(raw: str) -> str:
    return _STATUS_MAP.get((raw or "").strip(), "abnormal")


def _map_upstream_item(item: dict[str, Any]) -> dict[str, Any]:
    """把上游账号对象转成平台视图（保留 access_token 供删除/刷新定位）。"""
    token = str(item.get("access_token") or "")
    return {
        "id": str(item.get("id") or item.get("account_id") or token),
        "access_token": token,
        "token_masked": mask_token(token),
        "type": str(item.get("type") or item.get("plan_type") or "chatgpt"),
        "status": _normalize_status(str(item.get("status") or "")),
        "quota": int(item.get("quota") or 0),
        "last_refresh": str(item.get("last_refresh") or ""),
        "last_error": str(item.get("last_refresh_error") or ""),
        "email": item.get("email"),
        "source": "upstream",
    }


async def _upstream_request(
    method: str, path: str, *, json_body: dict[str, Any] | None = None
) -> dict[str, Any]:
    """调用上游账号接口；失败按统一错误码抛出（含「号池无可用账号」识别）。"""
    from app.services.error_mapper import classify_exception, classify_status

    base = _upstream_base()
    if not base:
        raise GatewayError(ErrorCode.UPSTREAM_ERROR, "未配置图片 provider 地址")
    try:
        async with provider_client(
            "image", base_url=base, read_timeout=_UPSTREAM_TIMEOUT
        ) as client:
            resp = await client.request(
                method, path, headers=_upstream_headers(), json=json_body
            )
    except Exception as exc:  # noqa: BLE001 - 统一映射为网关错误
        mapped = classify_exception(exc)
        logger.warning("上游号池接口 %s %s 调用失败：%s", method, path, mapped.message)
        raise mapped from exc

    if resp.status_code >= 400:
        mapped = classify_status(resp.status_code, resp.text)
        logger.warning(
            "上游号池接口 %s %s 返回 %s：%s", method, path, resp.status_code, mapped.message
        )
        raise mapped

    data = resp.json()
    return data if isinstance(data, dict) else {}


async def _try_upstream_request(
    method: str, path: str, *, json_body: dict[str, Any] | None = None
) -> dict[str, Any] | None:
    """宽松版：上游不可达时返回 None，由调用方决定是否降级。"""
    try:
        return await _upstream_request(method, path, json_body=json_body)
    except GatewayError:
        return None


async def _upstream_items() -> list[dict[str, Any]]:
    """拉取上游账号列表（已归一）；上游不可达时抛出网关错误。"""
    data = await _upstream_request("GET", "/api/accounts")
    raw = data.get("items") or []
    return [_map_upstream_item(item) for item in raw if isinstance(item, dict)]


async def list_accounts() -> dict[str, Any]:
    """账号列表：上游 ChatGPT 账号 + 本地通用 Key 合并去重。

    上游不可达时：若本地还有账号则只返回本地（页面仍可用）；
    若两边都空则如实报错，避免「什么都看不到也不知道为什么」。
    """
    local = await account_pool.list()
    try:
        upstream = await _upstream_items()
    except GatewayError as exc:
        if local:
            logger.warning("上游账号列表不可用，仅返回本地账号：%s", exc.message)
            return {"items": [{**item, "source": "local"} for item in local]}
        raise
    seen = {str(item.get("access_token") or "") for item in upstream}
    merged = list(upstream)
    for item in local:
        if str(item.get("access_token") or "") in seen:
            continue
        merged.append({**item, "source": "local"})
    return {"items": merged}


async def list_accounts_items() -> list[dict[str, Any]]:
    """内部复用：返回合并后的账号列表。"""
    return (await list_accounts())["items"]


async def _resolve_tokens(identifiers: list[str]) -> list[str]:
    """把前端传来的 id / 掩码 / token 统一解析为真实 access_token。

    前端表格用 `id` 作为选中值，而删除与刷新接口需要真实 token；
    这里按 id 反查，查不到的按原值透传（可能是直接粘贴的 token）。
    """
    ids = [str(t or "").strip() for t in identifiers if str(t or "").strip()]
    if not ids:
        return []
    items = await list_accounts_items()
    by_id = {str(item.get("id") or ""): str(item.get("access_token") or "") for item in items}
    resolved: list[str] = []
    for ident in ids:
        real = by_id.get(ident) or ident
        if real and real not in resolved:
            resolved.append(real)
    return resolved


async def import_accounts(tokens: list[str], accounts: list[dict]) -> dict[str, Any]:
    """导入账号：ChatGPT 凭据转发上游，其余存本地池。"""
    token_list = [str(t or "").strip() for t in tokens if str(t or "").strip()]
    extra_tokens = [
        str(a.get("access_token") or a.get("token") or "").strip()
        for a in accounts
        if isinstance(a, dict)
    ]
    extra_tokens = [t for t in extra_tokens if t]
    all_tokens = token_list + extra_tokens

    chatgpt_tokens = [t for t in all_tokens if is_chatgpt_token(t)]
    local_tokens = [t for t in all_tokens if not is_chatgpt_token(t)]
    local_accounts = [
        a
        for a in accounts
        if isinstance(a, dict)
        and not is_chatgpt_token(str(a.get("access_token") or a.get("token") or ""))
    ]

    added = skipped = refreshed = 0
    errors: list[str] = []
    items: list[dict[str, Any]] = []

    if chatgpt_tokens:
        try:
            result = await _upstream_request(
                "POST", "/api/accounts", json_body={"tokens": chatgpt_tokens}
            )
        except GatewayError as exc:
            result = None
            errors.append(f"ChatGPT 账号导入失败：{exc.message}")
        if result is not None:
            added += int(result.get("added") or 0)
            skipped += int(result.get("skipped") or 0)
            refreshed += int(result.get("refreshed") or 0)
            items.extend(
                _map_upstream_item(item)
                for item in (result.get("items") or [])
                if isinstance(item, dict)
            )
            for err in result.get("errors") or []:
                errors.append(str(err))

    if local_tokens or local_accounts:
        result = await account_pool.import_accounts(local_tokens, local_accounts)
        added += int(result.get("added") or 0)
        skipped += int(result.get("skipped") or 0)
        refreshed += int(result.get("refreshed") or 0)
        errors.extend(str(e) for e in (result.get("errors") or []))

    if not items:
        items = await list_accounts_items()
    return {
        "added": added,
        "skipped": skipped,
        "refreshed": refreshed,
        "errors": errors,
        "items": items,
    }


async def delete_accounts(tokens: list[str]) -> dict[str, Any]:
    """删除账号：按 token 形态分流到上游与本地。"""
    token_list = await _resolve_tokens(tokens)
    chatgpt_tokens = [t for t in token_list if is_chatgpt_token(t)]
    local_tokens = [t for t in token_list if not is_chatgpt_token(t)]

    removed = 0
    if chatgpt_tokens:
        try:
            result = await _upstream_request(
                "DELETE", "/api/accounts", json_body={"tokens": chatgpt_tokens}
            )
            removed += int(result.get("removed") or 0)
        except GatewayError as exc:
            raise GatewayError(
                ErrorCode.UPSTREAM_ERROR, f"删除 ChatGPT 账号失败：{exc.message}"
            ) from exc

    if local_tokens:
        result = await account_pool.delete(local_tokens)
        removed += int(result.get("removed") or 0)

    return {"removed": removed, "items": await list_accounts_items()}


async def refresh(tokens: list[str]) -> dict[str, Any]:
    """刷新额度：ChatGPT 账号走上游刷新（只有上游能查到真实额度）。"""
    token_list = await _resolve_tokens(tokens)
    chatgpt_tokens = [t for t in token_list if is_chatgpt_token(t)]

    if chatgpt_tokens or not token_list:
        # 未指定时刷新全部 ChatGPT 账号（上游支持空列表=全部）
        try:
            result = await _upstream_request(
                "POST",
                "/api/accounts/refresh",
                json_body={"access_tokens": chatgpt_tokens},
            )
        except GatewayError as exc:
            raise GatewayError(
                ErrorCode.UPSTREAM_ERROR,
                f"无法刷新 ChatGPT 账号额度：{exc.message}",
            ) from exc
        if result.get("progress_id"):
            job_id = str(result["progress_id"])
            _register_upstream_job(job_id)
            return {
                "job_id": job_id,
                "status": "running",
                "done": 0,
                "total": len(chatgpt_tokens),
                "action": "refresh",
            }
        return {
            "job_id": "upstream-sync",
            "status": "completed",
            "done": len(chatgpt_tokens),
            "total": len(chatgpt_tokens),
            "action": "refresh",
        }

    return await account_pool.start_job(action="refresh", tokens=token_list)


def _register_upstream_job(job_id: str) -> None:
    """登记上游任务 id（超出上限时丢弃最早的，避免无限增长）。"""
    _UPSTREAM_JOBS.add(job_id)
    while len(_UPSTREAM_JOBS) > _UPSTREAM_JOBS_MAX:
        _UPSTREAM_JOBS.pop()


async def refresh_progress(job_id: str) -> dict[str, Any]:
    """刷新进度：登记过的走上游，其余查本地池。"""
    if job_id == "upstream-sync":
        return {
            "job_id": job_id,
            "status": "completed",
            "done": 1,
            "total": 1,
            "action": "refresh",
        }
    if job_id in _UPSTREAM_JOBS:
        try:
            data = await _upstream_request(
                "GET", f"/api/accounts/refresh/progress/{job_id}"
            )
        except GatewayError:
            data = None
        if data is None:
            return {
                "job_id": job_id,
                "status": "failed",
                "done": 0,
                "total": 1,
                "action": "refresh",
            }
        total = int(data.get("total") or 0)
        done = int(data.get("done") or 0)
        return {
            "job_id": job_id,
            "status": "completed" if total and done >= total else "running",
            "done": done,
            "total": total,
            "action": "refresh",
        }
    return await account_pool.job(job_id)


async def relogin(tokens: list[str]) -> dict[str, Any]:
    """重新登录：ChatGPT 账号走上游重登，通用 Key 无此概念。"""
    token_list = await _resolve_tokens(tokens)
    chatgpt_tokens = [t for t in token_list if is_chatgpt_token(t)]
    if chatgpt_tokens:
        try:
            result = await _upstream_request(
                "POST", "/api/accounts/re-login", json_body={"access_tokens": chatgpt_tokens}
            )
        except GatewayError:
            result = {}
        if result.get("progress_id"):
            job_id = str(result["progress_id"])
            _register_upstream_job(job_id)
            return {
                "job_id": job_id,
                "status": "running",
                "done": 0,
                "total": len(chatgpt_tokens),
                "action": "relogin",
            }
    local_tokens = [t for t in token_list if not is_chatgpt_token(t)]
    return await account_pool.start_job(action="relogin", tokens=local_tokens)


async def relogin_progress(job_id: str) -> dict[str, Any]:
    """重登进度。"""
    return await refresh_progress(job_id)


async def update_account(payload: dict) -> dict[str, Any]:
    """更新账号（ChatGPT 账号的状态/额度由上游维护，这里只读转发）。"""
    token = str(payload.get("access_token") or payload.get("token") or "")
    if is_chatgpt_token(token):
        return {
            "ok": False,
            "message": "ChatGPT 账号的状态与额度由上游维护，请用「刷新额度」更新",
            "items": await list_accounts_items(),
        }
    return await account_pool.update(payload)


async def export_accounts(tokens: list[str], fmt: str) -> tuple[bytes, str, str]:
    """导出账号：合并上游 + 本地后导出为纯 token 文本。"""
    token_list = [str(t or "").strip() for t in tokens if str(t or "").strip()]
    items = await list_accounts_items()
    if token_list:
        wanted = set(token_list)
        items = [i for i in items if str(i.get("access_token") or "") in wanted]
    lines = "\n".join(str(i.get("access_token") or "") for i in items)
    return (
        lines.encode("utf-8"),
        "text/plain; charset=utf-8",
        'attachment; filename="accounts.txt"',
    )


async def oauth_start(email_hint: str) -> dict[str, Any]:
    """OAuth 起始：转发上游。"""
    data = await _try_upstream_request(
        "POST", "/api/accounts/oauth/start", json_body={"email_hint": email_hint or ""}
    )
    if data is None:
        return {
            "supported": False,
            "message": "上游不可达，无法发起 OAuth 登录",
            "email_hint": email_hint,
        }
    return {"supported": True, **data}


async def oauth_finish(session_id: str, callback: str) -> dict[str, Any]:
    """OAuth 完成：转发上游。"""
    data = await _try_upstream_request(
        "POST",
        "/api/accounts/oauth/finish",
        json_body={"session_id": session_id, "callback": callback},
    )
    if data is None:
        return {
            "supported": False,
            "message": "上游不可达，无法完成 OAuth 登录",
            "session_id": session_id,
        }
    return {"supported": True, **data}
