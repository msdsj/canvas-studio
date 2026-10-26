"""生图 Schema。"""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class ImageGenerationRequest(BaseModel):
    """文生图请求。"""

    model_config = ConfigDict(extra="allow")

    prompt: str = ""
    model: str = "gpt-image-2"
    n: int = 1
    size: str = "1024x1024"
    quality: str = "standard"
    response_format: str = "b64_json"
    pool_batch_id: str = Field(default="", max_length=200)
    pool_task_id: str = Field(default="", max_length=200)
    pool_batch_total: int = Field(default=1, ge=1, le=32)
    # Multi-output compose requests must keep the strict account-routing
    # contract all the way through the generation endpoint.
    pool_strict: bool = False
