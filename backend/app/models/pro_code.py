"""Pro 激活码模型。

权限分级：普通用户（`role=user`）只能用文生图；Pro（`role=pro`）解锁画布、
抠图、AI 对话、提示词润色、图生图。

出于「不新增/不修改 users 表列」的迁移约束，激活码单独建一张表，兑换时只更新
`users.role` 这个已存在的字符串列，因此无需任何表结构迁移。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class ProCode(Base):
    """Pro 激活码（可单次或多次使用，可设失效时间）。"""

    __tablename__ = "pro_codes"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    max_uses: Mapped[int] = mapped_column(Integer, default=1)
    used_count: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), index=True, default="active")
    note: Mapped[str] = mapped_column(String(128), default="")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    # 兑换后授予的 Pro 时长（小时）：0 = 永久。
    # 与 `expires_at`（码本身的失效时间）是两件事，别混用。
    duration_hours: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
