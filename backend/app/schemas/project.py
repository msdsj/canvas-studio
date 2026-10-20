"""项目相关 Schema。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class ProjectCreateRequest(BaseModel):
    """新建项目请求。"""

    name: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=1024)
    # 团队里新建项目时，默认是否直接共享给团队（不传则保持私有）
    share_with_team: bool = False


class ProjectUpdateRequest(BaseModel):
    """更新项目请求。"""

    name: str | None = Field(default=None, min_length=1, max_length=255)


class ProjectOut(ORMModel):
    """项目输出。"""

    id: str
    owner_id: str
    name: str
    description: str
    thumbnail_url: str | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
