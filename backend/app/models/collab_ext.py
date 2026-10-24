"""画布协作扩展：打点评论 + 版本快照。

为什么单独一张表
----------------
`canvases.state` 已经是整份 Excalidraw 场景的 JSON。如果把评论塞进 state：
- 每次协作 patch 都会把评论一起广播，评论多时拖慢同步；
- 评论的「已解决 / 删除」是**行级**状态，放进 JSON 里就得自己在客户端合并冲突。

版本快照同理：恢复历史版本是一次「整份覆盖」，必须能独立于实时协作的
patch 流存在，否则恢复操作会被当成一次普通编辑继续被合并。

两张表都用软删（`deleted_at`），便于审计与「误删恢复」。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class CanvasComment(Base):
    """画布上的一个评论点（坐标是画布坐标系，不是屏幕坐标）。"""

    __tablename__ = "canvas_comments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    canvas_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("canvases.id"), index=True, nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    # 评论挂载的画布坐标（Excalidraw scene 坐标，随缩放平移一起移动）
    x: Mapped[float] = mapped_column(Float, default=0.0)
    y: Mapped[float] = mapped_column(Float, default=0.0)
    # 可选：挂在某个元素上（图片），元素被移动时评论点跟着走
    element_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    content: Mapped[str] = mapped_column(Text, default="")
    # 楼中楼：parent_id 指向同表的顶级评论
    parent_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    # @ 到的成员（user_id 列表），前端据此高亮与通知
    mentions: Mapped[list[Any]] = mapped_column(JSON, default=list)
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


class CanvasVersion(Base):
    """画布历史版本（整份 state 快照）。

    `version` 取自快照时的 `canvases.version`，用于和协作流水对上号；
    恢复时把快照内容整份写回，并**先**为当前状态再存一版，保证可后悔。
    """

    __tablename__ = "canvas_versions"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    canvas_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("canvases.id"), index=True, nullable=False
    )
    user_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    label: Mapped[str] = mapped_column(String(120), default="自动保存")
    kind: Mapped[str] = mapped_column(String(16), default="auto")  # auto | manual | restore
    version: Mapped[int] = mapped_column(Integer, default=0)
    state: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    element_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
