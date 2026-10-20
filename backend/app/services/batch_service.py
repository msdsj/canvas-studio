"""Preflight whole output batches before creating any billable image task."""
import asyncio
from sqlalchemy import select
from app.models.user import User
from app.services import config_service, task_service
from app.config import settings
from app.utils.errors import AppError, ErrorCode


async def preflight(db, user_id: str, count: int, cost: int) -> None:
    limit = int(await config_service.get_value(db, "MAX_ACTIVE_TASKS_PER_USER", settings.max_active_tasks_per_user))
    active = await task_service.count_active(db, user_id)
    if active + count > limit:
        raise AppError(ErrorCode.TASK_LIMIT_EXCEEDED, f"本次需 {count} 个独立任务，当前可用 {max(0, limit-active)} 个；请等待已有任务完成或调整并发上限。本批次尚未提交")
    balance = (await db.execute(select(User.balance).where(User.id == user_id))).scalar_one()
    if balance < cost:
        raise AppError(ErrorCode.QUOTA_INSUFFICIENT, f"本次 {count} 项产出需 {cost} 额度，余额不足；本批次尚未提交")
    from app.services.gateway_client import gateway_client
    try:
        capacity = await asyncio.wait_for(gateway_client.pool_capacity(), timeout=3)
    except (AppError, asyncio.TimeoutError) as exc:
        if count > 1:
            raise AppError(ErrorCode.POOL_UNAVAILABLE, "暂时无法确认中转站的独立账号容量，本批次尚未提交；请检查网关或稍后重试") from exc
        return
    if count > 1 and (not capacity.get("total") or capacity.get("independent_routing") is not True):
        raise AppError(ErrorCode.POOL_UNAVAILABLE, "当前中转站未提供按账号路由能力，无法保证本批次使用不同账号。请配置可独立路由的账号池后重试；本批次尚未提交")
    if capacity.get("total") and int(capacity.get("available") or 0) < count:
        raise AppError(ErrorCode.POOL_UNAVAILABLE, f"本次需要 {count} 个不同账号，当前可调度 {int(capacity.get('available') or 0)} 个；请稍后重试。本批次尚未提交")
