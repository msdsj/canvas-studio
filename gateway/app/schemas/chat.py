"""对话 Schema。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class ChatMessage(BaseModel):
    """对话消息。"""

    role: str = "user"
    content: Any = ""


class ChatCompletionRequest(BaseModel):
    """OpenAI 兼容对话请求（允许透传额外字段）。"""

    model_config = ConfigDict(extra="allow")

    model: str = "gpt-4o-mini"
    messages: list[ChatMessage] = Field(default_factory=list)
    stream: bool = False
