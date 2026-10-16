"""通用 Schema：统一响应包裹与分页。"""
from __future__ import annotations

from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    """统一响应包裹 `{code,data,message}`。"""

    code: str = "OK"
    data: T | None = None
    message: str = "OK"


class PageData(BaseModel, Generic[T]):
    """分页数据。"""

    items: list[T] = Field(default_factory=list)
    total: int = 0
    page: int = 1
    size: int = 20


class ORMModel(BaseModel):
    """可从 ORM 对象构造的基类。"""

    model_config = ConfigDict(from_attributes=True)


class MessageOnly(BaseModel):
    """仅含 message 的简单响应。"""

    message: str = "OK"


def as_dict(obj: Any) -> Any:
    """把 pydantic 模型或任意对象转为可序列化结构。"""
    if isinstance(obj, BaseModel):
        return obj.model_dump()
    return obj
