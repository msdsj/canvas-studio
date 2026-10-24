"""后台号池管理路由（经网关代理）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.models.user import User
from app.schemas.admin import (
    OAuthFinishRequest,
    OAuthStartRequest,
    PoolDeleteRequest,
    PoolExportRequest,
    PoolImportRequest,
    PoolJobRequest,
    PoolUpdateRequest,
)
from app.services import pool_service
from app.utils.errors import envelope

router = APIRouter(
    prefix="/api/admin/pool", tags=["admin"], dependencies=[Depends(require_admin)]
)


@router.get("/stats")
async def pool_stats() -> dict:
    """号池统计。"""
    return envelope(await pool_service.stats())


@router.get("/accounts")
async def list_accounts(
    status: str | None = Query(default=None),
    q: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=200),
) -> dict:
    """账号列表（掩码，分页）。"""
    items = await pool_service.list_accounts(status, q)
    total = len(items)
    start = (page - 1) * size
    return envelope({"items": items[start : start + size], "total": total, "page": page, "size": size})


@router.post("/accounts")
async def import_accounts(
    payload: PoolImportRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """导入账号（五方式）。"""
    result = await pool_service.import_accounts(
        db, payload.method, payload.tokens, payload.accounts, admin.id, admin.email
    )
    return envelope(result)


@router.delete("/accounts")
async def delete_accounts(
    payload: PoolDeleteRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """删除账号。"""
    result = await pool_service.delete_accounts(db, payload.tokens, admin.id, admin.email)
    return envelope(result)


@router.post("/accounts/refresh")
async def refresh_accounts(payload: PoolJobRequest) -> dict:
    """触发额度刷新。"""
    job_id = await pool_service.refresh(payload.tokens)
    return envelope({"job_id": job_id})


@router.get("/accounts/refresh/{job_id}")
async def refresh_progress(job_id: str) -> dict:
    """刷新进度。"""
    return envelope(await pool_service.refresh_progress(job_id))


@router.post("/accounts/re-login")
async def relogin_accounts(payload: PoolJobRequest) -> dict:
    """触发重新登录。"""
    job_id = await pool_service.relogin(payload.tokens or [])
    return envelope({"job_id": job_id})


@router.get("/accounts/re-login/{job_id}")
async def relogin_progress(job_id: str) -> dict:
    """重登进度。"""
    return envelope(await pool_service.relogin_progress(job_id))


@router.post("/accounts/update")
async def update_account(
    payload: PoolUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """更新账号。"""
    body = payload.model_dump(exclude_none=True)
    return envelope(await pool_service.update_account(db, body, admin.id, admin.email))


@router.post("/accounts/export")
async def export_accounts(payload: PoolExportRequest) -> Response:
    """导出账号文件流。"""
    resp = await pool_service.export(payload.tokens, payload.format)
    headers = {}
    disposition = resp.headers.get("content-disposition")
    if disposition:
        headers["Content-Disposition"] = disposition
    return Response(
        content=resp.content,
        media_type=resp.headers.get("content-type", "application/json"),
        headers=headers,
    )


@router.post("/accounts/oauth/start")
async def oauth_start(payload: OAuthStartRequest) -> dict:
    """OAuth 起始。"""
    return envelope(await pool_service.oauth_start(payload.email_hint))


@router.post("/accounts/oauth/finish")
async def oauth_finish(
    payload: OAuthFinishRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """OAuth 完成。"""
    return envelope(await pool_service.oauth_finish(payload.session_id, payload.callback))
