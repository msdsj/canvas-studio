"""后台 Pro 激活码路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.models.user import User
from app.schemas.admin import (
    ProCodeCreateRequest,
    ProCodeOut,
    ProCodeUpdateRequest,
)
from app.services import audit_service, pro_service
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(
    prefix="/api/admin/pro-codes", tags=["admin"], dependencies=[Depends(require_admin)]
)


@router.get("")
async def list_pro_codes(
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    status: str | None = Query(default=None),
) -> dict:
    """分页查询激活码。"""
    page, size = normalize_page(page, size)
    rows, total = await pro_service.list_codes(db, page, size, status)
    items = [ProCodeOut.model_validate(r).model_dump() for r in rows]
    return envelope(paginated(items, total, page, size))


@router.post("")
async def create_pro_codes(
    payload: ProCodeCreateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """批量创建激活码（返回完整码，便于复制发放）。"""
    rows = await pro_service.create_codes(
        db,
        count=payload.count,
        max_uses=payload.max_uses,
        expires_at=payload.expires_at,
        note=payload.note,
        created_by=admin.id,
    )
    await audit_service.log(
        db,
        action="pro_code_create",
        actor=admin,
        target_type="pro_code",
        detail={"count": len(rows), "max_uses": payload.max_uses, "note": payload.note},
    )
    await db.commit()
    for row in rows:
        await db.refresh(row)
    return envelope({"items": [ProCodeOut.model_validate(r).model_dump() for r in rows]})


@router.patch("/{code_id}")
async def update_pro_code(
    code_id: str,
    payload: ProCodeUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """启用 / 禁用激活码。"""
    row = await pro_service.set_status(db, code_id, payload.status)
    await audit_service.log(
        db,
        action="pro_code_update",
        actor=admin,
        target_type="pro_code",
        target_id=row.id,
        detail={"status": payload.status},
    )
    await db.commit()
    await db.refresh(row)
    return envelope(ProCodeOut.model_validate(row).model_dump())


@router.delete("/{code_id}")
async def delete_pro_code(
    code_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """删除激活码。"""
    await pro_service.delete_code(db, code_id)
    await audit_service.log(
        db, action="pro_code_delete", actor=admin, target_type="pro_code", target_id=code_id
    )
    await db.commit()
    return envelope({})
