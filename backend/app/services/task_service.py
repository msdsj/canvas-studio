"""任务服务：生成任务状态机（创建/幂等/暂停/恢复/取消/进度/孤儿回收）。

状态机：`queued → running → (paused) → cancelled|succeeded|failed|timeout`。
仅 backend 写入；`(user_id, idempotency_key)` 唯一去重。
"""
from __future__ import annotations

from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.generation import GenerationTask
from app.models.team import Team
from app.services import config_service, quota_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow

# 合法状态迁移表
# paused 不再提供「继续」入口：上游是同步长请求，resume 会二次 dispatch 导致同一任务双跑，
# 因此 paused 只允许走向终态（cancelled / timeout）。
_TRANSITIONS: dict[str, set[str]] = {
    "queued": {"running", "cancelled", "timeout"},
    "running": {"paused", "succeeded", "failed", "timeout", "cancelled"},
    "paused": {"cancelled", "timeout"},
    "succeeded": set(),
    "failed": set(),
    "cancelled": set(),
    "timeout": set(),
}

ACTIVE_STATUSES = ("queued", "running", "paused")
CONCURRENCY_STATUSES = ("queued", "running")  # paused 不计入并发

# 列表页要取的列。
# ⚠️ 必须包含 `params`：结果卡片要从里面读 size/model/n/batch_* /region_indexes。
# 但**不要 select 整个实体**——ORM 实例化在 16 并发下慢 3.8 倍（见 list_tasks 文档）。
# ⚠️ 必须覆盖 `GenerationTaskOut` 的**全部必填字段**（当前只有 `idempotency_key`）。
#    漏一列就会在 `model_validate` 时抛 ValidationError → 整个 /api/generate/tasks 500，
#    而前端在不停轮询这个接口。加列后请跑一次 `pytest tests/test_task_list_contract.py`。
_LIST_COLUMNS = (
    GenerationTask.id,
    GenerationTask.user_id,
    GenerationTask.session_id,
    GenerationTask.canvas_id,
    GenerationTask.type,
    GenerationTask.prompt,
    GenerationTask.params,
    GenerationTask.status,
    GenerationTask.progress,
    GenerationTask.result_urls,
    GenerationTask.cost,
    GenerationTask.upstream_task_id,
    GenerationTask.demo,
    GenerationTask.idempotency_key,
    GenerationTask.paused_at,
    GenerationTask.timeout_at,
    GenerationTask.error_code,
    GenerationTask.error_message,
    GenerationTask.last_activity_at,
    GenerationTask.result_seen,
    GenerationTask.created_at,
    GenerationTask.updated_at,
)
TERMINAL_STATUSES = ("succeeded", "failed", "cancelled", "timeout")

_CONSUME_TYPE = {"generate": "consume_image", "edit": "consume_edit"}


def _check_transition(current: str, target: str) -> None:
    """校验状态迁移合法性。

    错误文案不得包含内部状态名（paused / running 等），否则会原样落到用户界面上。
    """
    if target not in _TRANSITIONS.get(current, set()):
        raise AppError(ErrorCode.TASK_STATE_CONFLICT, "这一步已经做过了，刷新看看最新进度")


async def find_by_idem(db: AsyncSession, user_id: str, key: str) -> GenerationTask | None:
    """按幂等键查找任务。"""
    result = await db.execute(
        select(GenerationTask).where(
            GenerationTask.user_id == user_id, GenerationTask.idempotency_key == key
        )
    )
    return result.scalar_one_or_none()


async def count_active(db: AsyncSession, user_id: str) -> int:
    """统计活跃（queued+running）任务数，用于并发上限。"""
    result = await db.execute(
        select(func.count()).where(
            GenerationTask.user_id == user_id,
            GenerationTask.status.in_(CONCURRENCY_STATUSES),
        )
    )
    return int(result.scalar() or 0)


