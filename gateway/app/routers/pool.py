"""号池代理路由 /gw/pool/accounts*。"""
from __future__ import annotations

import asyncio
import time

from fastapi import APIRouter
from fastapi.responses import Response

from app.schemas.common import ok
from app.schemas.pool import (
    OAuthFinishRequest,
    OAuthStartRequest,
    PoolDeleteRequest,
    PoolExportRequest,
    PoolImportRequest,
    PoolRefreshRequest,
    PoolUpdateRequest,
)
from app.services import pool_proxy
from app.services.account_pool import account_pool
from app.state import runtime_config

router = APIRouter(prefix="/gw/pool", tags=["gateway-pool"])

#: 上游账号数缓存：容量接口会被每次批量预检调用，不能每次都打上游（最坏 25s）。
#: 10 秒足够反映「刚导入 / 刚失效」，又不会让预检被上游延迟拖死。
_UPSTREAM_TTL = 10.0
_UPSTREAM_TIMEOUT = 2.5
_upstream_cache: dict[str, float] = {"at": 0.0, "total": 0.0, "healthy": 0.0}


async def _upstream_counts() -> tuple[int, int]:
    """返回 (total, healthy)；失败时退回上一次缓存（没有则 0）。"""
    now = time.time()
    if _upstream_cache["at"] and now - _upstream_cache["at"] < _UPSTREAM_TTL:
        return int(_upstream_cache["total"]), int(_upstream_cache["healthy"])
    try:
        data = await asyncio.wait_for(pool_proxy.list_accounts(), timeout=_UPSTREAM_TIMEOUT)
        items = [
            item
            for item in (data.get("items") or [])
            if str(item.get("source") or "") == "upstream"
        ]
        total = len(items)
        healthy = sum(1 for item in items if str(item.get("status") or "") == "normal")
        _upstream_cache.update({"at": now, "total": float(total), "healthy": float(healthy)})
        return total, healthy
    except Exception:  # noqa: BLE001 - 容量是展示/预检用，不能因此报错
        return int(_upstream_cache["total"]), int(_upstream_cache["healthy"])


@router.get("/capacity")
async def image_capacity() -> dict:
    """容量：本地独立路由优先，没有本地账号时如实反映上游号池。

    背景：平台有两类账号——
    * `sk-...` 通用 Key → 存本地池（`account_pool`），可按账号独立路由；
    * `eyJ...` ChatGPT 登录凭据 → 存在上游 chatgpt2api，由它自己调度。

    用户导入的多半是第二类。以前这里只报本地池（0/0），批量预检据此判定
    「没有可路由账号」，把「拆成 2 张」直接拒掉——账号明明在，却出不了多图。

    现在额外给出 `routing_mode` 与 `effective_*`：本地有号就用本地，
    本地为空且配了图片上游就用上游号池的账号数，两边都没有才是 `none`。
    """
    capacity = await account_pool.image_capacity()
    capacity["configured_provider_available"] = bool(runtime_config.image_base_url)

    upstream_total = 0
    upstream_healthy = 0
    if int(capacity.get("total") or 0) == 0 and runtime_config.image_base_url:
        upstream_total, upstream_healthy = await _upstream_counts()

    local_total = int(capacity.get("total") or 0)
    local_available = int(capacity.get("available") or 0)
    capacity["upstream_total"] = upstream_total
    capacity["upstream_healthy"] = upstream_healthy
    capacity["routing_mode"] = (
        "local" if local_total else ("upstream" if upstream_healthy else "none")
    )
    capacity["effective_total"] = local_total or upstream_total
    capacity["effective_available"] = local_available if local_total else upstream_healthy
    return ok(capacity)


@router.get("/accounts")
async def list_accounts() -> dict:
    """代理 GET /api/accounts。"""
    return ok(await pool_proxy.list_accounts())


@router.post("/accounts")
async def import_accounts(payload: PoolImportRequest) -> dict:
    """代理导入。"""
    return ok(await pool_proxy.import_accounts(payload.tokens, payload.accounts))


@router.delete("/accounts")
async def delete_accounts(payload: PoolDeleteRequest) -> dict:
    """代理删除。"""
    return ok(await pool_proxy.delete_accounts(payload.tokens))


@router.post("/accounts/refresh")
async def refresh_accounts(payload: PoolRefreshRequest) -> dict:
    """代理刷新 → {job_id}。"""
    return ok(await pool_proxy.refresh(payload.tokens))


@router.get("/accounts/refresh/{job_id}")
async def refresh_progress(job_id: str) -> dict:
    """代理刷新进度。"""
    return ok(await pool_proxy.refresh_progress(job_id))


@router.post("/accounts/re-login")
async def relogin_accounts(payload: PoolRefreshRequest) -> dict:
    """代理重登 → {job_id}。"""
    return ok(await pool_proxy.relogin(payload.tokens))


@router.get("/accounts/re-login/{job_id}")
async def relogin_progress(job_id: str) -> dict:
    """代理重登进度。"""
    return ok(await pool_proxy.relogin_progress(job_id))


@router.post("/accounts/update")
async def update_account(payload: PoolUpdateRequest) -> dict:
    """代理更新账号。"""
    return ok(await pool_proxy.update_account(payload.model_dump()))


@router.post("/accounts/export")
async def export_accounts(payload: PoolExportRequest) -> Response:
    """代理导出（文件流）。"""
    content, media_type, disposition = await pool_proxy.export_accounts(
        payload.tokens, payload.format
    )
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": disposition},
    )


@router.post("/accounts/oauth/start")
async def oauth_start(payload: OAuthStartRequest) -> dict:
    """代理 OAuth 起始。"""
    return ok(await pool_proxy.oauth_start(payload.email_hint))


@router.post("/accounts/oauth/finish")
async def oauth_finish(payload: OAuthFinishRequest) -> dict:
    """代理 OAuth 完成。"""
    return ok(await pool_proxy.oauth_finish(payload.session_id, payload.callback))
