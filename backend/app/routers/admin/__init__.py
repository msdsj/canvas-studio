"""管理后台路由包（聚合）。"""
from fastapi import APIRouter

from app.routers.admin import (
    announcements,
    config,
    invites,
    logs,
    overview,
    pool,
    pro_codes,
    users,
)

router = APIRouter()
router.include_router(overview.router)
router.include_router(users.router)
router.include_router(pool.router)
router.include_router(config.router)
router.include_router(invites.router)
router.include_router(pro_codes.router)
router.include_router(announcements.router)
router.include_router(logs.router)

__all__ = ["router"]
