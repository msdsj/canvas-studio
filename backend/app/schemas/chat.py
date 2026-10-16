"""对话相关 Schema。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class ChatSessionCreateRequest(BaseModel):
    """新建会话请求。"""

    canvas_id: str | None = None
    title: str | None = Field(default=None, max_length=255)


class ChatSessionUpdateRequest(BaseModel):
    """会话更新请求。"""

    title: str | None = Field(default=None, max_length=255)


class ChatSessionOut(ORMModel):
    """会话输出。"""

    id: str
    user_id: str
    canvas_id: str | None = None
    title: str
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ChatMessageOut(ORMModel):
    """消息输出。"""

    id: str
    session_id: str
    user_id: str
    role: str
    content: str
    attachments: list[Any] = Field(default_factory=list)
    generation_task_id: str | None = None
    created_at: datetime | None = None


class ChatMessageCreateRequest(BaseModel):
    """发送消息（走 SSE）请求。"""

    session_id: str
    content: str = Field(min_length=1, max_length=8000)
    canvas_id: str | None = None
    image_refs: list[str] = Field(default_factory=list)


class ChatStreamChunk(BaseModel):
    """SSE 数据块。"""

    delta: str = ""
    done: bool = False
    demo: bool = False
    error_code: str | None = None
