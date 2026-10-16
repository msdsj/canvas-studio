"""生成（生图/编辑）相关 Schema。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class GenerateImageRequest(BaseModel):
    """文生图请求。"""

    prompt: str = Field(min_length=1, max_length=4000)
    model: str = Field(default="gpt-image-2", max_length=64)
    size: str = Field(default="1024x1024", max_length=32)
    quality: str = Field(default="standard", max_length=16)  # standard | hd
    n: int = Field(default=1, ge=1, le=4)
    session_id: str | None = None
    canvas_id: str | None = None
    params: dict[str, Any] = Field(default_factory=dict)


class GenerateEditParams(BaseModel):
    """图生图/编辑参数（multipart 表单承载）。"""

    prompt: str = Field(min_length=1, max_length=4000)
    model: str = Field(default="gpt-image-2", max_length=64)
    size: str = Field(default="1024x1024", max_length=32)
    base_asset_id: str | None = None
    session_id: str | None = None
    canvas_id: str | None = None
