"""生图 Schema。"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ImageGenerationRequest(BaseModel):
    """文生图请求。"""

    model_config = ConfigDict(extra="allow")

    prompt: str = ""
    model: str = "gpt-image-2"
    n: int = 1
    size: str = "1024x1024"
    quality: str = "standard"
    response_format: str = "b64_json"
