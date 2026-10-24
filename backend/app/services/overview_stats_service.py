"""后台概览统计：总量指标、趋势、最近动态、待处理事项。

所有趋势都是「单条 SQL 按天 GROUP BY + 内存补零」，不按天循环查库。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.audit import AuditLog
from app.models.quota import QuotaTransaction
from app.models.user import User
from app.services.usage_stats_service import (
    DEFAULT_DAYS,
    INFLOW_TYPES,
    REFUNDED,
    consume_conditions,
)
from app.utils.ids import to_iso
from app.utils.timeframe import date_range, group_by_day, utc_start

#: 「最近动态」条数
RECENT_LIMIT = 6
#: 大额额度变动阈值：低于此数不进动态（否则刷屏）
BIG_ADJUST_THRESHOLD = 500

#: 审计 action → 中文说明（前端直接展示，不出现英文枚举）
_ACTION_LABELS: dict[str, str] = {
    "pool_import": "导入号池账号",
    "pool_delete": "移除号池账号",
    "pool_refresh": "刷新号池账号",
    "user_create": "新建用户",
    "user_ban": "封禁用户",
    "user_unban": "解除封禁",
    "user_reset_password": "重置用户密码",
    "user_resend_verification": "重发验证邮件",
    "quota_adjust": "调整用户额度",
    "pro_code_create": "生成 Pro 激活码",
    "pro_code_delete": "删除 Pro 激活码",
    "pro_redeem": "用户激活 Pro",
    "config_update": "修改系统配置",
    "team_create": "创建团队",
    "team_member_add": "添加团队成员",
}


def _kind_of(action: str) -> str:
    """审计行为 → 前端动态分类（user / quota / pool / audit）。"""
    if action.startswith("pool_"):
        return "pool"
    if action.startswith("quota_"):
        return "quota"
    if action.startswith(("user_", "pro_", "team_")):
        return "user"
    return "audit"


def _audit_text(log: AuditLog) -> str:
    """审计行 → 一句人话。"""
    label = _ACTION_LABELS.get(log.action, log.action)
    return f"{log.actor_email or '系统'} {label}"


async def daily_series(db: AsyncSession, days: int = DEFAULT_DAYS) -> list[dict[str, Any]]:
    """最近 `days` 天的用户新增 / 图片产出 / 积分消耗（缺失的天补 0）。"""
    dates = date_range(days)
    start = utc_start(dates[0])

    users_new = await group_by_day(
        db, User.created_at, func.count(), [User.created_at >= start]
    )
    # 图片产出量用 assets：一行 = 一张图；generation_tasks 只给「任务数」，
    # 一次任务出多图时会少算。
    images = await group_by_day(
        db,
        Asset.created_at,
        func.count(),
        [
            Asset.created_at >= start,
            Asset.kind == "generated",
            Asset.deleted_at.is_(None),
        ],
    )
    quota = await group_by_day(
        db,
        QuotaTransaction.created_at,
        func.coalesce(func.sum(func.abs(QuotaTransaction.amount)), 0),
        consume_conditions(start),
    )

    return [
        {
            "date": day.isoformat(),
            "users_new": users_new.get(day.isoformat(), 0),
            "images": images.get(day.isoformat(), 0),
            "quota": quota.get(day.isoformat(), 0),
        }
        for day in dates
    ]


async def recent_activity(db: AsyncSession, limit: int = RECENT_LIMIT) -> list[dict[str, Any]]:
    """最近动态：审计日志 + 新用户注册 + 大额额度变动。

    三条查询各取 `limit` 条后在内存合并排序 —— SQL 条数固定，与动态条数无关。
    """
    limit = max(1, min(limit, 20))
    events: list[tuple[datetime, str, str]] = []

    audits = (
        await db.execute(select(AuditLog).order_by(AuditLog.created_at.desc()).limit(limit * 2))
    ).scalars().all()
    for log in audits:
        # 额度调整下面用流水行呈现（带准确金额），审计行会与之重复
        if log.action == "quota_adjust":
            continue
        events.append((log.created_at, _kind_of(log.action), _audit_text(log)))

    users = (
        await db.execute(select(User).order_by(User.created_at.desc()).limit(limit))
    ).scalars().all()
    for user in users:
        events.append((user.created_at, "user", f"新用户 {user.email} 注册"))

    adjustments = (
        await db.execute(
            select(QuotaTransaction)
            .where(
                QuotaTransaction.type.in_(INFLOW_TYPES),
                QuotaTransaction.status != REFUNDED,
                func.abs(QuotaTransaction.amount) >= BIG_ADJUST_THRESHOLD,
            )
            .order_by(QuotaTransaction.created_at.desc())
            .limit(limit)
        )
    ).scalars().all()
    for tx in adjustments:
        note = f"（{tx.note}）" if tx.note else ""
        events.append((tx.created_at, "quota", f"额度变动 {tx.amount:+d}{note}"))

    events.sort(key=lambda item: item[0], reverse=True)
    return [{"at": to_iso(at), "kind": kind, "text": text} for at, kind, text in events[:limit]]


async def pending_counts(db: AsyncSession, pool: dict[str, Any] | None = None) -> dict[str, int]:
    """待处理事项：未验证用户 + 号池异常 / 受限账号数。"""
    users_pending = int(
        (
            await db.execute(
                select(func.count())
                .select_from(User)
                .where(User.status == "pending_verification")
            )
        ).scalar()
        or 0
    )
    pool = pool or {}
    return {
        "users_pending_verification": users_pending,
        "pool_abnormal": int(pool.get("abnormal") or 0),
        "pool_limited": int(pool.get("limited") or 0),
    }


async def admin_overview(
    db: AsyncSession, pool: dict[str, Any] | None = None, days: int = DEFAULT_DAYS
) -> dict[str, Any]:
    """后台概览全量数据。

    `pool` 由调用方注入（要访问网关，不在统计服务里做）。
    `quota_consumed_today` 直接取趋势最后一天：卡片与图表必须同口径同数据。
    """
    days = max(1, min(days, 90))
    series = await daily_series(db, days)
    users_total = int(
        (await db.execute(select(func.count()).select_from(User))).scalar() or 0
    )
    users_active = int(
        (
            await db.execute(
                select(func.count()).select_from(User).where(User.status == "active")
            )
        ).scalar()
        or 0
    )
    return {
        "users_total": users_total,
        "users_active": users_active,
        "pool": pool or {},
        "quota_consumed_today": series[-1]["quota"] if series else 0,
        "series": series,
        "recent": await recent_activity(db),
        "pending": await pending_counts(db, pool),
    }
