"""资产服务：列表 / 上传 / 生成入库 / 删除 / 下载。"""
from __future__ import annotations

import mimetypes

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.asset import Asset
from app.services import storage_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow

ALLOWED_MIME = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
ALLOWED_EXT = {"png", "jpg", "jpeg", "webp"}


async def list_assets(
    db: AsyncSession,
    user_id: str,
    page: int,
    size: int,
    kind: str | None = None,
    q: str | None = None,
) -> tuple[list[Asset], int]:
    """分页查询用户资产（时间倒序）。"""
    conditions = [Asset.owner_id == user_id, Asset.deleted_at.is_(None)]
    if kind:
        conditions.append(Asset.kind == kind)
    if q:
        conditions.append(Asset.source_prompt.like(f"%{q}%"))
    base = select(Asset).where(*conditions)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(Asset.created_at.desc()).offset((page - 1) * size).limit(size)
    )
    return list(result.scalars().all()), total


async def get_asset(db: AsyncSession, user: Asset, asset_id: str) -> Asset:
    """获取资产并校验归属。"""
    result = await db.execute(
        select(Asset).where(Asset.id == asset_id, Asset.deleted_at.is_(None))
    )
    asset = result.scalar_one_or_none()
    if asset is None:
        raise AppError(ErrorCode.NOT_FOUND, "资产不存在")
    if asset.owner_id != user.id:
        raise AppError(ErrorCode.FORBIDDEN, "无权访问该资产")
    return asset


async def create_from_bytes(
    db: AsyncSession,
    user_id: str,
    data: bytes,
    *,
    kind: str,
    filename: str = "",
    content_type: str = "",
    prompt: str = "",
    is_demo: bool = False,
    generation_task_id: str | None = None,
) -> Asset:
    """把图片字节写入存储并登记资产。"""
    ext = _guess_ext(filename, content_type)
    saved = storage_service.save_image(user_id, data, ext)
    mime = content_type or mimetypes.guess_type(f"x.{ext}")[0] or "image/png"
    asset = Asset(
        id=new_id(),
        owner_id=user_id,
        kind=kind,
        url=saved["url"],
        thumb_url=saved["thumb_url"] or None,
        width=saved["width"],
        height=saved["height"],
        size_bytes=saved["size"],
        mime=mime,
        source_prompt=prompt,
        is_demo=is_demo,
        generation_task_id=generation_task_id,
    )
    db.add(asset)
    await db.flush()
    return asset


def _guess_ext(filename: str, content_type: str) -> str:
    """推断文件扩展名。"""
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[1].lower()
        if ext in ALLOWED_EXT:
            return "jpg" if ext == "jpeg" else ext
    if content_type:
        ext = content_type.split("/")[-1].lower()
        if ext in ALLOWED_EXT:
            return "jpg" if ext == "jpeg" else ext
    return "png"


async def upload(db: AsyncSession, user_id: str, filename: str, content_type: str, data: bytes) -> Asset:
    """上传图片（校验类型与大小，0 积分）。"""
    if content_type and content_type not in ALLOWED_MIME:
        raise AppError(ErrorCode.VALIDATION_ERROR, "仅支持 png/jpg/webp 图片")
    limit = settings.max_upload_mb * 1024 * 1024
    if len(data) > limit:
        raise AppError(ErrorCode.VALIDATION_ERROR, f"文件超过 {settings.max_upload_mb}MB 上限")
    if not data:
        raise AppError(ErrorCode.VALIDATION_ERROR, "文件内容为空")
    return await create_from_bytes(
        db, user_id, data, kind="uploaded", filename=filename, content_type=content_type
    )


async def delete_asset(db: AsyncSession, user: Asset, asset_id: str) -> None:
    """软删除资产（仅移出资产库）。"""
    target = await get_asset(db, user, asset_id)
    target.deleted_at = utcnow()
    await db.flush()


def local_path_from_url(url: str) -> str | None:
    """把对外 URL 反解为本地相对路径（用于下载）。"""
    base = settings.storage_public_base.rstrip("/")
    if not url.startswith(base):
        return None
    return url[len(base):].lstrip("/")
