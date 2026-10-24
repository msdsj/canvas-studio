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
        # 容量接口在本地池为空时会回源查上游账号数（网关侧有 10s 缓存，
        # 但首次仍可能打一次上游），3 秒偏紧，容易在冷启动时被误判成「拿不到容量」。
        capacity = await asyncio.wait_for(gateway_client.pool_capacity(), timeout=6)
    except (AppError, asyncio.TimeoutError) as exc:
        if count > 1:
            raise AppError(ErrorCode.POOL_UNAVAILABLE, "暂时无法确认中转站的独立账号容量，本批次尚未提交；请检查网关或稍后重试") from exc
        return
    # 容量分两种模式：
    # - local   ：本地池里是 sk- 类 Key，能保证「每个任务用不同账号」；
    # - upstream：账号在 chatgpt2api 里，由它自己排队调度（常见于导入 ChatGPT 凭据）。
    # 以前只认 local，导致「导了 4 个号、却因为本地池 0 而拒绝出 2 张图」。
    # 老网关没有 routing_mode：按 independent_routing 推断，宁可保守也不放行
    # 未确认的容量（历史上这里的误判会直接扣费后失败）。
    if capacity.get("routing_mode"):
        mode = str(capacity["routing_mode"])
    elif capacity.get("total") and capacity.get("independent_routing") is True:
        mode = "local"
    elif capacity.get("total") and capacity.get("independent_routing") is False:
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
    if count > 1 and mode == "upstream" and int(capacity.get("upstream_healthy") or 0) == 0:
        raise AppError(
            ErrorCode.POOL_UNAVAILABLE,
            "图片上游号池当前没有健康账号：请到后台「号池」刷新额度或重新登录；本批次尚未提交",
        )
