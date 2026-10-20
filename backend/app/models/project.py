"""画布项目模型。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class CanvasProject(Base):
    """项目：一个项目可包含多个画布。"""

    __tablename__ = "canvas_projects"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    # 团队项目：team_id 非空即属于团队资源；NULL = 个人项目（历史数据全部落在这里）
    team_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("teams.id"), index=True, nullable=True
    )
    # private | team：team 表示团队内所有成员可见
    visibility: Mapped[str] = mapped_column(String(16), default="private", index=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str] = mapped_column(String(1024), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)