async def create_or_get(
    db: AsyncSession,
    user_id: str,
    idempotency_key: str,
    task_type: str,
    prompt: str,
    params: dict,
    cost: int,
    session_id: str | None,
    canvas_id: str | None,
    team: Team | None = None,
) -> tuple[GenerationTask, bool]:
    """幂等创建任务（含去重窗口语义）。

    去重规则（`CS_IDEMPOTENCY_WINDOW_SECONDS`，默认 300s）：
    - 同键命中且窗口内 → 直接 replay 既有任务（不重复扣费/调上游）；
    - 同键命中且窗口外但任务仍在进行中（queued/running/paused）→ 仍 replay，绝不重复创建；
    - 同键命中且窗口外且任务已终态 → 视为新任务：为旧键打墓碑释放唯一键，重新创建。

    返回 (task, created)。
    """
    existing = await find_by_idem(db, user_id, idempotency_key)
    if existing is not None:
        window = int(settings.idempotency_window_seconds)
        within_window = (utcnow() - existing.created_at) <= timedelta(seconds=window)
        if within_window or existing.status in ACTIVE_STATUSES:
            return existing, False
        # 窗口外且已终态：旧键迁移为墓碑，腾出唯一键以便作为新任务再次创建
        existing.idempotency_key = f"{idempotency_key}#stale#{existing.id}"
        await db.flush()

    limit = int(
        await config_service.get_value(db, "MAX_ACTIVE_TASKS_PER_USER", settings.max_active_tasks_per_user)
    )
    if await count_active(db, user_id) >= limit:
        raise AppError(
            ErrorCode.TASK_LIMIT_EXCEEDED,
            f"已有 {limit} 个任务进行中，请稍候或先取消",
        )

    task_id = new_id()
    consume_type = _CONSUME_TYPE.get(task_type, "consume_image")
    if cost > 0:
        await quota_service.pre_deduct(
            db,
            user_id,
            consume_type,
            cost,
            ref_id=task_id,
            note=f"{task_type}:{prompt[:40]}",
            team=team,
        )

    task = GenerationTask(
        id=task_id,
        user_id=user_id,
        session_id=session_id,
        canvas_id=canvas_id,
        # 任务打上团队标记：团队用量统计与「谁花了团队额度」的对账都靠它
        team_id=team.id if team is not None else None,
        type=task_type,
        prompt=prompt,
        params=params,
        status="running",
        progress=0,
        result_urls=[],
        cost=cost,
        idempotency_key=idempotency_key,
        last_activity_at=utcnow(),
    )
    db.add(task)
    try:
        await db.commit()
    except IntegrityError:
        # 并发竞争：唯一约束兜底 → 回滚预扣并返回既有任务
        await db.rollback()
        again = await find_by_idem(db, user_id, idempotency_key)
        if again is None:
            raise AppError(ErrorCode.INTERNAL_ERROR, "任务创建失败，请重试")
        return again, False
    await db.refresh(task)
    return task, True


async def clone_for_retry(
    db: AsyncSession,
    user_id: str,
    task_id: str,
    *,
    idempotency_key: str,
    team: Team | None = None,
) -> tuple[GenerationTask, bool]:
    """把失败/超时的任务复制成一个新任务（重新扣费、重新执行）。

    为什么复制而不是复用原任务：原任务的 `idempotency_key` 与预扣流水都已成历史，
    就地重置会让「重试成功」和「首次成功」在账单上无法区分，也让幂等语义失效。
    复制一份新任务，历史记录保持完整，用户看到的是一条新的执行记录。
    """
    source = await get_task(db, user_id, task_id)
    if source.status not in ("failed", "timeout", "cancelled"):
        raise AppError(ErrorCode.TASK_STATE_CONFLICT, "这个任务还没结束，不用重试")
    params = dict(source.params or {})
    cost = int(source.cost or 0)
    return await create_or_get(
        db,
        user_id,
        idempotency_key,
        source.type,
        source.prompt,
        params,
        cost,
        source.session_id,
        source.canvas_id,
        team=team,
    )


