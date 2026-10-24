"""生成队列：把「同时打上游」的并发压到可控水位。

为什么需要
----------
每个生图任务都是 10–60 秒的长请求。以前 `BackgroundTasks` 直接开跑，
20 个用户同时提交就是 20 条并发上游连接 + 20 份图片解码内存，
上游限流时全部一起超时，用户看到的是「全失败」而不是「稍等」。

现在的语义
----------
- 进程内 FIFO 排队（`asyncio.Semaphore` 本身是公平的：先 await 先拿锁）；
- 超出并发上限的任务状态仍是 `running`，但进度置为「排队中」，
  前端据此显示「前面还有 N 个任务」；
- 队列满（等待数 > `image_queue_max`）直接拒绝，避免内存里堆无限等待的协程。

边界
----
- **多进程部署时是「每进程一个池」**：uvicorn --workers=4 且 `image_concurrency=4`
  意味着全局最多 16 条并发。这是有意为之：进程间共享信号量要引入 Redis，
  而本项目当前是单机部署，进程内池已经能把「上游被打爆」的风险压住。
- 信号量绑定事件循环：测试里每个用例一个新 loop，所以按 loop 重建。
"""
from __future__ import annotations

import asyncio
import contextlib
from collections import deque
from typing import Any, AsyncIterator

from app.config import settings
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.queue_service")

_semaphore: asyncio.Semaphore | None = None
_loop_token: int | None = None
_waiting: deque[str] = deque()
_active: dict[str, None] = {}


def _limit() -> int:
    return max(1, int(settings.image_concurrency or 1))


def _sem() -> asyncio.Semaphore:
    """按事件循环惰性创建信号量（测试/重载时 loop 会换）。"""
    global _semaphore, _loop_token
    loop = asyncio.get_running_loop()
    token = id(loop)
    if _semaphore is None or _loop_token != token:
        _semaphore = asyncio.Semaphore(_limit())
        _loop_token = token
        _waiting.clear()
        _active.clear()
    return _semaphore


def position(task_id: str) -> int:
    """当前排队位次（1 起）；不在队列里返回 0。"""
    try:
        return _waiting.index(task_id) + 1
    except ValueError:
        return 0


@contextlib.asynccontextmanager
async def slot(task_id: str) -> AsyncIterator[int]:
    """占用一个执行位。产出值是「入队时的排队位次」，0 表示无需等待。"""
    sem = _sem()
    ahead = 0
    if sem.locked():
        if len(_waiting) >= max(1, int(settings.image_queue_max)):
            raise AppError(ErrorCode.RATE_LIMITED, "生成任务排得太多了，等前面的跑完再试")
        _waiting.append(task_id)
        ahead = position(task_id)
        logger.info("任务排队 task=%s 位次=%s", task_id, ahead)
    try:
        await sem.acquire()
    except asyncio.CancelledError:
        with contextlib.suppress(ValueError):
            _waiting.remove(task_id)
        raise
    with contextlib.suppress(ValueError):
        _waiting.remove(task_id)
    _active[task_id] = None
    try:
        yield ahead
    finally:
        _active.pop(task_id, None)
        sem.release()


def snapshot() -> dict[str, Any]:
    """队列水位快照（给前端与运维看）。"""
    return {
        "limit": _limit(),
        "active": len(_active),
        "waiting": len(_waiting),
        "waiting_tasks": list(_waiting)[:20],
        "available": max(0, _limit() - len(_active)),
    }
