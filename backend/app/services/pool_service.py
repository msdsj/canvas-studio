"""MSDSJ 自有 provider 账号池服务。

账号凭据和调度由 gateway 持有，backend 只负责管理员权限、审计和对外
归一化，运行时不依赖任何外部账号管理项目。
"""
from __future__ import annotations

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import audit_service
from app.services.gateway_client import gateway_client
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.pool_service")

# 上游中文状态 → 平台归一状态
_STATUS_MAP = {
    "正常": "normal",
    "限流": "limited",
    "异常": "abnormal",
    "封禁": "disabled",
    "禁用": "disabled",
    "disabled": "disabled",
    "normal": "normal",
    "limited": "limited",
    "abnormal": "abnormal",
}


def mask_token(token: str) -> str:
    """对 access_token 做掩码。"""
    token = token or ""
    if len(token) <= 12:
        return token[:3] + "***"
    return f"{token[:6]}...{token[-6:]}"


def normalize_status(raw: str) -> str:
    """归一账号状态。"""
    return _STATUS_MAP.get((raw or "").strip(), "abnormal")


def normalize_item(item: dict[str, Any]) -> dict[str, Any]:
    """把上游账号对象归一为平台视图。"""
    token = str(item.get("access_token") or item.get("accessToken") or "")
    return {
        "id": str(item.get("id") or item.get("account_id") or token),
        "token_masked": mask_token(token),
        "type": str(item.get("type") or item.get("plan_type") or item.get("source_type") or ""),
        "status": normalize_status(str(item.get("status") or "")),
        "quota": int(item.get("quota") or 0),
        "last_refresh": str(
            item.get("last_refresh") or item.get("updated_at") or item.get("refresh_time") or ""
        ),
    }


async def _raw_accounts() -> list[dict[str, Any]]:
    """经网关拉取原始账号列表。"""
    data = await gateway_client.pool_list()
    if isinstance(data, dict):
        return list(data.get("items") or [])
    if isinstance(data, list):
        return list(data)
    return []


async def list_accounts(status: str | None = None, q: str | None = None) -> list[dict[str, Any]]:
    """列出归一化账号（支持状态/关键字过滤）。"""
    items = [normalize_item(i) for i in await _raw_accounts()]
    if status:
        items = [i for i in items if i["status"] == status]
    if q:
        items = [i for i in items if q.lower() in i["token_masked"].lower()]
    return items


async def stats() -> dict[str, int]:
    """账号健康统计与实际可独立路由容量（远端账号数不等于可路由数）。"""
    items = await list_accounts()
    result = {"total": len(items), "normal": 0, "limited": 0, "abnormal": 0, "disabled": 0}
    for item in items:
        key = item["status"] if item["status"] in result else "abnormal"
        result[key] += 1
    try:
        capacity = await gateway_client.pool_capacity()
    except AppError:
        # Compatibility with an older gateway: unknown capacity must not be
        # interpreted as proof that remote accounts can be routed separately.
        capacity = {}
    local_total = int(capacity.get("total") or 0)
    local_available = int(capacity.get("available") or 0)
    mode = str(capacity.get("routing_mode") or ("local" if local_total else "none"))
    result.update({
        # 本地独立路由（sk- 类 Key）的容量
        "routable": int(capacity.get("healthy") or 0),
        "routable_available": local_available,
        "routable_total": local_total,
        "routable_known": int(bool(capacity.get("independent_routing"))),
        # 上游号池（ChatGPT 凭据）与真正的可调度容量
        "routing_mode": mode,
        "upstream_total": int(capacity.get("upstream_total") or 0),
        "upstream_healthy": int(capacity.get("upstream_healthy") or 0),
        "effective_total": int(capacity.get("effective_total") or local_total),
        "effective_available": int(capacity.get("effective_available") or local_available),
    })
    return result


