"""画布相关 Schema。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class CanvasCreateRequest(BaseModel):
    """新建画布请求。"""

    name: str = Field(default="未命名画布", max_length=255)


class CanvasUpdateRequest(BaseModel):
    """画布自动保存请求。"""

    name: str | None = Field(default=None, max_length=255)
    state: dict[str, Any] | None = None
    thumbnail: str | None = None


class CanvasOut(ORMModel):
    """画布输出。"""

    id: str
    project_id: str
    owner_id: str
    name: str
    state: dict[str, Any] | None = None
    thumbnail_url: str | None = None
    share_token: str | None = None
    is_public: bool = False
    created_at: datetime | None = None
    updated_at: datetime | None = None


class CanvasShareOut(BaseModel):
    """画布分享结果。"""

    share_token: str
    url: str


class CanvasUpdateResult(BaseModel):
    """画布保存结果。"""

    updated_at: datetime | None = None
