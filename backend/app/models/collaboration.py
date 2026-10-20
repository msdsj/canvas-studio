"""协作相关模型：画布级协作者授权。

团队内默认「团队可见即可编辑」，所以本表主要用于两种场景：
1. 把**个人画布**单独授权给某个同事（不公开给整个团队）；
2. 给团队外的人开一个可编辑/只读席位（外部协作）。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow

COLLAB_VIEWER = "viewer"
COLLAB_EDITOR = "editor"
COLLAB_ROLES = (COLLAB_VIEWER, COLLAB_EDITOR)


class CanvasCollaborator(Base):
    """画布协作者（显式授权）。"""

    __tablename__ = "canvas_collaborators"
    __table_args__ = (UniqueConstraint("canvas_id", "user_id", name="uq_canvas_collaborator"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    canvas_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("canvases.id"), index=True, nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), default=COLLAB_EDITOR)
    created_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
