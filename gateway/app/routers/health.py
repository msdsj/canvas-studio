"""网关健康检查：/gw/health 与 /gw/upstream/health（区分 VPN / 上游故障）。"""
from __future__ import annotations

from fastapi import APIRouter

from app.config import settings
from app.schemas.common import ok
from app.state import runtime_config
from app.services import pool_proxy
from app.upstream import probe, provider_headers

router = APIRouter(prefix="/gw", tags=["gateway-health"])


async def _pool_count() -> int:
    """号池账号数（上游 ChatGPT 账号 + 本地通用 Key）。

    只数本地 `account_pool` 会漏掉转发到上游的 ChatGPT 账号，导致健康检查里
    明明有号却显示 0。这里以 `pool_proxy` 的合并列表为准。
    """
    try:
        return len(await pool_proxy.list_accounts_items())
    except Exception:  # noqa: BLE001 - 上游不可达时退回本地池计数
        from app.services.account_pool import account_pool

        return len(await account_pool.list())


@router.get("/health")
async def health() -> dict:
    """网关存活 + 当前 demo_mode。"""
    return ok({"status": "ok", "version": settings.app_version, "demo_mode": runtime_config.demo_mode})


@router.get("/upstream/health")
async def upstream_health() -> dict:
    """探测配置的文本/图片 provider，区分网络与上游故障。"""
    if runtime_config.text_base_url:
        text = await probe(runtime_config.text_base_url, "/models", provider_headers("text"))
    else:
        text = {"ok": False, "error_code": "NOT_CONFIGURED", "message": "未配置文本 provider", "latency_ms": 0}

    pool_count = await _pool_count()
    if runtime_config.image_base_url:
        image = await probe(runtime_config.image_base_url, "/models", provider_headers("image"))
    elif pool_count:
        image = {"ok": True, "error_code": None, "message": "使用本地图片账号池", "latency_ms": 0}
    else:
        image = {"ok": False, "error_code": "NOT_CONFIGURED", "message": "未配置图片 provider", "latency_ms": 0}

    overall_ok = bool(text["ok"] or image["ok"] or runtime_config.demo_mode != "off")
    return ok(
        {
            "ok": overall_ok,
            "demo_mode": runtime_config.demo_mode,
            "text": text,
            "image": image,
            "pool_accounts": pool_count,
        }
    )
