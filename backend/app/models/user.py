"""用户模型。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class User(Base):
    """平台用户（含额度余额、角色、状态）。"""

    __tablename__ = "users"
    __table_args__ = (CheckConstraint("balance >= 0", name="ck_users_balance_non_negative"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[str] = mapped_column(String(16), index=True, default="user")
    status: Mapped[str] = mapped_column(
        String(32), index=True, default="pending_verification"
    )
    display_name: Mapped[str] = mapped_column(String(128), default="")
    locale: Mapped[str] = mapped_column(String(16), default="zh-CN")
    theme: Mapped[str] = mapped_column(String(16), default="system")
    balance: Mapped[int] = mapped_column(Integer, default=0)
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    # 首登引导：身份场景（developer / ui_designer / ecommerce …）与完成时间。
    # 用 `onboarding_completed_at` 而不是布尔：既能判断是否完成，也能做激活漏斗统计。
    persona_key: Mapped[str] = mapped_column(String(32), default="")
    onboarding_completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 当前生效的团队（个人空间为 NULL）。
    # 刻意**不加外键**：teams.owner_user_id → users.id 已经是一条反向依赖，
    # 再加 users.active_team_id → teams.id 会让 create_all 变成循环依赖而无法建表。
    active_team_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    banned_reason: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Pro 套餐到期时间：NULL 表示永久（老数据 / 管理员直开）。
    # 定时任务扫描到期行把 role 降回 user，前端据此重新锁住 Pro 页面与功能。
    pro_expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
