"""系统配置相关 Schema。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class ConfigItemOut(BaseModel):
    """配置项输出（secret 掩码）。"""

    key: str
    value: str
    value_type: str
    is_secret: bool
    category: str
    description: str = ""
    updated_at: datetime | None = None


class ConfigUpdateRequest(BaseModel):
    """配置更新请求（键值对）。"""

    values: dict[str, Any] = Field(default_factory=dict)


class ConfigTestRequest(BaseModel):
    """连通性测试请求。"""

    target: str = Field(description="text | image | llm | pool | proxy")


class ConfigTestResult(BaseModel):
    """连通性测试结果。"""

    ok: bool
    latency_ms: int = 0
    message: str = ""
