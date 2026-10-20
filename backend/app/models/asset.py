"""资产模型（生成图 / 上传图）。"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class Asset(Base):
    """资产库条目，关联画布引用与生成任务。"""

    __tablename__ = "assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    owner_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    # 团队素材：team_id 非空 + visibility='team' 时，团队所有成员可见/可复用
    team_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("teams.id"), index=True, nullable=True
    )
    visibility: Mapped[str] = mapped_column(String(16), default="private", index=True)
    kind: Mapped[str] = mapped_column(String(16), index=True, default="generated")
    url: Mapped[str] = mapped_column(String(1024), nullable=False)
    thumb_url: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    width: Mapped[int] = mapped_column(Integer, default=0)
    height: Mapped[int] = mapped_column(Integer, default=0)
    size_bytes: Mapped[int] = mapped_column(Integer, default=0)
    mime: Mapped[str] = mapped_column(String(64), default="image/png")
    source_prompt: Mapped[str] = mapped_column(String(2048), default="")
    is_demo: Mapped[bool] = mapped_column(Boolean, default=False)
    generation_task_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
