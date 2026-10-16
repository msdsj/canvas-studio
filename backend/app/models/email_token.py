"""邮箱令牌模型（确认 / 重置）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class EmailToken(Base):
    """邮箱验证 / 密码重置令牌。"""

    __tablename__ = "email_tokens"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    token: Mapped[str] = mapped_column(String(128), unique=True, index=True, nullable=False)
    type: Mapped[str] = mapped_column(String(16), index=True)  # verify | reset
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True, nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
