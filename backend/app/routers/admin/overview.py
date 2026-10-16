"""后台概览路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.models.user import User
from app.services import pool_service, quota_service
from app.utils.errors import AppError, envelope

router = APIRouter(
    prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)]
)

ZERO_POOL = {"total": 0, "normal": 0, "limited": 0, "abnormal": 0, "disabled": 0}


@router.get("/overview")
async def overview(db: AsyncSession = Depends(get_db)) -> dict:
    """返回用户总数、活跃数、号池统计与今日消耗。"""
    users_total = int((await db.execute(select(func.count()).select_from(User))).scalar() or 0)
    users_active = int(
        (
            await db.execute(select(func.count()).where(User.status == "active"))
        ).scalar()
        or 0
    )
    try:
        pool = await pool_service.stats()
    except AppError:
        pool = dict(ZERO_POOL)
    return envelope(
        {
            "users_total": users_total,
            "users_active": users_active,
            "pool": pool,
            "quota_consumed_today": await quota_service.consumed_today(db),
        }
    )