async def get_task(db: AsyncSession, user_id: str, task_id: str) -> GenerationTask:
    """获取任务并校验归属。"""
    result = await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
    task = result.scalar_one_or_none()
    if task is None:
        raise AppError(ErrorCode.TASK_NOT_FOUND)
    if task.user_id != user_id:
        raise AppError(ErrorCode.FORBIDDEN, "无权访问该任务")
    return task


async def list_active(db: AsyncSession, user_id: str) -> list[GenerationTask]:
    """列出活跃任务（queued/running/paused）。

    ⚠️ 高频接口：前端 `useActiveTasks` 每 3s 轮询一次（`use-active-tasks.ts`），
    是全站 QPS 最高的读路径。这里保留实体返回（调用方要拿属性访问，且活跃任务
    通常 0~2 条，实体化成本可忽略）；真正的成本在 `_LIST_COLUMNS` 那条分页查询上。
    """
    result = await db.execute(
        select(GenerationTask)
        .where(GenerationTask.user_id == user_id, GenerationTask.status.in_(ACTIVE_STATUSES))
        .order_by(GenerationTask.created_at.desc())
    )
    return list(result.scalars().all())


async def list_unread(db: AsyncSession, user_id: str) -> list[GenerationTask]:
    """列出已完成但未读结果的任务（前端每 6s 轮询）。"""
    result = await db.execute(
        select(GenerationTask)
        .where(
            GenerationTask.user_id == user_id,
            GenerationTask.status == "succeeded",
            GenerationTask.result_seen.is_(False),
        )
        .order_by(GenerationTask.created_at.desc())
    )
    return list(result.scalars().all())


async def list_tasks(
    db: AsyncSession,
    user_id: str,
    page: int,
    size: int,
    canvas_id: str | None = None,
    session_id: str | None = None,
    status: str | None = None,
) -> tuple[list[dict[str, Any]], int]:
    """分页查询生成历史，返回**普通 dict 列表**（不是 ORM 实体）。

    性能说明（2026-10-21 实测，16 并发）
    -----------------------------------
    | 查询方式                          | 吞吐    |
    |-----------------------------------|---------|
    | `select(GenerationTask)` 整行实体化 |  471/s  |
    | 只取列 → `dict`（本实现）           | 1774/s  |

    慢 3.8 倍全在 ORM 实例化：identity map 登记、属性 instrumentation、
    大字段（`params` 里塞着 ops/thinking/引导图 URL）反序列化。
    列表页只是把数据交给 Pydantic 出 JSON，不需要实体身份，
    所以直接返回 dict —— `GenerationTaskOut.model_validate(dict)` 同样工作。
    """
    conditions = [GenerationTask.user_id == user_id]
    if canvas_id:
        conditions.append(GenerationTask.canvas_id == canvas_id)
    if session_id:
        conditions.append(GenerationTask.session_id == session_id)
    if status:
        conditions.append(GenerationTask.status == status)

    total_stmt = select(func.count()).select_from(GenerationTask).where(*conditions)
    page_stmt = (
        select(*_LIST_COLUMNS)
        .where(*conditions)
        .order_by(GenerationTask.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    total = int((await db.execute(total_stmt)).scalar() or 0)
    rows = (await db.execute(page_stmt)).all()
    return [dict(row._mapping) for row in rows], total


async def pause(db: AsyncSession, user_id: str, task_id: str) -> GenerationTask:
    """软暂停任务（不强行中断上游）。"""
    task = await get_task(db, user_id, task_id)
    _check_transition(task.status, "paused")
    task.status = "paused"
    task.paused_at = utcnow()
    task.last_activity_at = utcnow()
    await db.commit()
    await db.refresh(task)
    return task


async def resume(db: AsyncSession, user_id: str, task_id: str) -> GenerationTask:
    """恢复任务：暂停 → 运行（上游已终止时由编排层重新提交，复用预扣）。"""
    task = await get_task(db, user_id, task_id)
    _check_transition(task.status, "running")
    task.status = "running"
    task.paused_at = None
    task.last_activity_at = utcnow()
    await db.commit()
    await db.refresh(task)
    return task


async def cancel(db: AsyncSession, user_id: str, task_id: str) -> GenerationTask:
    """取消任务并幂等回滚预扣（未完成绝不扣费）。"""
    task = await get_task(db, user_id, task_id)
    if task.status in TERMINAL_STATUSES:
        if task.status == "cancelled":
            return task
        raise AppError(ErrorCode.TASK_STATE_CONFLICT, "任务已结束，无法取消")
    _check_transition(task.status, "cancelled")
    task.status = "cancelled"
    task.last_activity_at = utcnow()
    await quota_service.refund(db, task.id)
    await db.commit()
    await db.refresh(task)
    return task


async def mark_progress(
    db: AsyncSession,
    task_id: str,
    progress: int,
    upstream_task_id: str | None = None,
) -> None:
    """更新任务进度与上游任务 id（刷新续接依据）。"""
    task = (await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))).scalar_one_or_none()
    if task is None:
        return
    task.progress = max(0, min(100, int(progress)))
    if upstream_task_id:
        task.upstream_task_id = upstream_task_id
    task.last_activity_at = utcnow()
    await db.flush()


