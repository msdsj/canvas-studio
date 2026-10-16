"""APScheduler 定时任务：号池自动刷新、孤儿任务回收、临时文件清理。"""
from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config import settings
from app.database import AsyncSessionLocal
from app.services import pool_service, storage_service, task_service
from app.utils.logging import get_logger

logger = get_logger("app.scheduler")

_scheduler: AsyncIOScheduler | None = None


async def _reclaim_job() -> None:
    """孤儿任务回收：超时 running/queued → timeout + 幂等回滚。"""
    async with AsyncSessionLocal() as db:
        count = await task_service.reclaim_orphans(db)
    if count:
        logger.info("孤儿任务回收：%s 个任务已超时回滚", count)


async def _pool_refresh_job() -> None:
    """号池定时刷新。"""
    await pool_service.auto_refresh_all()


async def _cleanup_job() -> None:
    """清理残留临时文件。"""
    removed = storage_service.cleanup_temp_files()
    if removed:
        logger.info("临时文件清理：删除 %s 个文件", removed)


def get_scheduler() -> AsyncIOScheduler | None:
    """返回当前调度器实例。"""
    return _scheduler


def start_scheduler() -> AsyncIOScheduler:
    """启动调度器并注册周期任务。"""
    global _scheduler
    if _scheduler is not None:
        return _scheduler
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        _reclaim_job,
        "interval",
        seconds=settings.task_orphan_scan_seconds,
        id="reclaim_orphans",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.add_job(
        _pool_refresh_job,
        "interval",
        minutes=settings.pool_autorefresh_minutes,
        id="pool_autorefresh",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.add_job(
        _cleanup_job,
        "interval",
        hours=6,
        id="cleanup_temp",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()
    _scheduler = scheduler
    logger.info("调度器已启动：孤儿回收/%ss，号池刷新/%smin", settings.task_orphan_scan_seconds, settings.pool_autorefresh_minutes)
    return scheduler


def shutdown_scheduler() -> None:
    """停止调度器。"""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("调度器已停止")
