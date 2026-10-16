"""活跃 / 未读任务路由 `/api/tasks/*`（刷新续接）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.task import GenerationTaskOut
from app.services import task_service
from app.utils.errors import envelope

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("/active")
async def list_active(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """返回当前用户活跃任务（queued/running/paused），用于刷新续接。"""
    tasks = await task_service.list_active(db, user.id)
    return envelope([GenerationTaskOut.model_validate(t).model_dump() for t in tasks])


@router.get("/unread")
async def list_unread(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """返回已完成未读结果任务。"""
    tasks = await task_service.list_unread(db, user.id)
    return envelope([GenerationTaskOut.model_validate(t).model_dump() for t in tasks])