async def succeed(
    db: AsyncSession,
    task_id: str,
    result_urls: list,
    demo: bool = False,
    progress: int = 100,
) -> GenerationTask | None:
    """任务成功：置 succeeded + 标记未读 + 确认预扣（仅成功才扣费）。"""
    task = (await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))).scalar_one_or_none()
    if task is None:
        return None
    if task.status != "running":
        return task
    task.status = "succeeded"
    task.progress = progress
    task.result_urls = result_urls
    task.demo = demo
    task.result_seen = False
    task.last_activity_at = utcnow()
    await quota_service.confirm(db, task.id)
    await db.commit()
    await db.refresh(task)
    return task


async def fail_and_refund(
    db: AsyncSession, task_id: str, error_code: str, error_message: str = ""
) -> GenerationTask | None:
    """任务失败：置 failed + 幂等回滚（未完成不扣费）。"""
    task = (await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))).scalar_one_or_none()
    if task is None:
        return None
    if task.status in TERMINAL_STATUSES:
        return task
    task.status = "failed"
    task.error_code = error_code
    task.error_message = error_message[:1024]
    task.last_activity_at = utcnow()
    await quota_service.refund(db, task.id)
    await db.commit()
    await db.refresh(task)
    return task


async def mark_seen(db: AsyncSession, user_id: str, task_id: str) -> GenerationTask:
    """标记结果已读（清除未读提醒）。"""
    task = await get_task(db, user_id, task_id)
    task.result_seen = True
    await db.commit()
    await db.refresh(task)
    return task


async def reclaim_orphans(db: AsyncSession) -> int:
    """孤儿回收：无进展超时的 queued/running/paused 任务 → timeout + 幂等回滚。

    paused 虽不计并发，但必须一起回收：否则历史暂停任务会永久滞留，
    预扣额度停在 processing 且永远出现在 /api/tasks/active 轮询结果里。
    """
    threshold = utcnow() - timedelta(seconds=settings.task_timeout_seconds)
    result = await db.execute(
        select(GenerationTask).where(
            GenerationTask.status.in_(ACTIVE_STATUSES),
            GenerationTask.last_activity_at < threshold,
        )
    )
    tasks = list(result.scalars().all())
    for task in tasks:
        task.status = "timeout"
        task.timeout_at = utcnow()
        task.error_code = "TASK_TIMEOUT"
        task.error_message = "任务超时未完成，已自动回收"
        task.last_activity_at = utcnow()
        await quota_service.refund(db, task.id)
    if tasks:
        await db.commit()
    return len(tasks)
