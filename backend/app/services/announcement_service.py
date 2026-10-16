"""公告服务。"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.announcement import Announcement
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow


async def list_active(db: AsyncSession) -> list[Announcement]:
    """列出已发布公告（最新在前）。"""
    result = await db.execute(
        select(Announcement)
        .where(Announcement.status == "published")
        .order_by(Announcement.published_at.desc())
    )
    return list(result.scalars().all())


async def list_all(db: AsyncSession, page: int, size: int) -> tuple[list[Announcement], int]:
    """后台分页查询全部公告。"""
    base = select(Announcement)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(Announcement.created_at.desc()).offset((page - 1) * size).limit(size)
    )
    return list(result.scalars().all()), total


async def create(
    db: AsyncSession, title: str, content: str, level: str, created_by: str
) -> Announcement:
    """创建公告（草稿）。"""
    announcement = Announcement(
        id=new_id(), title=title, content=content, level=level, status="draft", created_by=created_by
    )
    db.add(announcement)
    await db.flush()
    return announcement


async def update(
    db: AsyncSession,
    announcement_id: str,
    status: str | None,
    title: str | None,
    content: str | None,
) -> Announcement:
    """更新公告（发布时记录 published_at）。"""
    result = await db.execute(select(Announcement).where(Announcement.id == announcement_id))
    announcement = result.scalar_one_or_none()
    if announcement is None:
        raise AppError(ErrorCode.NOT_FOUND, "公告不存在")
    if title is not None:
        announcement.title = title
    if content is not None:
        announcement.content = content
    if status is not None:
        announcement.status = status
        if status == "published" and announcement.published_at is None:
            announcement.published_at = utcnow()
    announcement.updated_at = utcnow()
    await db.flush()
    return announcement


async def delete(db: AsyncSession, announcement_id: str) -> None:
    """删除公告。"""
    result = await db.execute(select(Announcement).where(Announcement.id == announcement_id))
    announcement = result.scalar_one_or_none()
    if announcement is None:
        raise AppError(ErrorCode.NOT_FOUND, "公告不存在")
    await db.delete(announcement)
    await db.flush()
