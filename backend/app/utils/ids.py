"""ID 与时间工具。"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone


def new_id() -> str:
    """生成 UUIDv4 字符串主键。"""
    return str(uuid.uuid4())


def utcnow() -> datetime:
    """返回当前 UTC 时间（naive，统一以 UTC 存储）。"""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def to_iso(dt: datetime | None) -> str | None:
    """把 datetime 序列化为 ISO-8601 UTC 字符串。"""
    if dt is None:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).isoformat()
