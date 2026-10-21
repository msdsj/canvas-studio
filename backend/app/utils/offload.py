"""事件循环卸载：把阻塞型 CPU / 磁盘操作挪到线程池执行。

为什么需要这个模块
------------------
后端是单进程 asyncio（uvicorn 默认 1 个事件循环）。任何纯 Python / Pillow / 文件
读写调用都**直接占住事件循环**，在它跑完之前整个进程无法处理任何请求 ——
别人的登录、SSE 心跳、轮询接口全部一起卡住。

实测（2026-10-21，构建后并发跑 `_sprite_from_provider`，1254×1254 真实上游产物）：

| 并发数 | 内联执行（阻塞循环） | 线程池（本模块） |
|--------|---------------------|-----------------|
| 4      | 2.22s（循环停 2.2s） | 0.56s |
| 8      | 5.43s（循环停 5.4s） | 0.76s |
| 16     | 9.27s（循环停 9.3s） | 1.78s |

线程池版本还顺带快了 5 倍：多核并行 + 缓存更友好。

约定
----
- **凡是传 bytes 进出、内部只用 Pillow / 文件 IO 的同步函数，一律走这里**。
- 不要每处自己写 `asyncio.to_thread`：统一入口才能统一并发上限与监控。
- 线程池大小默认 = CPU 核数 × 2（Pillow 大量时间在 C 层释放了 GIL，能给到 2 倍收益），
  夹在 [4, 16]；可由 `CS_IMAGE_WORKERS` 覆盖。
"""
from __future__ import annotations

import asyncio
import os
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import Any, TypeVar

from app.config import settings
from app.utils.logging import get_logger

logger = get_logger("app.offload")

T = TypeVar("T")

_executor: ThreadPoolExecutor | None = None


def _resolve_workers() -> int:
    """决定线程池大小：显式配置 > CPU×2 > 夹取 [4, 16]。"""
    configured = int(getattr(settings, "image_workers", 0) or 0)
    if configured > 0:
        return max(1, min(configured, 32))
    return max(4, min((os.cpu_count() or 4) * 2, 16))


def executor() -> ThreadPoolExecutor:
    """返回（惰性创建的）图片处理专用线程池。"""
    global _executor
    if _executor is None:
        workers = _resolve_workers()
        _executor = ThreadPoolExecutor(
            max_workers=workers,
            thread_name_prefix="cs-image",
        )
        logger.info("图片处理线程池已创建：workers=%d", workers)
    return _executor


def shutdown_executor() -> None:
    """关闭线程池（应用退出时调用；测试里也可用它重置状态）。"""
    global _executor
    if _executor is not None:
        _executor.shutdown(wait=False, cancel_futures=True)
        _executor = None


async def run_sync(func: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """在图片专用线程池里执行同步函数，返回其结果。

    支持位置参数与关键字参数（内部用 ``partial`` 绑定，兼容
    ``_resolve_mask_bytes(..., use_uploaded_mask=False)`` 这类调用）。

    :param func: 同步可调用对象（Pillow 处理、文件读写、base64 解码等）
    :return: ``func`` 的返回值；异常原样抛出，由调用方按业务语义处理
    """
    loop = asyncio.get_running_loop()
    call = partial(func, *args, **kwargs) if kwargs else partial(func, *args)
    return await loop.run_in_executor(executor(), call)


async def to_png_async(func: Callable[..., bytes], data: bytes, /, *args: Any) -> bytes:
    """``run_sync`` 的常见形态：bytes 进、bytes 出的图片转换。"""
    return await run_sync(func, data, *args)
