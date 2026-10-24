"""APScheduler 定时任务：号池自动刷新、孤儿任务回收、临时文件清理、网关配置同步。"""
from __future__ import annotations

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from app.config import settings
from app.database import AsyncSessionLocal
from app.services import config_service, pool_service, pro_service, storage_service, task_service
from app.utils.logging import get_logger

logger = get_logger("app.scheduler")

_scheduler: AsyncIOScheduler | None = None


async def _reclaim_job() -> None:
    """孤儿任务回收：超时 running/queued → timeout + 幂等回滚。"""
    async with AsyncSessionLocal() as db:
        count = await task_service.reclaim_orphans(db)
    if count:
        logger.info("孤儿任务回收：%s 个任务已超时回滚", count)


async def _config_sync_job() -> None:
    """周期同步网关配置：网关重启后运行时配置会丢失（内部令牌/上游地址/Key/Demo 模式），
    靠本任务在 60s 内自动恢复，避免网关重启后图片 provider 配置暂时丢失。"""
    async with AsyncSessionLocal() as db:
        await config_service.push_to_gateway(db)


async def _pool_refresh_job() -> None:
    """号池定时刷新。"""
    await pool_service.auto_refresh_all()


async def _cleanup_job() -> None:
    """清理残留临时文件。"""
    removed = storage_service.cleanup_temp_files()
    if removed:
        logger.info("临时文件清理：删除 %s 个文件", removed)


async def _pro_expiry_job() -> None:
    """Pro 到期降级：role 改回 user 即同时回收页面与功能权限。"""
    async with AsyncSessionLocal() as db:
        await pro_service.downgrade_expired(db)


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
    scheduler.add_job(
        _config_sync_job,
        "interval",
        seconds=60,
        id="gateway_config_sync",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    # Pro 到期：每分钟扫一次，保证「时间一到就变 Free」不会拖太久
    scheduler.add_job(
        _pro_expiry_job,
        "interval",
        seconds=60,
        id="pro_expiry",
        replace_existing=True,
        coalesce=True,
        max_instances=1,
    )
    scheduler.start()
    _scheduler = scheduler
    logger.info("调度器已启动：孤儿回收/%ss，号池刷新/%smin，网关配置同步/60s", settings.task_orphan_scan_seconds, settings.pool_autorefresh_minutes)
    return scheduler


def shutdown_scheduler() -> None:
    """停止调度器。"""
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
        logger.info("调度器已停止")
