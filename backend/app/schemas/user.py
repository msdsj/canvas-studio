"""用户相关 Schema。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class UserOut(ORMModel):
    """用户公开信息。"""

    id: str
    email: str
    role: str
    status: str
    display_name: str
    locale: str
    theme: str
    balance: int
    email_verified_at: datetime | None = None
    last_login_at: datetime | None = None
    created_at: datetime | None = None


class UserUpdateRequest(BaseModel):
    """个人资料更新。"""

    display_name: str | None = Field(default=None, max_length=128)
    locale: str | None = Field(default=None, max_length=16)
    theme: str | None = Field(default=None, max_length=16)


class ChangePasswordRequest(BaseModel):
    """修改密码请求。"""

    old_password: str
    new_password: str = Field(min_length=8, max_length=128)


class ProRedeemRequest(BaseModel):
    """激活 Pro 请求。"""

    code: str = Field(min_length=4, max_length=64)
