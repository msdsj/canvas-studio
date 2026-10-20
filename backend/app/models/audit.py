"""审计日志模型。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class AuditLog(Base):
    """管理 / 关键动作审计。"""

    __tablename__ = "audit_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    actor_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=True
    )
    actor_email: Mapped[str] = mapped_column(String(255), default="")
    action: Mapped[str] = mapped_column(String(64), index=True, nullable=False)
    # 团队维度审计：企业侧能只看自己团队的成员 / 权限 / 配置变更
    team_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    target_type: Mapped[str] = mapped_column(String(64), default="")
    target_id: Mapped[str | None] = mapped_column(String(64), index=True, nullable=True)
    detail: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    ip: Mapped[str] = mapped_column(String(64), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
