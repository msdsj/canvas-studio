"""个人资料与额度路由 `/api/me/*`。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.quota import QuotaTransactionOut
from app.schemas.user import ChangePasswordRequest, UserOut, UserUpdateRequest
from app.services import auth_service, quota_service
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/me", tags=["me"])


@router.get("")
async def get_me(user: User = Depends(get_current_user)) -> dict:
    """读取个人资料。"""
    return envelope(UserOut.model_validate(user).model_dump())


@router.patch("")
async def update_me(
    payload: UserUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """更新个人资料（昵称/语言/主题）。"""
    if payload.display_name is not None:
        user.display_name = payload.display_name
    if payload.locale is not None:
        user.locale = payload.locale
    if payload.theme is not None:
        user.theme = payload.theme
    await db.commit()
    await db.refresh(user)
    return envelope(UserOut.model_validate(user).model_dump())


@router.post("/change-password")
async def change_password(
    payload: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """修改密码。"""
    await auth_service.change_password(db, user, payload.old_password, payload.new_password)
    return envelope({})


@router.post("/logout-all")
async def logout_all(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """登出全部设备。"""
    await auth_service.logout_all(db, user)
    return envelope({})


@router.get("/quota")
async def get_quota(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """读取额度账户（余额/阈值/单价）。"""
    return envelope(await quota_service.get_account(db, user))


@router.get("/quota/transactions")
async def get_quota_transactions(
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
