"""分页工具。"""
from __future__ import annotations

from typing import Any, Sequence

from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

DEFAULT_PAGE_SIZE = 20
MAX_PAGE_SIZE = 100


def normalize_page(page: int | None, size: int | None) -> tuple[int, int]:
    """规整分页参数：page 从 1 起，size 介于 1~100。"""
    page = page if page and page > 0 else 1
    size = size if size and size > 0 else DEFAULT_PAGE_SIZE
    size = min(size, MAX_PAGE_SIZE)
    return page, size


def paginated(items: Sequence[Any], total: int, page: int, size: int) -> dict[str, Any]:
    """构造分页响应结构 `{items,total,page,size}`。"""
    return {"items": list(items), "total": total, "page": page, "size": size}


async def paginate_query(
    db: AsyncSession,
    stmt: Select[Any],
    page: int | None,
    size: int | None,
) -> tuple[list[Any], int, int, int]:
    """对 SELECT 语句执行分页：返回 (rows, total, page, size)。"""
    page, size = normalize_page(page, size)
    count_stmt = select(func.count()).select_from(stmt.order_by(None).subquery())
    total = int((await db.execute(count_stmt)).scalar() or 0)
    result = await db.execute(stmt.offset((page - 1) * size).limit(size))
    rows = list(result.scalars().all())
    return rows, total, page, size
