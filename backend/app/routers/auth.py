"""认证路由 `/api/auth/*`。"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.auth import (
    ForgotPasswordRequest,
    LoginRequest,
    RegisterRequest,
    ResendVerificationRequest,
    ResetPasswordRequest,
    VerifyEmailRequest,
)
from app.schemas.user import UserOut
from app.services import auth_service
from app.utils.errors import envelope

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register")
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> dict:
    """注册账号并发送确认邮件。"""
    user = await auth_service.register(
        db,
        email=payload.email,
        password=payload.password,
        display_name=payload.display_name,
        invite_code=payload.invite_code,
    )
    return envelope({"user_id": user.id, "email": user.email, "status": user.status})


@router.post("/verify-email")
async def verify_email(payload: VerifyEmailRequest, db: AsyncSession = Depends(get_db)) -> dict:
    """邮箱确认并发放初始额度。"""
    user = await auth_service.verify_email(db, payload.token)
    return envelope({"status": user.status})


@router.post("/resend-verification")
async def resend_verification(
    payload: ResendVerificationRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """重发确认邮件（60s 限流）。"""
    await auth_service.resend_verification(db, payload.email)
    return envelope({})


@router.post("/login")
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> dict:
    """登录并签发 JWT。"""
    token, user = await auth_service.login(db, payload.email, payload.password)
    return envelope(
        {
            "access_token": token,
            "token_type": "bearer",
            "user": UserOut.model_validate(user).model_dump(),
        }
    )


@router.post("/logout")
async def logout(user: User = Depends(get_current_user)) -> dict:
    """登出（客户端丢弃 token）。"""
    return envelope({})


@router.post("/forgot-password")
async def forgot_password(
    payload: ForgotPasswordRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """发送重置密码邮件（统一文案）。"""
    await auth_service.forgot_password(db, payload.email)
    return envelope({})


@router.post("/reset-password")
async def reset_password(
    payload: ResetPasswordRequest, db: AsyncSession = Depends(get_db)
) -> dict:
    """重置密码。"""
    await auth_service.reset_password(db, payload.token, payload.new_password)
    return envelope({})


@router.get("/me")
async def me(user: User = Depends(get_current_user)) -> dict:
    """返回当前登录用户。"""
    return envelope(UserOut.model_validate(user).model_dump())
