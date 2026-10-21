"""生成任务模型（含任务状态机字段 + 幂等唯一约束）。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class GenerationTask(Base):
    """生成 / 编辑任务：任务状态机唯一真源。"""

    __tablename__ = "generation_tasks"
    __table_args__ = (
        UniqueConstraint("user_id", "idempotency_key", name="uq_gen_task_user_idem"),
        # ── 复合索引：把「过滤 + 排序」一次性走索引，消掉临时 B 树 ────────────
        # 加之前（EXPLAIN QUERY PLAN 实测）：三条读路径全都
        #   SEARCH ... USING INDEX (user_id=?) / (status=?)
        #   USE TEMP B-TREE FOR ORDER BY      ← 每次查询都现排一遍
        # `user_id` 单列索引无法同时满足 `ORDER BY created_at DESC`，
        # 而 `list_unread` 更糟——优化器挑了 `status='succeeded'` 这个极低选择性的
        # 索引，等于扫**所有用户**的成功任务。任务表是平台增长最快的表，必须修掉。
        Index("ix_gen_task_user_created", "user_id", "created_at"),
        # 活跃任务轮询（前端每 3s）：user_id + status 过滤，created_at 排序
        Index("ix_gen_task_user_status_created", "user_id", "status", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    session_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    canvas_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 任务归属团队：用于团队用量统计与共享额度池对账；扣费仍记在发起人名下
    team_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    type: Mapped[str] = mapped_column(String(16), default="generate")  # generate | edit
    prompt: Mapped[str] = mapped_column(Text, default="")
    params: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    status: Mapped[str] = mapped_column(String(16), index=True, default="queued")
    progress: Mapped[int] = mapped_column(Integer, default=0)
    result_urls: Mapped[list[Any]] = mapped_column(JSON, default=list)
    cost: Mapped[int] = mapped_column(Integer, default=0)
    upstream_task_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    demo: Mapped[bool] = mapped_column(Boolean, default=False)
    idempotency_key: Mapped[str] = mapped_column(String(64), nullable=False)
    paused_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    timeout_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_activity_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    result_seen: Mapped[bool] = mapped_column(Boolean, default=False)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
