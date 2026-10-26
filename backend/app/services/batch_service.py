"""Preflight whole output batches before creating any billable image task."""
import asyncio
from sqlalchemy import select
from app.models.user import User
from app.services import config_service, task_service
from app.config import settings
from app.utils.errors import AppError, ErrorCode


async def preflight(db, user_id: str, count: int, cost: int) -> str:
    """Validate a whole output batch and return its routing mode.

    ``local`` means this gateway can reserve one credential per output.  The
    ``upstream`` mode is also safe to run concurrently: the configured image
    upstream owns the ChatGPT account picker and will choose an account for
    each independent request.  It cannot promise a stable account assignment,
    so callers use strict reservations only for the local mode.
    """
    limit = int(await config_service.get_value(db, "MAX_ACTIVE_TASKS_PER_USER", settings.max_active_tasks_per_user))
    active = await task_service.count_active(db, user_id)
    if active + count > limit:
        raise AppError(ErrorCode.TASK_LIMIT_EXCEEDED, f"本次需 {count} 个独立任务，当前可用 {max(0, limit-active)} 个；请等待已有任务完成或调整并发上限。本批次尚未提交")
    balance = (await db.execute(select(User.balance).where(User.id == user_id))).scalar_one()
    if balance < cost:
        raise AppError(ErrorCode.QUOTA_INSUFFICIENT, f"本次 {count} 项产出需 {cost} 额度，余额不足；本批次尚未提交")
    from app.services.gateway_client import gateway_client
    try:
        # 容量接口在本地池为空时会回源查上游账号数（网关侧有 10s 缓存，
        # 但首次仍可能打一次上游），3 秒偏紧，容易在冷启动时被误判成「拿不到容量」。
        capacity = await asyncio.wait_for(gateway_client.pool_capacity(), timeout=6)
    except (AppError, asyncio.TimeoutError) as exc:
        if count > 1:
            raise AppError(ErrorCode.POOL_UNAVAILABLE, "暂时无法确认中转站的独立账号容量，本批次尚未提交；请检查网关或稍后重试") from exc
        return "unknown"
    # 容量分两种模式：
    # - local   ：本地池里是 sk- 类 Key，能保证「每个任务用不同账号」；
    # - upstream：账号由上游调度，只能报告健康数量，不能按任务预留具体账号。
    # 老网关没有 routing_mode：按 independent_routing 推断，宁可保守也不放行
    # 未确认的容量（历史上这里的误判会直接扣费后失败）。
    if capacity.get("routing_mode"):
        mode = str(capacity["routing_mode"])
    elif capacity.get("total") and capacity.get("independent_routing") is True:
        mode = "local"
    elif capacity.get("total") and capacity.get("independent_routing") is False and any(
        capacity.get(key) is not None
        for key in ("upstream_total", "upstream_healthy", "effective_total", "effective_available")
    ):
        # Older gateways did not include routing_mode.  Only infer upstream
        # when its capacity fields are present; a bare ``independent_routing``
        # flag is not enough to prove that a multi-output request can be
        # scheduled safely.
        mode = "upstream"
    else:
        mode = "none"
    if count > 1 and mode == "none":
        raise AppError(
            ErrorCode.POOL_UNAVAILABLE,
            "号池里还没有可用账号：请到后台「号池」导入账号，或检查图片上游是否在运行；本批次尚未提交",
        )
    if count > 1 and mode == "local" and int(capacity.get("available") or 0) < count:
        raise AppError(
            ErrorCode.POOL_UNAVAILABLE,
            f"本次需要 {count} 个不同账号，本地号池当前可调度 {int(capacity.get('available') or 0)} 个；请稍后重试。本批次尚未提交",
        )
    if count > 1 and mode == "upstream":
        # Gateway versions expose different names for this snapshot. Prefer
        # the explicit upstream count when present, then fall back to the
        # effective/legacy names.
        if capacity.get("upstream_healthy") is not None:
            upstream_available = int(capacity.get("upstream_healthy") or 0)
        else:
            upstream_available = max(
                (int(capacity.get(key) or 0) for key in ("effective_available", "available", "healthy")),
                default=0,
            )
        if upstream_available < count:
            raise AppError(
                ErrorCode.POOL_UNAVAILABLE,
                f"本次需要 {count} 个可用上游账号，上游号池当前报告 {upstream_available} 个健康账号；本批次尚未提交",
            )
        # The upstream owns the actual credential round-robin.  Returning the
        # mode lets dispatchers omit local strict leases while still fanning out
        # one request per planned output.
    return mode
