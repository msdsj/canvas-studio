"""公告读取路由 `/api/announcements/*`。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.admin import AnnouncementOut
from app.services import announcement_service
from app.utils.errors import envelope

router = APIRouter(prefix="/api/announcements", tags=["announcements"])


@router.get("/active")
async def list_active(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """读取已发布公告。"""
    items = await announcement_service.list_active(db)
    return envelope([AnnouncementOut.model_validate(a).model_dump() for a in items])
