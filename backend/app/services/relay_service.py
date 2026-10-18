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
from typing import Any
from urllib.parse import urlsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.services import config_service
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


async def resolve(db: AsyncSession, user_id: str) -> RelayTarget | None:
    """解析当前用户可用的中转站；没有则返回 None（调用方必须处理「未配置」）。"""
    from sqlalchemy import select

    from app.models.ai_provider import AIProvider

    row = (
        await db.execute(
            select(AIProvider)
            .where(AIProvider.user_id == user_id, AIProvider.is_active.is_(True))
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

    **思考型模型**（deepseek-v4.x / o 系列等）会把过程放在 `reasoning_content`，
    `content` 可能为空——尤其是 max_tokens 被思考过程吃光时。这里把思考内容作为
    兜底：至少能拿到「模型确实在工作」的证据，而不是误判成「模型名不支持」。
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
            thinking = "".join(
                str(block.get("thinking") or "")
                for block in blocks
                if isinstance(block, dict) and block.get("type") == "thinking"
            ).strip()
            return thinking
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
                if isinstance(part, dict)
            ).strip()
            if text:
                return text
        elif content:
            return str(content).strip()
        # 正文为空：退回思考内容（deepseek 系与部分中转站会放在这里）
        for key in ("reasoning_content", "reasoning"):
            value = message.get(key)
            if isinstance(value, str) and value.strip():
                return value.strip()
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

    未配置 → 抛 ``AppError(VALIDATION_ERROR)`` 且文案直接引导去配置，
    调用方不得把这种情况当成「AI 说不知道」。
    """
    resolved = target or await resolve(db, user_id)
    if resolved is None:
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            "还没有配置 AI 中转站，先在左侧「中转站」里填好地址、Key 和模型",
        )
    # 地址校验（SSRF）：只放行 http(s)，封元数据地址与平台自身端口
    await guard_url(resolved.base_url)

    overrides: dict[str, Any] = {"json_mode": json_mode}
    if temperature is not None:
        overrides["temperature"] = temperature
    if max_tokens is not None:
        overrides["max_tokens"] = max_tokens
    body = (
        _anthropic_body(resolved, messages, **overrides)
        if resolved.protocol == "anthropic"
        else _openai_body(resolved, messages, **overrides)
    )

    started = time.perf_counter()
    timeout = httpx.Timeout(connect=_CONNECT_TIMEOUT, read=_READ_TIMEOUT, write=_READ_TIMEOUT, pool=_CONNECT_TIMEOUT)
    try:
        # 不跟随重定向：否则用户配一个 302 就能把请求引到内网其它地址
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            status, raw = await _post_capped(client, resolved, body)
            # 部分中转站不支持 response_format：识别到这类报错就去掉重试一次，
            # 而不是让用户看到「HTTP 400」却不知道该改哪里
            if status >= 400 and json_mode and "response_format" in _short_reason(status, raw).lower():
                body.pop("response_format", None)
                status, raw = await _post_capped(client, resolved, body)
    except AppError:
        raise
    except httpx.ConnectError as exc:
        logger.warning("中转站连接失败 %s: %s", resolved.endpoint, exc)
        raise AppError(ErrorCode.PROXY_UNREACHABLE, "连不上这个中转站，检查一下地址和网络") from exc
    except httpx.TimeoutException as exc:
        raise AppError(ErrorCode.UPSTREAM_ERROR, "中转站响应超时了，稍后再试一次") from exc
    except Exception as exc:  # noqa: BLE001
        logger.exception("中转站调用异常")
        raise AppError(ErrorCode.UPSTREAM_ERROR, "这次没能连上中转站") from exc

    if status >= 400:
        reason = _short_reason(status, raw)
        logger.warning(
            "中转站返回错误 status=%s model=%s body=%s",
            status,
            resolved.model,
            raw[:500].decode("utf-8", "ignore"),
        )
        raise AppError(
            ErrorCode.UPSTREAM_ERROR,
            f"中转站没有正常返回（HTTP {status}）：{reason}",
        )

    try:
        payload = json.loads(raw.decode("utf-8", "ignore"))
    except Exception as exc:  # noqa: BLE001
        raise AppError(ErrorCode.UPSTREAM_ERROR, "中转站返回的不是标准 JSON，检查一下地址是否填成了网页") from exc
    if not isinstance(payload, dict):
        raise AppError(ErrorCode.UPSTREAM_ERROR, "中转站返回的格式不对，检查一下地址是否填成了网页")

    content = _extract_text(resolved, payload)
    if not content:
        finish = _finish_reason(payload)
        if finish == "length":
            raise AppError(
                ErrorCode.UPSTREAM_ERROR,
                f"模型输出被截断（最大 tokens={resolved.max_tokens}），把它调大再试",
            )
        raise AppError(
            ErrorCode.UPSTREAM_ERROR,
            "模型这次只输出了思考过程、没有正文：把「最大输出 tokens」调到 512 以上再试",
        )

    return {
        "content": content,
        "model": resolved.model,
        "provider": resolved.name,
        "source": resolved.source,
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
    }


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
