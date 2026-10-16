"""httpx 客户端工厂：代理、connect/read 超时分离、鉴权头与上游探测。"""
from __future__ import annotations

import time
from typing import Any

import httpx

from app.config import settings
from app.state import runtime_config
from app.utils.errors import ErrorCode


def make_client(base_url: str, *, read_timeout: float | None = None) -> httpx.AsyncClient:
    """按运行时配置创建 httpx 客户端（含代理与超时分离）。"""
    timeout = httpx.Timeout(
        connect=settings.connect_timeout,
        read=read_timeout if read_timeout is not None else settings.read_timeout,
        write=settings.read_timeout,
        pool=settings.connect_timeout,
    )
    proxy = runtime_config.proxy_url or None
    return httpx.AsyncClient(
        base_url=base_url.rstrip("/"),
        timeout=timeout,
        proxy=proxy,
        trust_env=False,
    )


def sub2api_client(*, read_timeout: float | None = None) -> httpx.AsyncClient:
    """sub2api 对话客户端。"""
    return make_client(runtime_config.sub2api_base_url, read_timeout=read_timeout)


def chatgpt2api_client(*, read_timeout: float | None = None) -> httpx.AsyncClient:
    """chatgpt2api 生图/号池客户端。"""
    return make_client(runtime_config.chatgpt2api_base_url, read_timeout=read_timeout)


def sub2api_headers() -> dict[str, str]:
    """sub2api 鉴权头（Bearer sk-）。"""
    return {"Authorization": f"Bearer {runtime_config.sub2api_api_key}"}


def chatgpt2api_headers() -> dict[str, str]:
    """chatgpt2api 管理鉴权头。"""
    return {"Authorization": f"Bearer {runtime_config.chatgpt2api_admin_key}"}


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
