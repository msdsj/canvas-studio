"""任务相关 Schema。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class GenerationTaskOut(ORMModel):
    """生成任务输出（任务状态机唯一真源）。"""

    id: str
    user_id: str
    session_id: str | None = None
    canvas_id: str | None = None
    type: str
    prompt: str
    params: dict[str, Any] = Field(default_factory=dict)
    status: str
    progress: int = 0
    result_urls: list[Any] = Field(default_factory=list)
    cost: int = 0
    upstream_task_id: str | None = None
    demo: bool = False
    idempotency_key: str
    paused_at: datetime | None = None
    timeout_at: datetime | None = None
    last_activity_at: datetime | None = None
    result_seen: bool = False
    error_code: str | None = None
    error_message: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
