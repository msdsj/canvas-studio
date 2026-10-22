"""中转站调用层：所有 AI 语义能力（需求分析 / 提示词生成 / 润色 / 连通性测试）的唯一出口。

设计要点
--------
1. **用户配置优先，全局兜底**：先读用户激活的 `ai_providers`，没有再用
   `system_configs` 的 TEXT_* 全局配置；两者都没有 → ``configured=False``。
   调用方拿到「未配置」时必须**如实告诉用户**，不允许伪造 AI 结论。
2. **两种协议**：Claude 原生（`/v1/messages` + `x-api-key`）与 OpenAI 兼容
   （`/chat/completions` + `Bearer`）。DeepSeek / Codex / 各类中转站都走后者。
3. **不吞错误**：上游 4xx/5xx 的短原因会带回业务层（用户自己配的地址，
   他需要知道是 Key 错了还是模型名不对），但完整响应体只进日志。
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import socket
import time
from dataclasses import dataclass, field
from collections.abc import AsyncIterator
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import config_service
from app.services.relay_types import (
    BODY_HEAD_CHARS,
    MODEL_NAME_ERROR_HINTS,
    FailureKind,
    FailurePolicy,
    RelayCall,
    RelayOutcome,
    policy_for,
)
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.relay_service")

# 各家的默认地址与模型：只作为「新建表单的预填建议」，不写入任何配置
KIND_PRESETS: dict[str, dict[str, str]] = {
    "claude": {
        "label": "Claude",
        "base_url": "https://api.anthropic.com/v1",
        "model": "claude-sonnet-4-5",
        "protocol": "anthropic",
    },
    "codex": {
        "label": "Codex / OpenAI",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-5-codex",
        "protocol": "openai",
    },
    "deepseek": {
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "model": "deepseek-chat",
        "protocol": "openai",
    },
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "model": "gpt-4.1-mini",
        "protocol": "openai",
    },
    "compatible": {
        "label": "OpenAI 兼容中转站",
        "base_url": "",
        "model": "",
        "protocol": "openai",
    },
}

_READ_TIMEOUT = 90.0
_CONNECT_TIMEOUT = 12.0
# 单次响应上限：中转站返回一个 500MB 的 JSON 不能把后端内存打爆
_MAX_RESPONSE_BYTES = 2 * 1024 * 1024

# 绝不允许指向的地址：云元数据服务（SSRF 里最经典的凭据泄露点）
_BLOCKED_HOSTS = {
    "metadata.google.internal",
    "metadata",
    "169.254.169.254",
    "fd00:ec2::254",
    "100.100.100.200",  # 阿里云元数据
}
# 平台自身端口：允许接本地中转站，但不能把平台的 API 当成中转站来打
_SELF_PORTS = {27180, 27181, 27182}

# 允许透传给上游的额外参数白名单：防止用户把 messages/model 之外的
# 危险字段（如 tools 执行、自定义 header）塞进请求体
_ALLOWED_EXTRA_KEYS = {
    "top_p",
    "top_k",
    "seed",
    "stop",
    "presence_penalty",
    "frequency_penalty",
    "response_format",
    "reasoning_effort",
}


@dataclass
class RelayTarget:
    """一次调用实际使用的目标。"""

    source: str  # user | global
    name: str
    kind: str
    base_url: str
    api_key: str
    model: str
    temperature: float = 0.7
    max_tokens: int = 2048
    extra: dict[str, Any] = field(default_factory=dict)
    supports_vision: bool = False
    # 备用模型链（0–3 个有序模型名，见 ADR-3）。空列表 = 不启用 fallback。
    fallback_models: list[str] = field(default_factory=list)
    # 内部 id：仅用于日志与「跨 provider 互备时排除自己」，不进响应
    provider_id: str | None = None

    @property
    def protocol(self) -> str:
        """判定协议：Claude 原生地址走 messages，其余按 OpenAI 兼容。"""
        base = self.base_url.lower()
        if self.kind == "claude" or "anthropic" in base:
            return "anthropic"
        return "openai"

    @property
    def endpoint(self) -> str:
        """拼出最终请求地址（容忍用户填到裸域名、/v1、/v1/chat/completions）。"""
        base = (self.base_url or "").strip().rstrip("/")
        if not base:
            return ""
        path = urlsplit(base).path.rstrip("/")
        if path.endswith("/chat/completions") or path.endswith("/messages"):
            return base
        if self.protocol == "anthropic":
            # 用户常填 https://api.anthropic.com 或 .../v1
            return f"{base}/messages" if path.endswith("/v1") else f"{base}/v1/messages"
        if not path:
            # 裸域名：OpenAI 兼容服务几乎都在 /v1 下，补全后再拼路径
            return f"{base}/v1/chat/completions"
        return f"{base}/chat/completions"

    def to_public(self) -> dict[str, Any]:
        """给前端/日志的脱敏视图。"""
        return {
            "source": self.source,
            "name": self.name,
            "kind": self.kind,
            "base_url": self.base_url,
            "model": self.model,
            "supports_vision": self.supports_vision,
        }


def mask_key(value: str) -> str:
    """API Key 掩码：只露头 4 位与尾 4 位。"""
    if not value:
        return ""
    if len(value) <= 8:
        return "*" * len(value)
    return f"{value[:4]}{'*' * max(len(value) - 8, 4)}{value[-4:]}"


def safe_model_list(raw: Any) -> list[str]:
    """把任意来源的模型列表收敛成 `list[str]`。

    旧库补列后 `fallback_models` 可能是字符串 `'[]'`、`None`、或被脏数据写成了
    逗号串，读取处一律经过这里，避免在业务代码里到处写防御分支。
    """
    if raw is None:
        return []
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            return []
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            return [text]
        raw = parsed
    if not isinstance(raw, (list, tuple)):
        return []
    items: list[str] = []
    for item in raw:
        value = str(item).strip()
        if value:
            items.append(value)
    return items


async def _team_target(db: AsyncSession, user_id: str) -> tuple[RelayTarget | None, bool]:
    """团队层解析：返回 (团队中转站, 是否禁止使用个人配置)。

    解析链的第一环。团队上下文来自 `users.active_team_id`，且必须是有效成员，
    否则视为不在团队里（被移出的用户可以继续用自己的配置，不该被卡死）。

    `blocked_personal=True` 表示「团队已接管、且不允许成员自带配置」：
    此时**跳过**个人 provider —— 这正是需求里「全员用管理员配置的模型」的落点。
    如果团队配了 provider 但 base_url 是空的（半填状态），也按未配置处理，
    继续往下走，避免把用户挡住在一个填错的配置上。
    """
    from sqlalchemy import select

    from app.models.ai_provider import AIProvider
    from app.models.team import MEMBER_ACTIVE, Team, TeamMember
    from app.models.user import User

    team_id = (
        await db.execute(select(User.active_team_id).where(User.id == user_id))
    ).scalar_one_or_none()
    if not team_id:
        return None, False
    team = (
        await db.execute(
            select(Team).where(Team.id == team_id, Team.deleted_at.is_(None))
        )
    ).scalar_one_or_none()
    if team is None:
        return None, False
    member = (
        await db.execute(
            select(TeamMember.id).where(
                TeamMember.team_id == team.id,
                TeamMember.user_id == user_id,
                TeamMember.status == MEMBER_ACTIVE,
            )
        )
    ).scalar_one_or_none()
    if member is None:
        return None, False
    blocked_personal = not team.allow_personal_provider()

    row = (
        await db.execute(
            select(AIProvider)
            .where(
                AIProvider.scope == "team",
                AIProvider.team_id == team.id,
                AIProvider.is_active.is_(True),
            )
            .order_by(AIProvider.updated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if row is None or not (row.base_url or "").strip():
        return None, blocked_personal
    return (
        RelayTarget(
            source="team",
            name=row.name or f"{team.name} · 团队模型",
            kind=row.kind or "compatible",
            base_url=row.base_url.strip(),
            api_key=(row.api_key or "").strip(),
            model=(row.model or "").strip(),
            temperature=float(row.temperature if row.temperature is not None else 0.7),
            max_tokens=int(row.max_tokens or 2048),
            extra=dict(row.extra or {}),
            supports_vision=bool(row.supports_vision),
            fallback_models=safe_model_list(row.fallback_models),
            provider_id=row.id,
        ),
        blocked_personal,
    )


async def resolve(db: AsyncSession, user_id: str) -> RelayTarget | None:
    """解析当前用户可用的中转站；没有则返回 None（调用方必须处理「未配置」）。

    解析顺序（团队版）：
    1. **团队模型**：管理员统一配置，成员直接使用；
    2. **个人模型**：团队不允许自带配置时跳过；
    3. **平台公共**：`AI_RELAY_ALLOW_GLOBAL` 打开才生效。
    """
    from sqlalchemy import select

    from app.models.ai_provider import AIProvider

    team_target, blocked_personal = await _team_target(db, user_id)
    if team_target is not None:
        return team_target

    if not blocked_personal:
        row = (
            await db.execute(
                select(AIProvider)
                .where(
                    AIProvider.user_id == user_id,
                    AIProvider.is_active.is_(True),
                    # 团队配置可能由 owner 创建但 user_id 指向 owner：
                    # 这里按 scope 排除，避免 owner 的个人视图串到团队配置上
                    AIProvider.scope == "personal",
                )
                .order_by(AIProvider.updated_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if row is not None and (row.base_url or "").strip():
            return RelayTarget(
                source="user",
                name=row.name or KIND_PRESETS.get(row.kind, {}).get("label", "我的中转站"),
                kind=row.kind or "compatible",
                base_url=row.base_url.strip(),
                api_key=(row.api_key or "").strip(),
                model=(row.model or "").strip(),
                temperature=float(row.temperature if row.temperature is not None else 0.7),
                max_tokens=int(row.max_tokens or 2048),
                extra=dict(row.extra or {}),
                supports_vision=bool(row.supports_vision),
                # 代码侧防御：兼容 None / 空列表 / 脏数据（旧库补列后可能是字符串）
                fallback_models=safe_model_list(row.fallback_models),
                provider_id=row.id,
            )

    # 全局兜底：系统配置里的文本 provider（管理员配的公共中转）。
    # 默认关闭 —— 否则任何没配中转站的用户都能白嫖平台的模型调用。
    allow_global = bool(await config_service.get_value(db, "AI_RELAY_ALLOW_GLOBAL", False))
    if not allow_global:
        return None

    base_url = str(await config_service.get_raw(db, "TEXT_API_BASE_URL", "") or "").strip()
    api_key = str(await config_service.get_raw(db, "TEXT_API_KEY", "") or "").strip()
    model = str(await config_service.get_raw(db, "TEXT_MODEL", "") or "").strip()
    if base_url:
        return RelayTarget(
            source="global",
            name="平台公共中转站",
            kind="compatible",
            base_url=base_url,
            api_key=api_key,
            model=model or "gpt-4o-mini",
            supports_vision=False,
        )
    return None


async def resolve_conversation(db: AsyncSession, user_id: str) -> RelayTarget | None:
    """Use the platform model for enterprise conversations; preserve image routing."""
    from sqlalchemy import select

    from app.models.team import MEMBER_ACTIVE, TeamMember
    from app.models.user import User

    team_id = (
        await db.execute(select(User.active_team_id).where(User.id == user_id))
    ).scalar_one_or_none()
    if not team_id:
        return await resolve(db, user_id)
    member_id = (
        await db.execute(
            select(TeamMember.id).where(
                TeamMember.team_id == team_id,
                TeamMember.user_id == user_id,
                TeamMember.status == MEMBER_ACTIVE,
            )
        )
    ).scalar_one_or_none()
    if member_id is None:
        return await resolve(db, user_id)

    base_url = str(await config_service.get_raw(db, "TEXT_API_BASE_URL", "") or "").strip()
    api_key = str(await config_service.get_raw(db, "TEXT_API_KEY", "") or "").strip()
    model = str(await config_service.get_raw(db, "TEXT_MODEL", "") or "").strip()
    fallbacks = safe_model_list(await config_service.get_value(db, "TEXT_MODEL_FALLBACKS", []))
    if not base_url or not model:
        return None
    return RelayTarget(
        source="platform",
        name="平台对话模型",
        kind="compatible",
        base_url=base_url,
        api_key=api_key,
        model=model,
        fallback_models=fallbacks,
    )


def _auth_headers(target: RelayTarget) -> dict[str, str]:
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if target.protocol == "anthropic":
        headers["x-api-key"] = target.api_key
        headers["anthropic-version"] = "2023-06-01"
    elif target.api_key:
        headers["Authorization"] = f"Bearer {target.api_key}"
    return headers


async def guard_url(base_url: str, *, resolve_dns: bool = True) -> None:
    """校验用户填写的地址（SSRF 防护）。

    策略（针对自托管场景做过取舍）：

    - 只允许 http/https，且不允许地址里带账号密码；
    - **放行**回环与内网地址：自托管用户接 `http://127.0.0.1:8000/v1` 是合法用法；
    - **封禁**云元数据地址（169.254.169.254 / fd00:ec2::254 / 100.100.100.200 等）
      与链路本地、组播、保留地址；
    - **封禁**平台自身端口（27180/27181/27182）：否则用户可以借「测试连接」
      把平台 API 当成中转站来打，形成内网横向探测。
    """
    raw = (base_url or "").strip()
    if not raw:
        raise AppError(ErrorCode.VALIDATION_ERROR, "中转站地址是空的，先把网关地址填上")
    parts = urlsplit(raw)
    if parts.scheme.lower() not in {"http", "https"}:
        raise AppError(ErrorCode.VALIDATION_ERROR, "中转站地址要以 http:// 或 https:// 开头")
    if parts.username or parts.password:
        raise AppError(ErrorCode.VALIDATION_ERROR, "地址里不要带账号密码，Key 请填在 API Key 一栏")
    host = (parts.hostname or "").strip().lower()
    if not host:
        raise AppError(ErrorCode.VALIDATION_ERROR, "地址里没有域名")
    try:
        port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
    except ValueError as exc:
        raise AppError(ErrorCode.VALIDATION_ERROR, "端口写得不对") from exc
    if port in _SELF_PORTS:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个端口是平台自己，不能当作中转站")
    if host in _BLOCKED_HOSTS:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个地址不允许访问")

    def assert_ip_allowed(address: str) -> None:
        try:
            ip = ipaddress.ip_address(address.split("%")[0])
        except ValueError:
            return
        if ip.is_link_local or ip.is_multicast or ip.is_reserved or ip.is_unspecified:
            raise AppError(ErrorCode.VALIDATION_ERROR, "这个地址不允许访问")

    # 纯 IP 直接判定，省一次 DNS（本地中转站基本都是 127.0.0.1）
    try:
        assert_ip_allowed(str(ipaddress.ip_address(host)))
        return
    except ValueError:
        pass

    if not resolve_dns:
        # 保存配置时不做 DNS：用户可能在离线状态下先把配置填好
        return

    try:
        infos = await asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (socket.gaierror, UnicodeError) as exc:
        raise AppError(ErrorCode.VALIDATION_ERROR, "域名解析不了，检查一下地址") from exc
    for info in infos:
        assert_ip_allowed(str(info[4][0]))


def _split_system(messages: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    """Anthropic 协议要求 system 单独传，且 role 只能是 user/assistant。"""
    system_parts: list[str] = []
    rest: list[dict[str, Any]] = []
    for item in messages:
        if item.get("role") == "system":
            content = item.get("content")
            system_parts.append(content if isinstance(content, str) else json.dumps(content, ensure_ascii=False))
        else:
            rest.append({"role": item.get("role", "user"), "content": item.get("content", "")})
    return "\n\n".join(system_parts), rest


def _openai_body(target: RelayTarget, messages: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": overrides.get("model") or target.model,
        "messages": messages,
        "temperature": overrides.get("temperature", target.temperature),
        "max_tokens": overrides.get("max_tokens", target.max_tokens),
        "stream": False,
    }
    if overrides.get("json_mode"):
        body["response_format"] = {"type": "json_object"}
    # 用户自定义参数最后合并：只放行白名单键，避免把 tools/自定义 header 塞进请求体
    for key, value in (target.extra or {}).items():
        if key not in _ALLOWED_EXTRA_KEYS:
            continue
        body[key] = value
    return body


def _anthropic_body(target: RelayTarget, messages: list[dict[str, Any]], **overrides: Any) -> dict[str, Any]:
    system, rest = _split_system(messages)
    for message in rest:
        if not isinstance(message.get("content"), list):
            continue
        parts = []
        for part in message["content"]:
            if part.get("type") == "image_url":
                url = (part.get("image_url") or {}).get("url", "")
                if url.startswith("data:") and ";base64," in url:
                    header, data = url.split(";base64,", 1)
                    parts.append({"type": "image", "source": {"type": "base64", "media_type": header[5:], "data": data}})
                else:
                    parts.append({"type": "image", "source": {"type": "url", "url": url}})
            else:
                parts.append(part)
        message["content"] = parts
    body: dict[str, Any] = {
        "model": overrides.get("model") or target.model,
        "messages": rest,
        "max_tokens": overrides.get("max_tokens", target.max_tokens),
        "temperature": overrides.get("temperature", target.temperature),
    }
    if system:
        body["system"] = system
    for key, value in (target.extra or {}).items():
        if key not in _ALLOWED_EXTRA_KEYS:
            continue
        body[key] = value
    return body


def _extract_text(target: RelayTarget, payload: dict[str, Any]) -> str:
    """从两种协议的响应里取出文本。

    只读取公开content/text；私有reasoning/thinking永远不作为展示正文。
    """
    if target.protocol == "anthropic":
        blocks = payload.get("content")
        if isinstance(blocks, list):
            text = "".join(
                str(block.get("text") or "")
                for block in blocks
                if isinstance(block, dict) and block.get("type") == "text"
            ).strip()
            if text:
                return text
            return ""
        return ""
    try:
        choices = payload.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, list):
            # 少数中转站返回分段内容
            text = "".join(
                str(part.get("text") or "")
                for part in content
                if isinstance(part, dict) and part.get("type") in (None, "text", "output_text")
            ).strip()
            if text:
                return text
        elif content:
            return str(content).strip()
        return ""
    except (AttributeError, IndexError, TypeError):
        return ""


def _finish_reason(payload: dict[str, Any]) -> str:
    """取 finish_reason（判断「是不是被 max_tokens 截断」）。"""
    try:
        choices = payload.get("choices") or []
        if choices:
            return str(choices[0].get("finish_reason") or "")
    except (AttributeError, IndexError, TypeError):
        return ""
    return ""


def _short_reason(status: int, raw: bytes) -> str:
    """从错误响应里提炼一句人话（不暴露堆栈/HTML）。"""
    text = raw[:4000].decode("utf-8", "ignore")
    try:
        body = json.loads(text)
        if isinstance(body, dict):
            error = body.get("error")
            if isinstance(error, dict):
                message = str(error.get("message") or error.get("type") or "")
                if message:
                    return message[:160]
            message = str(body.get("message") or "")
            if message:
                return message[:160]
    except (ValueError, TypeError):
        pass
    snippet = text[:160].replace("\n", " ").strip()
    return snippet or f"HTTP {status}"


async def _post_capped(
    client: httpx.AsyncClient, target: RelayTarget, body: dict[str, Any]
) -> tuple[int, bytes]:
    """POST 并把响应体限制在上限内（防止超大响应打爆内存）。"""
    async with client.stream(
        "POST", target.endpoint, headers=_auth_headers(target), json=body
    ) as response:
        status = response.status_code
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > _MAX_RESPONSE_BYTES:
                raise AppError(ErrorCode.UPSTREAM_ERROR, "中转站返回的内容过大，检查一下地址是否填错")
            chunks.append(chunk)
        return status, b"".join(chunks)


# --------------------------------------------------------------------------- #
# 失败分类（ADR-2）：判定顺序固定，先到先判，不再往下走
# --------------------------------------------------------------------------- #
#: 「地址填错成网页」的典型开头：中转站把网关首页 200 返回时命中
_HTML_PREFIXES: tuple[str, ...] = ("<!doctype", "<html", "<?xml", "<head", "<body")


def _body_head(raw: bytes) -> str:
    """响应体前缀（仅日志用，永不进响应）。"""
    if not raw:
        return ""
    text = raw[: BODY_HEAD_CHARS * 2].decode("utf-8", "ignore")
    return text.replace("\n", " ").replace("\r", " ").strip()[:BODY_HEAD_CHARS]


def _looks_like_html(raw: bytes) -> bool:
    """响应体是不是一张网页（最常见的「地址填成了网站首页」）。"""
    if not raw:
        return False
    head = raw[:512].decode("utf-8", "ignore").lstrip().lower()
    return any(head.startswith(prefix) for prefix in _HTML_PREFIXES)


def _is_truncated_json(exc: Exception, raw: bytes) -> bool:
    """区分「被截断」与「压根不是 JSON」。

    双判据（ADR-2）：先看 `JSONDecodeError.msg` 的截断特征，再用「看起来像 JSON
    的开头 + 尾部没有闭合」兜底——CPython 升级改了文案也不会误判。
    """
    message = str(getattr(exc, "msg", "") or exc).lower()
    if "unterminated" in message:
        return True
    stripped = raw.strip()
    if not stripped:
        return False
    if stripped[:1] not in {b"{", b"["}:
        # 连 JSON 的开头都不是（纯文本 / 报错页），属于 not_json 而不是截断
        return False
    return stripped[-1:] not in {b"}", b"]"}


def _is_model_name_error(reason: str) -> bool:
    """4xx 的短原因里是否提到模型名（命中就值得换一个模型再试）。"""
    lowered = (reason or "").lower()
    return any(hint in lowered for hint in MODEL_NAME_ERROR_HINTS)


def _classify_failure(
    status: int | None, raw: bytes
) -> tuple[FailureKind, dict[str, Any] | None, str]:
    """按 ADR-2 的顺序分类。

    Returns:
        `(kind, payload, reason_hint)`。`payload` 仅在能解析成 dict 时非空，
        `reason_hint` 是上游的短原因（只用于判定与日志，不进响应）。
    """
    # 4–7) 先判状态码：4xx/5xx 的语义比响应体形态更确定
    if status is not None and status >= 400:
        if status in {401, 403}:
            # Key 错，换模型无意义
            return FailureKind.AUTH_ERROR, None, ""
        if status >= 500:
            return FailureKind.HTTP_5XX, None, _short_reason(status, raw)
        return FailureKind.HTTP_4XX, None, _short_reason(status, raw)

    # 8) 空体
    if not raw or not raw.strip():
        return FailureKind.EMPTY_BODY, None, ""

    # 9) 网页：必须在解析 JSON 之前判，否则会被误判成「模型没给正文」
    if _looks_like_html(raw):
        return FailureKind.HTML_BODY, None, ""

    # 10–11) JSON 解析失败：区分截断与非 JSON
    try:
        payload = json.loads(raw.decode("utf-8", "ignore"))
    except (ValueError, TypeError) as exc:
        if _is_truncated_json(exc, raw):
            return FailureKind.TRUNCATED_JSON, None, ""
        return FailureKind.NOT_JSON, None, ""

    # 12) 顶层不是对象
    if not isinstance(payload, dict):
        return FailureKind.NOT_OBJECT, None, ""

    # 13) 上游明确拒绝：200 但顶层只有 error
    if "error" in payload and not payload.get("choices") and not payload.get("content"):
        return FailureKind.UPSTREAM_REFUSED, payload, ""

    return FailureKind.OK, payload, ""


async def _chat_once(
    target: RelayTarget,
    messages: list[dict[str, Any]],
    *,
    json_mode: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> RelayCall:
    """对**一个**模型发一次请求，并把结果分类（不抛业务异常）。

    这是 L1 的唯一出口：`relay_chain` 只拿 `RelayCall.kind` / `.policy` 做决策，
    不再关心协议差异、SSRF 校验与响应体解析。
    """
    started = time.perf_counter()

    def elapsed_ms() -> int:
        return int((time.perf_counter() - started) * 1000)

    try:
        # 地址校验（SSRF）：只放行 http(s)，封元数据地址与平台自身端口
        await guard_url(target.base_url)
    except AppError as exc:
        logger.warning("中转站地址不合法 model=%s: %s", target.model, exc.message)
        return RelayCall(
            kind=FailureKind.BAD_URL,
            policy=policy_for(FailureKind.BAD_URL),
            body_head=str(exc.message)[:BODY_HEAD_CHARS],
            elapsed_ms=elapsed_ms(),
            sent=False,  # 发请求前就被拦下：不计入 HTTP 调用次数预算
        )
    except Exception:  # noqa: BLE001 - 解析 DNS 等意外错误一律按地址不合法处理
        logger.exception("中转站地址校验异常 model=%s", target.model)
        return RelayCall(
            kind=FailureKind.BAD_URL,
            policy=policy_for(FailureKind.BAD_URL),
            elapsed_ms=elapsed_ms(),
            sent=False,
        )

    overrides: dict[str, Any] = {"json_mode": json_mode}
    if temperature is not None:
        overrides["temperature"] = temperature
    if max_tokens is not None:
        overrides["max_tokens"] = max_tokens
    body = (
        _anthropic_body(target, messages, **overrides)
        if target.protocol == "anthropic"
        else _openai_body(target, messages, **overrides)
    )

    timeout = httpx.Timeout(
        connect=_CONNECT_TIMEOUT, read=_READ_TIMEOUT, write=_READ_TIMEOUT, pool=_CONNECT_TIMEOUT
    )
    status: int | None = None
    raw: bytes = b""
    try:
        # 不跟随重定向：否则用户配一个 302 就能把请求引到内网其它地址
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            status, raw = await _post_capped(client, target, body)
            # 部分中转站不支持 response_format：识别到这类报错就去掉重试一次，
            # 而不是让用户看到「HTTP 400」却不知道该改哪里
            if status >= 400 and json_mode and "response_format" in _short_reason(status, raw).lower():
                body.pop("response_format", None)
                status, raw = await _post_capped(client, target, body)
    except AppError as exc:
        # 响应体过大（_post_capped 抛的）：按「拿不到可用数据」处理，换模型有意义
        logger.warning("中转站响应体异常 model=%s: %s", target.model, exc.message)
        return RelayCall(
            kind=FailureKind.NOT_JSON,
            policy=policy_for(FailureKind.NOT_JSON),
            body_head=str(exc.message)[:BODY_HEAD_CHARS],
            elapsed_ms=elapsed_ms(),
        )
    except httpx.ConnectError:
        logger.warning("中转站连接失败 model=%s endpoint=%s", target.model, target.endpoint)
        return RelayCall(
            kind=FailureKind.CONNECT_ERROR,
            policy=policy_for(FailureKind.CONNECT_ERROR),
            elapsed_ms=elapsed_ms(),
        )
    except httpx.TimeoutException:
        logger.warning("中转站响应超时 model=%s endpoint=%s", target.model, target.endpoint)
        return RelayCall(
            kind=FailureKind.TIMEOUT,
            policy=policy_for(FailureKind.TIMEOUT),
            elapsed_ms=elapsed_ms(),
        )
    except Exception:  # noqa: BLE001 - 未知传输异常：当作连不上，终止整链
        logger.exception("中转站调用异常 model=%s", target.model)
        return RelayCall(
            kind=FailureKind.CONNECT_ERROR,
            policy=policy_for(FailureKind.CONNECT_ERROR),
            elapsed_ms=elapsed_ms(),
        )

    kind, payload, reason_hint = _classify_failure(status, raw)
    policy = policy_for(kind)
    if kind is FailureKind.HTTP_4XX and _is_model_name_error(reason_hint):
        # 模型名写错 / 模型不存在：换模型有意义（ADR-2 第 6 条）
        policy = FailurePolicy(fatal=False, retry_same_model=False, switch_model=True)

    content = ""
    if kind is FailureKind.OK and payload is not None:
        content = _extract_text(target, payload)
        if not content:
            kind = (
                FailureKind.TRUNCATED_OUTPUT
                if _finish_reason(payload) == "length"
                else FailureKind.NO_CONTENT
            )
            policy = policy_for(kind)

    head = "" if kind is FailureKind.OK else _body_head(raw)
    if kind is not FailureKind.OK:
        logger.warning(
            "上游失败 model=%s status=%s kind=%s reason=%s body_head=%s",
            target.model,
            status,
            kind.value,
            reason_hint,
            head,
        )
    return RelayCall(
        kind=kind,
        policy=policy,
        content=content,
        payload=payload,
        status=status,
        body_head=head,
        elapsed_ms=elapsed_ms(),
    )


async def chat(
    db: AsyncSession,
    user_id: str,
    messages: list[dict[str, Any]],
    *,
    json_mode: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
    target: RelayTarget | None = None,
) -> dict[str, Any]:
    """调用中转站，返回 ``{content, model, provider, source, elapsed_ms}``。

    **签名与返回结构完全不变**，内部委托 `chat_resilient()`——于是 `compose_service`
    与 `polish_service` 两个既有调用点零改动即获得「同模型重试 + 备用模型链」的韧性
    （ADR-1 方案 c：最小爆炸半径）。

    未配置 → 抛 ``AppError(VALIDATION_ERROR)`` 且文案直接引导去配置，
    调用方不得把这种情况当成「AI 说不知道」。
    """
    outcome = await chat_resilient(
        db,
        user_id,
        messages,
        json_mode=json_mode,
        temperature=temperature,
        max_tokens=max_tokens,
        target=target,
    )
    return {
        "content": outcome.content,
        "model": outcome.model,
        "provider": outcome.provider,
        "source": outcome.source,
        "elapsed_ms": outcome.elapsed_ms,
    }


async def chat_resilient(
    db: AsyncSession | None,
    user_id: str,
    messages: list[dict[str, Any]],
    *,
    json_mode: bool = False,
    temperature: float | None = None,
    max_tokens: int | None = None,
    target: RelayTarget | None = None,
    purpose: str = "generic",
) -> RelayOutcome:
    """带韧性的调用入口（链构造 + 三重预算 + 失败分类）。

    实现放在 `relay_chain`（职责分离），这里只做一层稳定的公共入口——`relay_chain`
    需要 `resolve` / `_chat_once` / `guard_url`，反向在模块顶层导入会形成循环，
    所以延迟到函数内导入。
    """
    from app.services import relay_chain  # 局部导入：避免 relay_chain ↔ relay_service 循环

    return await relay_chain.chat_resilient(
        db,
        user_id,
        messages,
        json_mode=json_mode,
        temperature=temperature,
        max_tokens=max_tokens,
        target=target,
        purpose=purpose,
    )



def _stream_delta(target: RelayTarget, obj: dict[str, Any]) -> str:
    """从一条流式事件里取出**正文**增量。

    思考型模型的 `reasoning_content` / Anthropic `thinking_delta` 一律跳过：
    那是模型的草稿，用户要看的是回答本身。
    """
    if target.protocol == "anthropic":
        if obj.get("type") != "content_block_delta":
            return ""
        delta = obj.get("delta") or {}
        if isinstance(delta, dict) and delta.get("type") == "text_delta":
            return str(delta.get("text") or "")
        return ""
    try:
        choices = obj.get("choices") or []
        if not choices:
            return ""
        delta = choices[0].get("delta") or {}
        content = delta.get("content")
        if isinstance(content, list):
            return "".join(str(part.get("text") or "") for part in content if isinstance(part, dict))
        return str(content or "")
    except (AttributeError, IndexError, TypeError):
        return ""


async def chat_stream(
    target: RelayTarget,
    messages: list[dict[str, Any]],
    *,
    temperature: float | None = None,
    max_tokens: int | None = None,
) -> AsyncIterator[str]:
    """流式调用中转站，逐段吐出**正文**文本。

    只给「面向用户的自然语言回复」用：它没有 JSON 契约、不需要纠错重试，
    要的是首字快。所以这里**不走** `chat_resilient` 的重试链——
    失败直接抛 `AppError`，由调用方回落到本地文案（回复不该因为润色失败而卡住整条链）。

    兼容两种情况：
    - 标准 SSE（`data: {...}` 行，OpenAI / Anthropic 两种协议）；
    - 中转站无视 `stream: true`、一次性回整包 JSON —— 也照样取出正文吐一次。
    """
    await guard_url(target.base_url)
    overrides: dict[str, Any] = {}
    if temperature is not None:
        overrides["temperature"] = temperature
    if max_tokens is not None:
        overrides["max_tokens"] = max_tokens
    if target.protocol == "anthropic":
        body = _anthropic_body(target, messages, **overrides)
    else:
        body = _openai_body(target, messages, **overrides)
    body["stream"] = True
    headers = {**_auth_headers(target), "Accept": "text/event-stream"}
    timeout = httpx.Timeout(
        connect=_CONNECT_TIMEOUT, read=_READ_TIMEOUT, write=_READ_TIMEOUT, pool=_CONNECT_TIMEOUT
    )

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        async with client.stream("POST", target.endpoint, headers=headers, json=body) as response:
            if response.status_code >= 400:
                raw = await response.aread()
                raise AppError(ErrorCode.UPSTREAM_ERROR, _short_reason(response.status_code, raw))

            content_type = (response.headers.get("content-type") or "").lower()
            if "event-stream" not in content_type:
                # 不支持流式的中转站：读完整包，按非流式协议取正文
                raw = await response.aread()
                if len(raw) > _MAX_RESPONSE_BYTES:
                    raise AppError(ErrorCode.UPSTREAM_ERROR, "中转站返回的内容过大")
                try:
                    payload = json.loads(raw.decode("utf-8", "ignore"))
                except ValueError as exc:
                    raise AppError(ErrorCode.UPSTREAM_FORMAT_ERROR, "中转站返回的不是可读的回复") from exc
                text = _extract_text(target, payload) if isinstance(payload, dict) else ""
                if text:
                    yield text
                return

            total = 0
            async for line in response.aiter_lines():
                total += len(line)
                if total > _MAX_RESPONSE_BYTES:
                    raise AppError(ErrorCode.UPSTREAM_ERROR, "中转站返回的内容过大")
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                try:
                    obj = json.loads(data)
                except ValueError:
                    continue
                if isinstance(obj, dict):
                    if obj.get("type") == "error" or (
                        target.protocol == "openai" and isinstance(obj.get("error"), dict)
                    ):
                        raise AppError(ErrorCode.UPSTREAM_ERROR, _short_reason(200, data.encode()))
                    delta = _stream_delta(target, obj)
                    if delta:
                        yield delta


async def test_target(target: RelayTarget) -> dict[str, Any]:
    """连通性测试：发一句极短的请求，验证地址 / Key / 模型名三件事。

    这里的 `max_tokens` 必须留够：思考型模型（deepseek-v4.x / o 系列）会先把
    token 花在 `reasoning_content` 上，16 个 token 会导致正文为空——
    那是「测得太省」，不是用户配置错了。
    """
    try:
        await guard_url(target.base_url)
    except AppError as exc:
        return {"ok": False, "message": exc.message, "elapsed_ms": 0}
    messages = [
        {"role": "system", "content": "你是连通性测试助手，只回复两个字：可用"},
        {"role": "user", "content": "ping"},
    ]
    started = time.perf_counter()
    body = (
        _anthropic_body(target, messages, max_tokens=256, temperature=0)
        if target.protocol == "anthropic"
        else _openai_body(target, messages, max_tokens=256, temperature=0)
    )
    timeout = httpx.Timeout(connect=_CONNECT_TIMEOUT, read=30.0, write=30.0, pool=_CONNECT_TIMEOUT)
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            status, raw = await _post_capped(client, target, body)
    except AppError as exc:
        return {
            "ok": False,
            "message": exc.message,
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }
    except httpx.ConnectError:
        return {
            "ok": False,
            "message": "连不上这个地址，检查一下网关地址是否完整（通常要带 /v1）",
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }
    except httpx.TimeoutException:
        return {
            "ok": False,
            "message": "请求超时，中转站没有在 30 秒内响应",
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }
    except Exception as exc:  # noqa: BLE001
        logger.exception("中转站测试异常")
        return {
            "ok": False,
            "message": f"测试失败：{exc.__class__.__name__}",
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }

    elapsed = int((time.perf_counter() - started) * 1000)
    if status >= 400:
        return {"ok": False, "message": _short_reason(status, raw), "elapsed_ms": elapsed}
    try:
        payload = json.loads(raw.decode("utf-8", "ignore"))
    except Exception:  # noqa: BLE001
        return {"ok": False, "message": "返回的不是 JSON，地址可能填成了网页", "elapsed_ms": elapsed}
    if not isinstance(payload, dict):
        return {"ok": False, "message": "返回格式不对，地址可能填成了网页", "elapsed_ms": elapsed}
    content = _extract_text(target, payload)
    if not content:
        # 走到这里说明地址、Key、模型都通了（HTTP 200 + 标准响应体），
        # 只是没有正文——多半是思考型模型把 token 花在了推理上，不该判成「配置错误」
        if not payload.get("choices") and not payload.get("content"):
            return {
                "ok": False,
                "message": "返回的不是标准对话响应，检查一下地址是否指向 /v1",
                "elapsed_ms": elapsed,
            }
        finish = _finish_reason(payload)
        note = "输出被 max_tokens 截断" if finish == "length" else "只输出了思考内容、没有正文"
        return {
            "ok": True,
            "message": f"连接正常 · {target.model or '默认模型'} · {note}（建议把最大 tokens 调到 512 以上）",
            "elapsed_ms": elapsed,
        }
    return {
        "ok": True,
        "message": f"连接正常 · {target.model or '默认模型'} · {content[:20]}",
        "elapsed_ms": elapsed,
    }


def build_target_from_draft(
    *,
    base_url: str,
    api_key: str,
    model: str,
    kind: str = "compatible",
    supports_vision: bool = False,
    name: str = "草稿",
    temperature: float = 0.7,
    max_tokens: int = 2048,
    extra: dict[str, Any] | None = None,
) -> RelayTarget:
    """用未保存的表单内容构造测试目标（「先测再存」）。"""
    return RelayTarget(
        source="user",
        name=name,
        kind=kind or "compatible",
        base_url=(base_url or "").strip(),
        api_key=(api_key or "").strip(),
        model=(model or "").strip(),
        temperature=temperature,
        max_tokens=max_tokens,
        extra=dict(extra or {}),
        supports_vision=supports_vision,
    )