async def import_accounts(
    db: AsyncSession,
    method: str,
    tokens: list[str],
    accounts: list[dict[str, Any]],
    operator_id: str,
    operator_email: str,
) -> dict[str, Any]:
    """导入账号（五方式统一归一为 {tokens,accounts}）。"""
    norm_tokens, norm_accounts = _normalize_method(method, tokens, accounts)
    result = await gateway_client.pool_import(norm_tokens, norm_accounts)
    await audit_service.log(
        db,
        action="pool_import",
        actor_id=operator_id,
        actor_email=operator_email,
        target_type="pool",
        detail={"method": method, "tokens": len(norm_tokens), "accounts": len(norm_accounts), "result": result},
    )
    await db.commit()
    return result


def _normalize_method(
    method: str, tokens: list[str], accounts: list[dict[str, Any]]
) -> tuple[list[str], list[dict[str, Any]]]:
    """按导入方式归一输入。

    - token / session / codex_auth：均为纯 token 列表；
    - account_json：账号对象列表；
    - oauth：由 oauth 端点单独处理，这里透传 accounts。
    """
    clean_tokens = [t.strip() for t in tokens if t and t.strip()]
    clean_accounts = [a for a in accounts if isinstance(a, dict)]
    if method in {"token", "session", "codex_auth"}:
        return clean_tokens, []
    if method == "account_json":
        return clean_tokens, clean_accounts
    if method == "oauth":
        return clean_tokens, clean_accounts
    raise AppError(ErrorCode.VALIDATION_ERROR, "不支持的导入方式")


async def delete_accounts(
    db: AsyncSession, tokens: list[str], operator_id: str, operator_email: str
) -> dict[str, Any]:
    """删除账号。"""
    if not tokens:
        raise AppError(ErrorCode.VALIDATION_ERROR, "tokens 不能为空")
    result = await gateway_client.pool_delete(tokens)
    await audit_service.log(
        db,
        action="pool_delete",
        actor_id=operator_id,
        actor_email=operator_email,
        target_type="pool",
        detail={"tokens": len(tokens), "result": result},
    )
    await db.commit()
    return result


async def refresh(tokens: list[str] | None) -> str:
    """触发刷新，返回 job_id。"""
    data = await gateway_client.pool_refresh(tokens)
    job_id = str((data or {}).get("job_id") or (data or {}).get("progress_id") or "")
    if not job_id:
        raise AppError(ErrorCode.UPSTREAM_ERROR, "刷新任务创建失败")
    return job_id


async def refresh_progress(job_id: str) -> dict[str, Any]:
    """刷新进度。"""
    return await gateway_client.pool_refresh_progress(job_id)


async def relogin(tokens: list[str]) -> str:
    """触发重新登录，返回 job_id。"""
    data = await gateway_client.pool_relogin(tokens)
    job_id = str((data or {}).get("job_id") or (data or {}).get("progress_id") or "")
    if not job_id:
        raise AppError(ErrorCode.UPSTREAM_ERROR, "重登任务创建失败")
    return job_id


async def relogin_progress(job_id: str) -> dict[str, Any]:
    """重登进度。"""
    return await gateway_client.pool_relogin_progress(job_id)


async def update_account(
    db: AsyncSession, payload: dict[str, Any], operator_id: str, operator_email: str
) -> dict[str, Any]:
    """更新账号状态/额度/类型/代理。"""
    result = await gateway_client.pool_update(payload)
    await audit_service.log(
        db,
        action="pool_update",
        actor_id=operator_id,
        actor_email=operator_email,
        target_type="pool",
        target_id=mask_token(str(payload.get("access_token") or "")),
        detail={k: v for k, v in payload.items() if k != "access_token"},
    )
    await db.commit()
    return result


async def export(tokens: list[str], fmt: str):
    """导出账号（原始响应流）。"""
    return await gateway_client.pool_export(tokens, fmt)


async def oauth_start(email_hint: str) -> dict[str, Any]:
    """OAuth 起始。"""
    return await gateway_client.pool_oauth_start(email_hint)


async def oauth_finish(session_id: str, callback: str) -> dict[str, Any]:
    """OAuth 完成。"""
    return await gateway_client.pool_oauth_finish(session_id, callback)


async def auto_refresh_all() -> None:
    """定时任务：刷新全部账号额度。"""
    try:
        await gateway_client.pool_refresh(None)
        logger.info("号池自动刷新已触发")
    except AppError as exc:
        logger.warning("号池自动刷新失败: %s", exc.message)
