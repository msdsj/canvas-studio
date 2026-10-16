"""健康检查路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.services import config_service
from app.utils.errors import envelope

router = APIRouter(prefix="/api", tags=["health"])


@router.get("/health")
async def health(db: AsyncSession = Depends(get_db)) -> dict:
    """返回服务存活状态、版本与当前 Demo 模式。"""
    demo = await config_service.demo_mode(db)
    return envelope(
        {"status": "ok", "version": settings.app_version, "demo_mode": demo}
    )
