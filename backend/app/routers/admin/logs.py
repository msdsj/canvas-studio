"""后台操作日志路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.schemas.admin import AuditLogOut
from app.services import audit_service
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(
    prefix="/api/admin/logs", tags=["admin"], dependencies=[Depends(require_admin)]
)


@router.get("")
async def list_logs(
    db: AsyncSession = Depends(get_db),
    actor: str | None = Query(default=None),
    action: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
) -> dict:
    """分页查询审计日志。"""
    page, size = normalize_page(page, size)
    rows, total = await audit_service.list_logs(db, page, size, actor, action)
    items = [AuditLogOut.model_validate(r).model_dump() for r in rows]
    return envelope(paginated(items, total, page, size))
