"""后台邀请码路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.models.invite import InviteCode
from app.models.user import User
from app.schemas.admin import InviteCreateRequest, InviteOut, InviteUpdateRequest
from app.services import audit_service, invite_service
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(
    prefix="/api/admin/invites", tags=["admin"], dependencies=[Depends(require_admin)]
)


@router.get("")
async def list_invites(
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
) -> dict:
    """分页查询邀请码。"""
    page, size = normalize_page(page, size)
    base = select(InviteCode)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(InviteCode.created_at.desc()).offset((page - 1) * size).limit(size)
    )
    items = [InviteOut.model_validate(i).model_dump() for i in result.scalars().all()]
    return envelope(paginated(items, total, page, size))


@router.post("")
async def create_invite(
    payload: InviteCreateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """创建邀请码。"""
    invite = await invite_service.create_invite(db, payload.max_uses, payload.expires_at, admin.id)
    await audit_service.log(
        db, action="invite_create", actor=admin, target_type="invite", target_id=invite.id,
        detail={"code": invite.code, "max_uses": invite.max_uses},
    )
    await db.commit()
    await db.refresh(invite)
    return envelope(InviteOut.model_validate(invite).model_dump())


@router.patch("/{invite_id}")
async def update_invite(
    invite_id: str,
    payload: InviteUpdateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """启用/禁用邀请码。"""
    result = await db.execute(select(InviteCode).where(InviteCode.id == invite_id))
    invite = result.scalar_one_or_none()
    if invite is None:
        raise AppError(ErrorCode.NOT_FOUND, "邀请码不存在")
    invite.status = payload.status
    await audit_service.log(
        db, action="invite_update", actor=admin, target_type="invite", target_id=invite.id,
        detail={"status": payload.status},
    )
    await db.commit()
    await db.refresh(invite)
    return envelope(InviteOut.model_validate(invite).model_dump())


@router.delete("/{invite_id}")
async def delete_invite(
    invite_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """删除邀请码。"""
    result = await db.execute(select(InviteCode).where(InviteCode.id == invite_id))
    invite = result.scalar_one_or_none()
    if invite is None:
        raise AppError(ErrorCode.NOT_FOUND, "邀请码不存在")
    await db.delete(invite)
    await audit_service.log(
        db, action="invite_delete", actor=admin, target_type="invite", target_id=invite_id
    )
    await db.commit()
    return envelope({})
