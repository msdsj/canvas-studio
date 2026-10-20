"""Skills 工作流运行记录。

每次「需求分析中转站」的判定都落一行，目的是**可追溯**：
用户事后能回看 AI 当时为什么判定要生成 1 张还是 2 张、走了哪条编排分支、
是在哪一步停下来等确认的。它同时是确认流程的服务端凭据——前端只传 run_id，
不允许把「要生成几张」这种决策交给客户端回传（否则编排逻辑形同虚设）。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class SkillRun(Base):
    """一次 Skills 编排的执行记录。"""

    __tablename__ = "skill_runs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    session_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)
    canvas_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    # 团队审计：团队内谁在什么场景下跑了哪条编排
    team_id: Mapped[str | None] = mapped_column(String(36), index=True, nullable=True)

    skill_id: Mapped[str] = mapped_column(String(64), default="image_edit_intent")
    # completed / awaiting_confirmation / needs_image / failed / cancelled
    status: Mapped[str] = mapped_column(String(32), default="completed", index=True)

    image_count: Mapped[int] = mapped_column(Integer, default=1)
    confidence: Mapped[float] = mapped_column(Integer, default=0)  # 存 0-100 的整数，避免 SQLite 浮点误差

    # 输入快照：用户原话 + 选区（确认时据此重建任务，不信任前端回传的计划）
    input: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 判定结果：intent / reason / tasks / ops / variants
    plan: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 步骤轨迹：[{id,title,status,detail,elapsed_ms}]
    steps: Mapped[list[Any]] = mapped_column(JSON, default=list)
    # 待确认时可选的方案
    options: Mapped[list[Any]] = mapped_column(JSON, default=list)
    # 执行后落下的任务 id
    task_ids: Mapped[list[Any]] = mapped_column(JSON, default=list)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
