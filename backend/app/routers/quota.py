"""额度路由 `/api/quota/*`。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.quota import QuotaTransactionOut
from app.services import config_service, quota_service
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/quota", tags=["quota"])


@router.get("/prices")
async def get_prices(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """读取单价表。"""
    return envelope(await config_service.prices(db))


@router.get("/transactions")
async def get_transactions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    type: str | None = Query(default=None),
) -> dict:
    """分页查询额度流水。"""
    page, size = normalize_page(page, size)
    rows, total = await quota_service.list_transactions(db, user.id, page, size, type)
    items = [QuotaTransactionOut.model_validate(r).model_dump() for r in rows]
    return envelope(paginated(items, total, page, size))
