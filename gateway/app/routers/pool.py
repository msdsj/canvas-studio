"""号池代理路由 /gw/pool/accounts*。"""
from __future__ import annotations

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

router = APIRouter(prefix="/gw/pool", tags=["gateway-pool"])


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
