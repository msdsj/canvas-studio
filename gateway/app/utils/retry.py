"""重试退避工具：仅对幂等安全请求重试（指数退避 + 抖动）。"""
from __future__ import annotations

import asyncio
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

import httpx

from app.config import settings

T = TypeVar("T")

# 可重试异常：连接失败 / 超时（幂等请求下安全重试）
RETRYABLE = (httpx.ConnectError, httpx.TimeoutException, httpx.ConnectTimeout, httpx.ReadTimeout)


async def with_retry(
    func: Callable[[], Awaitable[T]],
    *,
    max_retries: int | None = None,
    base_delay: float = 0.5,
    idempotent: bool = True,
) -> T:
    """执行 func，失败按指数退避重试（仅幂等请求）。"""
    if not idempotent:
        return await func()
    retries = settings.max_retries if max_retries is None else max_retries
    attempt = 0
    while True:
        try:
            return await func()
        except RETRYABLE:
            if attempt >= retries:
                raise
            delay = base_delay * (2 ** attempt) + random.uniform(0, 0.2)
            await asyncio.sleep(delay)
            attempt += 1
