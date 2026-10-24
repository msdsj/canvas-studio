"""额度路由 `/api/quota/*`。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.quota import QuotaSummaryOut, QuotaTransactionOut
from app.services import config_service, quota_service, usage_stats_service
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/quota", tags=["quota"])


@router.get("/prices")
async def get_prices(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """读取单价表。"""
    return envelope(await config_service.prices(db))


@router.get("/summary")
async def get_summary(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """额度汇总：余额 / 累计获得 / 累计消耗 / 14 天趋势 / 按类型分布。

    「累计获得」取自真实流水（grant + admin_adjust 正向 + 未入账的历史初始余额），
    不会出现余额一万多、累计获得却是 0 的自相矛盾。
    """
    data = await usage_stats_service.quota_summary(db, user)
    return envelope(QuotaSummaryOut.model_validate(data).model_dump())


@router.get("/transactions")
async def get_transactions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    type: str | None = Query(default=None),
) -> dict:
    """分页查询额度流水。

    每项都带 `balance_after`（该笔之后的余额）。这个值在扣减/发放的同一个事务里
    就落库了，这里只读不重算——按时间正序累加推算「事后余额」在管理员
    `set`（直接改余额）之后会整体算错。
    """
    page, size = normalize_page(page, size)
    rows, total = await quota_service.list_transactions(db, user.id, page, size, type)
    items = [QuotaTransactionOut.model_validate(r).model_dump() for r in rows]
    return envelope(paginated(items, total, page, size))
