"""资产路由 `/api/assets/*`。"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, Query, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.asset import AssetOut
from app.services import asset_service, storage_service
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/assets", tags=["assets"])


@router.get("")
async def list_assets(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    kind: str | None = Query(default=None),
    q: str | None = Query(default=None),
) -> dict:
    """分页查询资产。"""
    page, size = normalize_page(page, size)
    rows, total = await asset_service.list_assets(db, user.id, page, size, kind, q)
    items = [AssetOut.model_validate(r).model_dump() for r in rows]
    return envelope(paginated(items, total, page, size))


@router.post("/upload")
async def upload_asset(
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """上传图片到资产库。"""
    data = await file.read()
    asset = await asset_service.upload(
        db, user.id, file.filename or "upload.png", file.content_type or "", data
    )
    await db.commit()
    return envelope(AssetOut.model_validate(asset).model_dump())


@router.get("/{asset_id}")
async def get_asset(
    asset_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """获取资产详情。"""
    asset = await asset_service.get_asset(db, user, asset_id)
    return envelope(AssetOut.model_validate(asset).model_dump())


@router.delete("/{asset_id}")
async def delete_asset(
    asset_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除资产（软删，不影响画布引用）。"""
    await asset_service.delete_asset(db, user, asset_id)
    await db.commit()
    return envelope({})


@router.get("/{asset_id}/download")
async def download_asset(
    asset_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FileResponse:
    """下载资产文件。"""
    asset = await asset_service.get_asset(db, user, asset_id)
    rel = asset_service.local_path_from_url(asset.url)
    if not rel:
        raise AppError(ErrorCode.NOT_FOUND, "文件不在本地存储中")
    path = Path(storage_service.storage_root()) / rel
    if not path.exists():
        raise AppError(ErrorCode.NOT_FOUND, "文件已不存在")
    filename = path.name
    return FileResponse(path, media_type=asset.mime, filename=filename)
