"""httpx 客户端工厂：代理、connect/read 超时分离、鉴权头与上游探测。"""
from __future__ import annotations

import time
from typing import Any

import httpx

from app.config import settings
from app.state import runtime_config
from app.utils.errors import ErrorCode


def _is_loopback(base_url: str) -> bool:
    """判断「访问自己」的地址：这类调用永不走代理。

    除了 localhost/127.0.0.1，还必须覆盖**本机自建服务对外暴露的域名**——
    例如中转站挂在 gpt.msdsj.site，但它其实就跑在同一台机器上。
    如果这类地址走了 VPN 代理，请求会「出国再回国」，轻则慢十倍，
    重则被链路直接掐断（实测 httpx.ConnectError / PROXY_UNREACHABLE）。

    注意：这里只影响「平台 → 自己家服务」的调用，真正的境外上游
    （api.openai.com 等）仍然照常走代理。
    """
    try:
        from urllib.parse import urlparse

        host = (urlparse(base_url).hostname or "").lower()
        if not host:
            return False
        if host in {"localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal"}:
            return True
        # 自有域名：跑在同一台服务器上，直连即可
        if host.endswith(".msdsj.site") or host.endswith(".cheatai.site"):
            return True
        # 内网/容器网段
        if host.startswith(("10.", "192.168.", "172.16.", "172.17.", "172.18.", "172.19.")):
            return True
        return False
    except Exception:  # noqa: BLE001
        return False


def make_client(base_url: str, *, read_timeout: float | None = None) -> httpx.AsyncClient:
    """按运行时配置创建 httpx 客户端（含代理与超时分离）。"""
    timeout = httpx.Timeout(
        connect=settings.connect_timeout,
        read=read_timeout if read_timeout is not None else settings.read_timeout,
        write=settings.read_timeout,
        pool=settings.connect_timeout,
    )
    # 代理仅用于"出外网"的调用；本地回环 provider 直连，避免代理劫持回环请求。
    proxy = None if _is_loopback(base_url) else (runtime_config.proxy_url or None)
    return httpx.AsyncClient(
        base_url=base_url.rstrip("/"),
        timeout=timeout,
        proxy=proxy,
        trust_env=False,
    )


def provider_client(
    role: str,
    *,
    base_url: str | None = None,
    read_timeout: float | None = None,
) -> httpx.AsyncClient:
    """Create a client for a configured OpenAI-compatible provider role."""
    if base_url is None:
        base_url = {
            "text": runtime_config.text_base_url,
            "llm": runtime_config.llm_base_url or runtime_config.text_base_url,
            "image": runtime_config.image_base_url,
        }.get(role, "")
    return make_client(base_url, read_timeout=read_timeout)


def provider_headers(role: str, api_key: str | None = None) -> dict[str, str]:
    """Return Bearer authentication for a provider role or selected pool key."""
    if api_key is None:
        api_key = {
            "text": runtime_config.text_api_key,
            "llm": runtime_config.llm_api_key or runtime_config.text_api_key,
            "image": runtime_config.image_api_key,
        }.get(role, "")
    return {"Authorization": f"Bearer {api_key}"} if api_key else {}


def llm_client(*, read_timeout: float | None = None) -> httpx.AsyncClient:
    """Independent intent model client, falling back to the text provider."""
    return provider_client("llm", read_timeout=read_timeout)


def llm_headers() -> dict[str, str]:
    return provider_headers("llm")


async def probe(
    base_url: str,
    path: str,
    headers: dict[str, str] | None = None,
    *,
    read_timeout: float = 6.0,
) -> dict[str, Any]:
    """探测上游：区分 PROXY_UNREACHABLE 与 UPSTREAM_ERROR。"""
    start = time.perf_counter()
    client = make_client(base_url, read_timeout=read_timeout)
    try:
        async with client:
            resp = await client.get(path, headers=headers or {})
        latency = int((time.perf_counter() - start) * 1000)
        if resp.status_code < 500:
            return {"ok": True, "latency_ms": latency, "status": resp.status_code, "error_code": None, "message": "连通"}
        return {
            "ok": False,
            "latency_ms": latency,
            "status": resp.status_code,
            "error_code": ErrorCode.UPSTREAM_ERROR.value,
            "message": f"上游返回 {resp.status_code}",
        }
    except httpx.ConnectError as exc:
        return {
            "ok": False,
            "latency_ms": int((time.perf_counter() - start) * 1000),
            "status": 0,
            "error_code": ErrorCode.PROXY_UNREACHABLE.value,
            "message": f"无法连接上游（网络/代理不可达）：{exc}",
        }
    except httpx.TimeoutException as exc:
        return {
            "ok": False,
            "latency_ms": int((time.perf_counter() - start) * 1000),
            "status": 0,
            "error_code": ErrorCode.UPSTREAM_ERROR.value,
            "message": f"上游探测超时：{exc}",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "ok": False,
            "latency_ms": int((time.perf_counter() - start) * 1000),
            "status": 0,
            "error_code": ErrorCode.UPSTREAM_ERROR.value,
            "message": str(exc),
        }
