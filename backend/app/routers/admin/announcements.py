"""后台公告路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.models.user import User
from app.schemas.admin import (
    AnnouncementCreateRequest,
    AnnouncementOut,
    AnnouncementUpdateRequest,
)
from app.services import announcement_service, audit_service
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(
    prefix="/api/admin/announcements", tags=["admin"], dependencies=[Depends(require_admin)]
)


@router.get("")
async def list_announcements(
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
) -> dict:
    """分页查询公告。"""
    page, size = normalize_page(page, size)
    rows, total = await announcement_service.list_all(db, page, size)
    items = [AnnouncementOut.model_validate(a).model_dump() for a in rows]
    return envelope(paginated(items, total, page, size))


@router.post("")
async def create_announcement(
    payload: AnnouncementCreateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """创建公告。"""
    announcement = await announcement_service.create(
        db, payload.title, payload.content, payload.level, admin.id
    )
    await audit_service.log(
        db, action="announcement_create", actor=admin, target_type="announcement",
        target_id=announcement.id,
    )
    await db.commit()
    return envelope(AnnouncementOut.model_validate(announcement).model_dump())


@router.patch("/{announcement_id}")
async def update_announcement(
    announcement_id: str,
    payload: AnnouncementUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """更新/发布/下线公告。"""
    announcement = await announcement_service.update(
        db, announcement_id, payload.status, payload.title, payload.content
    )
    await audit_service.log(
        db, action="announcement_update", actor=admin, target_type="announcement",
        target_id=announcement.id, detail={"status": payload.status},
    )
    await db.commit()
    return envelope(AnnouncementOut.model_validate(announcement).model_dump())


@router.delete("/{announcement_id}")
async def delete_announcement(
    announcement_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """删除公告。"""
    await announcement_service.delete(db, announcement_id)
    await audit_service.log(
        db, action="announcement_delete", actor=admin, target_type="announcement",
        target_id=announcement_id,
    )
    await db.commit()
    return envelope({})
