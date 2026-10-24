"""时间窗口工具：UTC 存储 + 本地时区切天。

数据库里的时间一律以 **UTC naive** 落库（见 `app.utils.ids.utcnow`），
而业务口径按服务器时区 `+08:00` 切天。这里集中放三件事：

1. 本地日期 ↔ UTC 查询窗口的换算（`local_today` / `utc_start` / `date_range`）；
2. SQL 侧的「按天」表达式（`day_expr`）：先 `+8 hours` 再取日期字符串；
3. 单条 SQL 按天聚合（`group_by_day`），供各统计模块复用。

为什么不各处自己算：偏移量写错一次，趋势图就会整体错一格，
且「晚上 20:00 之后的事件算到昨天」这种偏差肉眼几乎看不出来。
"""
from __future__ import annotations

from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Sequence

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

#: 服务器时区偏移（小时）
LOCAL_TZ_OFFSET_HOURS = 8


def local_today() -> date:
    """服务器时区（+08:00）下的「今天」。"""
    return (datetime.now(timezone.utc) + timedelta(hours=LOCAL_TZ_OFFSET_HOURS)).date()


def utc_start(day: date) -> datetime:
    """本地某天 00:00 对应的 UTC naive 时间（查询窗口左边界）。"""
    return datetime.combine(day, time.min) - timedelta(hours=LOCAL_TZ_OFFSET_HOURS)


def date_range(days: int) -> list[date]:
    """最近 `days` 天的本地日期列表（含今天，时间正序）。"""
    today = local_today()
    return [today - timedelta(days=days - 1 - offset) for offset in range(days)]


def day_expr(db: AsyncSession, column: Any) -> Any:
    """按服务器时区切天的 SQL 表达式（返回 'YYYY-MM-DD'）。

    SQLite 用 `strftime` 平移后取日期；其它方言退化为按库本地时区切天
    （本项目 DB 锁死 SQLite，换库时需要在这里补时区转换）。
    """
    bind = db.get_bind()
    dialect = getattr(getattr(bind, "dialect", None), "name", "sqlite")
    if dialect == "sqlite":
        return func.strftime("%Y-%m-%d", column, f"+{LOCAL_TZ_OFFSET_HOURS} hours")
    return func.date(column)


async def group_by_day(
    db: AsyncSession, column: Any, value: Any, conditions: Sequence[Any]
) -> dict[str, int]:
    """单条 SQL 按天聚合，返回 `{'YYYY-MM-DD': int}`。

    调用方只该调一次，然后给缺失的日期补 0 —— 按天循环查库（14 天 14 条 SQL）
    是这类统计最典型的 N+1。
    """
    day = day_expr(db, column).label("day")
    stmt = select(day, value.label("value")).where(*conditions).group_by("day")
    rows = (await db.execute(stmt)).all()
    return {str(row[0]): int(row[1] or 0) for row in rows if row[0] is not None}
