"""后台用户管理路由。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_admin
from app.models.email_token import EmailToken
from app.models.quota import QuotaTransaction
from app.models.user import User
from app.schemas.admin import AdminUserCreateRequest, AdminUserOut, BanRequest, ProGrantRequest
from app.schemas.quota import AdminQuotaAdjustRequest, QuotaTransactionOut
from app.security import generate_token, hash_password
from app.services import audit_service, email_service, pro_service, quota_service, team_service
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.ids import new_id, utcnow
from app.utils.pagination import normalize_page, paginated
from datetime import timedelta

from app.config import settings

router = APIRouter(
    prefix="/api/admin/users", tags=["admin"], dependencies=[Depends(require_admin)]
)


async def _get_user(db: AsyncSession, user_id: str) -> User:
    """按 id 获取用户。"""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise AppError(ErrorCode.NOT_FOUND, "用户不存在")
    return user


@router.get("")
async def list_users(
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(default=None),
    role: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
) -> dict:
    """分页查询用户（搜索/筛选）。"""
    page, size = normalize_page(page, size)
    conditions = []
    if q:
        conditions.append(User.email.like(f"%{q}%"))
    if role:
        conditions.append(User.role == role)
    if status:
        conditions.append(User.status == status)
    base = select(User)
    if conditions:
        base = base.where(*conditions)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(User.created_at.desc()).offset((page - 1) * size).limit(size)
    )
    items = [AdminUserOut.model_validate(u).model_dump() for u in result.scalars().all()]
    return envelope(paginated(items, total, page, size))


@router.post("")
async def create_user(
    payload: AdminUserCreateRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """后台新建用户（默认普通用户，直接 active 并发放初始额度）。"""
    email = payload.email.strip().lower()
    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none() is not None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "该邮箱已被注册")

    # Customer accounts never receive platform administrator permissions.
    role = "user"
    user = User(
        id=new_id(),
        email=email,
        password_hash=hash_password(payload.password),
        role=role,
        status="active",
        display_name=payload.display_name or email.split("@")[0],
        email_verified_at=utcnow(),
    )
    db.add(user)
    await db.flush()

    if settings.initial_grant > 0:
        await quota_service.grant(db, user.id, settings.initial_grant, note="管理员创建用户初始赠送")

    team_name = (payload.team_name or "").strip()
    if team_name:
        team = await team_service.create_team(db, user, team_name)
        user.active_team_id = team.id

    await audit_service.log(
        db,
        action="user_create",
        actor=admin,
        target_type="user",
        target_id=user.id,
        detail={"email": email, "role": role, "team_name": team_name or None},
    )
    await db.commit()
    await db.refresh(user)
    return envelope({
        **AdminUserOut.model_validate(user).model_dump(),
        "active_team_id": user.active_team_id,
        "team_name": team_name or None,
    })


@router.get("/{user_id}")
async def get_user(user_id: str, db: AsyncSession = Depends(get_db)) -> dict:
    """获取用户详情（含最近流水）。"""
    user = await _get_user(db, user_id)
    txs = (
        await db.execute(
            select(QuotaTransaction)
            .where(QuotaTransaction.user_id == user_id)
            .order_by(QuotaTransaction.created_at.desc())
            .limit(20)
        )
    ).scalars().all()
    return envelope(
        {
            **AdminUserOut.model_validate(user).model_dump(),
            "recent_transactions": [
                QuotaTransactionOut.model_validate(t).model_dump() for t in txs
            ],
        }
    )


@router.post("/{user_id}/quota")
async def adjust_quota(
    user_id: str,
    payload: AdminQuotaAdjustRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """调整用户额度（落流水 + 审计）。"""
    user = await _get_user(db, user_id)
    balance, tx = await quota_service.admin_adjust(
        db, user, payload.mode, payload.amount, payload.note, admin.id
    )
    await audit_service.log(
        db,
        action="quota_adjust",
        actor=admin,
        target_type="user",
        target_id=user.id,
        detail={"mode": payload.mode, "amount": payload.amount, "note": payload.note},
    )
    await db.commit()
    return envelope(
        {"balance": balance, "tx": QuotaTransactionOut.model_validate(tx).model_dump()}
    )


@router.post("/{user_id}/ban")
async def ban_user(
    user_id: str,
    payload: BanRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """封禁用户。"""
    user = await _get_user(db, user_id)
    user.status = "banned"
    user.banned_reason = payload.reason or "违反平台规则"
    user.token_version += 1
    await audit_service.log(
        db, action="user_ban", actor=admin, target_type="user", target_id=user.id,
        detail={"reason": user.banned_reason},
    )
    await db.commit()
    await db.refresh(user)
    return envelope(AdminUserOut.model_validate(user).model_dump())


@router.post("/{user_id}/unban")
async def unban_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """解封用户。"""
    user = await _get_user(db, user_id)
    user.status = "active"
    user.banned_reason = None
    await audit_service.log(
        db, action="user_unban", actor=admin, target_type="user", target_id=user.id
    )
    await db.commit()
    await db.refresh(user)
    return envelope(AdminUserOut.model_validate(user).model_dump())


@router.post("/{user_id}/pro")
async def grant_pro(
    user_id: str,
    payload: ProGrantRequest,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """超管直接给用户开通 Pro（小时卡 / 天卡 / 周卡 / 月卡 / 永久）。

    到期后由调度器把 role 降回 user，Pro 页面与功能权限随之回收。
    """
    user = await _get_user(db, user_id)
    result = await pro_service.grant(db, user, payload.duration_hours, actor_email=admin.email)
    await audit_service.log(
        db,
        action="user_grant_pro",
        actor=admin,
        target_type="user",
        target_id=user.id,
        detail={"duration_hours": payload.duration_hours},
    )
    await db.commit()
    await db.refresh(user)
    return envelope(
        {
            "user": AdminUserOut.model_validate(user).model_dump(),
            "pro_expires_at": result["pro_expires_at"],
            "duration_hours": result["duration_hours"],
        }
    )


@router.post("/{user_id}/reset-password")
async def reset_password(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """管理员重置用户密码，返回临时密码（并入审计）。"""
    user = await _get_user(db, user_id)
    temp_password = generate_token(9)
    user.password_hash = hash_password(temp_password)
    user.token_version += 1
    await audit_service.log(
        db, action="user_reset_password", actor=admin, target_type="user", target_id=user.id
    )
    await db.commit()
    return envelope({"temp_password": temp_password})


@router.post("/{user_id}/resend-verification")
async def resend_verification(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    admin: User = Depends(require_admin),
) -> dict:
    """管理员代发确认邮件。"""
    user = await _get_user(db, user_id)
    token = generate_token()
    db.add(
        EmailToken(
            id=new_id(),
            user_id=user.id,
            token=token,
            type="verify",
            expires_at=utcnow() + timedelta(hours=settings.verify_token_ttl_hours),
        )
    )
    await audit_service.log(
        db, action="user_resend_verification", actor=admin, target_type="user", target_id=user.id
    )
    await db.commit()
    await email_service.send_verify_email(user.email, token)
    return envelope({})
