"""运行时配置接收 / 连通性测试路由 /gw/config*。"""
from __future__ import annotations

from fastapi import APIRouter

from app.schemas.common import ok
from app.schemas.pool import ConfigPushRequest, ConfigTestRequest
from app.state import runtime_config
from app.upstream import (
    chatgpt2api_headers,
    probe,
    sub2api_headers,
)
from app.utils.errors import ErrorCode, GatewayError

router = APIRouter(prefix="/gw/config", tags=["gateway-config"])


@router.post("")
async def push_config(payload: ConfigPushRequest) -> dict:
    """接收 backend 推送的运行时配置（内存缓存即生效）。"""
    runtime_config.update(payload.model_dump(exclude_none=True))
    return ok({"ok": True, "config": runtime_config.snapshot()})


@router.post("/test")
async def test_config(payload: ConfigTestRequest) -> dict:
    """连通性测试：区分 proxy / upstream 故障。"""
    target = payload.target
    if target == "sub2api":
        result = await probe(runtime_config.sub2api_base_url, "/v1/models", sub2api_headers())
    elif target == "chatgpt2api":
        result = await probe(
            runtime_config.chatgpt2api_base_url, "/health", chatgpt2api_headers()
        )
    elif target == "proxy":
        if not runtime_config.proxy_url:
            return ok({"ok": True, "latency_ms": 0, "message": "未配置代理，当前为直连"})
        result = await probe(runtime_config.sub2api_base_url, "/v1/models", sub2api_headers())
    else:
        raise GatewayError(ErrorCode.VALIDATION_ERROR, "target 必须是 sub2api|chatgpt2api|proxy")
    return ok(
        {
            "ok": result["ok"],
            "latency_ms": result["latency_ms"],
            "message": result["message"],
            "error_code": result.get("error_code"),
        }
    )
