"""网关健康检查：/gw/health 与 /gw/upstream/health（区分 VPN / 上游故障）。"""
from __future__ import annotations

from fastapi import APIRouter

from app.config import settings
from app.schemas.common import ok
from app.state import runtime_config
from app.upstream import (
    chatgpt2api_headers,
    probe,
    sub2api_headers,
)

router = APIRouter(prefix="/gw", tags=["gateway-health"])


@router.get("/health")
async def health() -> dict:
    """网关存活 + 当前 demo_mode。"""
    return ok({"status": "ok", "version": settings.app_version, "demo_mode": runtime_config.demo_mode})


@router.get("/upstream/health")
async def upstream_health() -> dict:
    """探测 sub2api / chatgpt2api，区分 PROXY_UNREACHABLE 与 UPSTREAM_ERROR。"""
    sub2api = await probe(runtime_config.sub2api_base_url, "/v1/models", sub2api_headers())
    chatgpt2api = await probe(runtime_config.chatgpt2api_base_url, "/health", chatgpt2api_headers())
    overall_ok = bool(sub2api["ok"] or chatgpt2api["ok"])
    return ok(
        {
            "ok": overall_ok,
            "demo_mode": runtime_config.demo_mode,
            "sub2api": sub2api,
            "chatgpt2api": chatgpt2api,
        }
    )
