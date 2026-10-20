"""审计服务：记录关键动作到 `audit_logs`。"""
from __future__ import annotations

from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog
from app.models.user import User


async def log(
    db: AsyncSession,
    *,
    action: str,
    actor: User | None = None,
    actor_id: str | None = None,
    actor_email: str = "",
    target_type: str = "",
    target_id: str | None = None,
    detail: dict[str, Any] | None = None,
    ip: str = "",
    team_id: str | None = None,
) -> AuditLog:
    """写入一条审计日志。

    `team_id` 非空表示这是一条**团队内**的操作记录，团队审计页只查自己团队的，
    平台审计页则能看到全部——企业客户要能自查「谁动了我的模型配置」。
    """
    entry = AuditLog(
        actor_id=actor.id if actor else actor_id,
        actor_email=actor.email if actor else actor_email,
        action=action,
        target_type=target_type,
        target_id=target_id,
        detail=detail or {},
        ip=ip,
        team_id=team_id,
    )
    db.add(entry)
    await db.flush()
    return entry


async def list_logs(
    db: AsyncSession,
    page: int,
    size: int,
    actor: str | None = None,
    action: str | None = None,
) -> tuple[list[AuditLog], int]:
    """分页查询审计日志。"""
    conditions = []
    if actor:
        conditions.append(AuditLog.actor_email.like(f"%{actor}%"))
    if action:
        conditions.append(AuditLog.action == action)
    base = select(AuditLog)
    if conditions:
        base = base.where(*conditions)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(AuditLog.created_at.desc()).offset((page - 1) * size).limit(size)
    )
    return list(result.scalars().all()), total
