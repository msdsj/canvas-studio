"""运行时配置接收 / 连通性测试路由 /gw/config*。"""
from __future__ import annotations

from fastapi import APIRouter

from app.schemas.common import ok
from app.schemas.pool import ConfigPushRequest, ConfigTestRequest
from app.state import runtime_config
from app.services.account_pool import account_pool
from app.upstream import llm_headers, probe, provider_headers
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
    if target == "text":
        if not runtime_config.text_base_url:
            return ok({"ok": False, "latency_ms": 0, "message": "尚未配置文本 provider", "error_code": "NOT_CONFIGURED"})
        result = await probe(runtime_config.text_base_url, "/models", provider_headers("text"))
    elif target == "image":
        if not runtime_config.image_base_url and not await account_pool.list():
            return ok({"ok": False, "latency_ms": 0, "message": "尚未配置图片 provider 或账号池", "error_code": "NOT_CONFIGURED"})
        result = await probe(runtime_config.image_base_url, "/models", provider_headers("image")) if runtime_config.image_base_url else {"ok": True, "latency_ms": 0, "message": "已配置本地图片账号池", "error_code": None}
    elif target == "llm":
        if not (runtime_config.llm_base_url or runtime_config.text_base_url):
            return ok(
                {
                    "ok": False,
                    "latency_ms": 0,
                    "message": "尚未配置意图模型或文本 provider",
                    "error_code": "NOT_CONFIGURED",
                }
            )
        result = await probe(runtime_config.llm_base_url or runtime_config.text_base_url, "/models", llm_headers())
    elif target == "proxy":
        if not runtime_config.proxy_url:
            return ok({"ok": True, "latency_ms": 0, "message": "未配置代理，当前为直连"})
        target_url = runtime_config.text_base_url or runtime_config.image_base_url
        result = await probe(target_url, "/models", provider_headers("text")) if target_url else {"ok": False, "latency_ms": 0, "message": "未配置 provider", "error_code": "NOT_CONFIGURED"}
    elif target == "pool":
        count = len(await account_pool.list())
        result = {"ok": count > 0, "latency_ms": 0, "message": f"本地账号池已加载 {count} 个凭据", "error_code": None if count > 0 else "NOT_CONFIGURED"}
    else:
        raise GatewayError(ErrorCode.VALIDATION_ERROR, "target 必须是 text|image|llm|pool|proxy")
    return ok(
        {
            "ok": result["ok"],
            "latency_ms": result["latency_ms"],
            "message": result["message"],
            "error_code": result.get("error_code"),
        }
    )
