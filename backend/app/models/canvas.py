"""画布模型（Excalidraw 场景内嵌 JSON）。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class Canvas(Base):
    """单个画布，元素内嵌于 `state` JSON。"""

    __tablename__ = "canvases"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    project_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("canvas_projects.id"), index=True, nullable=False
    )
    owner_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    team_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("teams.id"), index=True, nullable=True
    )
    visibility: Mapped[str] = mapped_column(String(16), default="private", index=True)
    name: Mapped[str] = mapped_column(String(255), default="未命名画布")
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 协作版本号：每次 patch 落库 +1。客户端据此判断是否漏帧、是否要全量重同步。
    # 不用 `updated_at` 做版本：时间戳精度与并发下都可能相等，无法区分两次修改。
    version: Mapped[int] = mapped_column(Integer, default=0)
    updated_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    thumbnail_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    share_token: Mapped[str | None] = mapped_column(
        String(64), unique=True, index=True, nullable=True
    )
    is_public: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
