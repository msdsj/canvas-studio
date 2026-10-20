"""资产相关 Schema。"""
from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


class AssetOut(ORMModel):
    """资产输出。"""

    id: str
    owner_id: str
    team_id: str | None = None
    visibility: str = "private"
    kind: str
    url: str
    thumb_url: str | None = None
    width: int = 0
    height: int = 0
    size_bytes: int = 0
    mime: str = "image/png"
    source_prompt: str = ""
    is_demo: bool = False
    generation_task_id: str | None = None
    created_at: datetime | None = None


class AssetVisibilityRequest(BaseModel):
    """批量设置资产可见性。"""

    ids: list[str] = Field(default_factory=list)
    visibility: str = Field(default="private", pattern="^(private|team)$")
