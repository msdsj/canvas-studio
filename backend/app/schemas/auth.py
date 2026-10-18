"""认证相关 Schema。"""
from __future__ import annotations

from pydantic import BaseModel, EmailStr, Field

from app.schemas.user import UserOut


class RegisterRequest(BaseModel):
    """注册请求（仅邮箱 + 密码，注册即登录，无需邮箱确认）。"""

    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=128)


class RegisterResponse(BaseModel):
    """注册响应（与登录一致，直接带回可用的登录态）。"""

    access_token: str
    token_type: str = "bearer"
    user: UserOut


class VerifyEmailRequest(BaseModel):
    """邮箱确认请求。"""

    token: str


class ResendVerificationRequest(BaseModel):
    """重发确认邮件请求。"""

    email: EmailStr


class LoginRequest(BaseModel):
    """登录请求。"""

    email: EmailStr
    password: str


class LoginResponse(BaseModel):
    """登录响应。"""

    access_token: str
    token_type: str = "bearer"
    user: UserOut


class ForgotPasswordRequest(BaseModel):
    """忘记密码请求。"""

    email: EmailStr


class ResetPasswordRequest(BaseModel):
    """重置密码请求。"""

    token: str
    new_password: str = Field(min_length=8, max_length=128)
