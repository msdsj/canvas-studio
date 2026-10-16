"""通用 Schema。"""
from __future__ import annotations

from typing import Any, Generic, TypeVar

from pydantic import BaseModel

T = TypeVar("T")


class Envelope(BaseModel, Generic[T]):
    """统一响应包裹。"""

    code: str = "OK"
    data: T | None = None
    message: str = "OK"


def ok(data: Any = None, message: str = "OK") -> dict[str, Any]:
    """构造 OK 包裹。"""
    return {"code": "OK", "data": data, "message": message}
