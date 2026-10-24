"""后台概览路由。

router 只做「取数据 → 组装响应」：所有统计在 `app.services.overview_stats_service`，
号池统计在 `app.services.pool_service`（它要访问网关，失败时降级为全零）。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.schemas.admin import OverviewOut
from app.services import overview_stats_service, pool_service
from app.utils.errors import AppError, envelope

router = APIRouter(
    prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)]
)

ZERO_POOL = {"total": 0, "normal": 0, "limited": 0, "abnormal": 0, "disabled": 0}


async def _pool_stats() -> dict:
    """号池统计；网关不可用时不阻塞概览（返回全零而不是 500）。"""
    try:
        return await pool_service.stats()
    except AppError:
        return dict(ZERO_POOL)


@router.get("/overview")
async def overview(db: AsyncSession = Depends(get_db)) -> dict:
    """后台概览：总量指标 + 14 天趋势 + 最近动态 + 待处理事项。

    原有字段（`users_total` / `users_active` / `pool` / `quota_consumed_today`）
    保持原样，新增字段一律追加，老前端不改也能跑。
    """
    pool = await _pool_stats()
    data = await overview_stats_service.admin_overview(db, pool)
    return envelope(OverviewOut.model_validate(data).model_dump())
