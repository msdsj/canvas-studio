"""用量（额度）统计：口径常量 + 汇总。

口径（改之前先读）
------------------
1. 金额方向：`consume_*` 记负、`grant` / `admin_adjust` 记正。
2. `status='refunded'` 的消耗已把额度退回余额，统计时排除，
   否则「已消耗」会虚高（回滚一次被重复计一次）。
3. 团队池：`team_id` 非空的流水动的是 `teams.balance`，仍记在发起人名下。
   - 「消耗」算该用户发起的全部消耗（含团队池代付）——这是使用量；
   - 「累计获得」只算个人入账，团队充值属于团队的池子。
"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quota import QuotaTransaction
from app.models.user import User
from app.utils.timeframe import date_range, group_by_day, utc_start

#: 消耗类流水（口径唯一来源：`quota_service` 从这里 re-export，避免两处漂移）
CONSUME_TYPES: tuple[str, ...] = ("consume_image", "consume_edit", "consume_chat")
#: 正向入账类流水
INFLOW_TYPES: tuple[str, ...] = ("grant", "admin_adjust")
#: 已退还：既不是消耗也不是入账
REFUNDED = "refunded"
#: 默认趋势天数
DEFAULT_DAYS = 14


def consume_conditions(
    start: datetime | None = None,
    *,
    user_id: str | None = None,
    personal_only: bool = False,
) -> list[Any]:
    """「消耗」口径的唯一过滤条件。"""
    conditions: list[Any] = [
        QuotaTransaction.type.in_(CONSUME_TYPES),
        QuotaTransaction.status != REFUNDED,
    ]
    if start is not None:
        conditions.append(QuotaTransaction.created_at >= start)
    if user_id is not None:
        conditions.append(QuotaTransaction.user_id == user_id)
    if personal_only:
        conditions.append(QuotaTransaction.team_id.is_(None))
    return conditions


async def consumed_total(
    db: AsyncSession, user_id: str, *, personal_only: bool = False
) -> int:
    """用户累计消耗（绝对值之和）。"""
    stmt = select(func.coalesce(func.sum(func.abs(QuotaTransaction.amount)), 0)).where(
        *consume_conditions(user_id=user_id, personal_only=personal_only)
    )
    return int((await db.execute(stmt)).scalar() or 0)


async def inflow_total(db: AsyncSession, user_id: str) -> int:
    """用户累计入账（grant + admin_adjust 正向，不含团队池）。"""
    stmt = select(func.coalesce(func.sum(QuotaTransaction.amount), 0)).where(
        QuotaTransaction.user_id == user_id,
        QuotaTransaction.team_id.is_(None),
        QuotaTransaction.type.in_(INFLOW_TYPES),
        QuotaTransaction.amount > 0,
        QuotaTransaction.status != REFUNDED,
    )
    return int((await db.execute(stmt)).scalar() or 0)


async def total_granted(db: AsyncSession, user: User) -> int:
    """累计获得额度（「用量」页的 Total granted）。

    取「流水入账」与「余额 + 个人消耗」的较大值：
    - 前者是账本口径，可审计；
    - 后者能把**没有流水记录的历史初始余额**算进来（例如 seed 直接把 balance
      写成 200 而没写 grant 行），否则页面会出现「累计获得 0、余额 11504」
      这种自相矛盾的数字。
    账本完整时两者相等，只有账本不完整时后者更大。
    """
    inflow = await inflow_total(db, user.id)
    personal_consumed = await consumed_total(db, user.id, personal_only=True)
    return max(inflow, int(user.balance) + personal_consumed)


async def quota_summary(db: AsyncSession, user: User, days: int = DEFAULT_DAYS) -> dict[str, Any]:
    """用量页数据：余额 / 累计获得 / 累计消耗 / 14 天趋势 / 按类型分布。"""
    days = max(1, min(days, 90))
    dates = date_range(days)
    start = utc_start(dates[0])

    consumed_by_day = await group_by_day(
        db,
        QuotaTransaction.created_at,
        func.coalesce(func.sum(func.abs(QuotaTransaction.amount)), 0),
        consume_conditions(start, user_id=user.id),
    )
    granted_by_day = await group_by_day(
        db,
        QuotaTransaction.created_at,
        func.coalesce(func.sum(QuotaTransaction.amount), 0),
        [
            QuotaTransaction.created_at >= start,
            QuotaTransaction.user_id == user.id,
            QuotaTransaction.team_id.is_(None),
            QuotaTransaction.type.in_(INFLOW_TYPES),
            QuotaTransaction.amount > 0,
            QuotaTransaction.status != REFUNDED,
        ],
    )

    type_rows = (
        await db.execute(
            select(
                QuotaTransaction.type,
                func.count(),
                func.coalesce(func.sum(QuotaTransaction.amount), 0),
                func.coalesce(func.sum(func.abs(QuotaTransaction.amount)), 0),
            )
            .where(
                QuotaTransaction.user_id == user.id,
                QuotaTransaction.status != REFUNDED,
            )
            .group_by(QuotaTransaction.type)
            .order_by(func.count().desc())
        )
    ).all()

    return {
        "balance": int(user.balance),
        "total_granted": await total_granted(db, user),
        "total_consumed": await consumed_total(db, user.id),
        "series": [
            {
                "date": day.isoformat(),
                "consumed": consumed_by_day.get(day.isoformat(), 0),
                "granted": granted_by_day.get(day.isoformat(), 0),
            }
            for day in dates
        ],
        "by_type": [
            {
                "type": str(row[0]),
                "count": int(row[1] or 0),
                # 账本口径：消耗为负、入账为正
                "amount": int(row[2] or 0),
                # 绝对发生额：画柱状图/饼图直接可用，前端不用再取符号
                "abs_amount": int(row[3] or 0),
            }
            for row in type_rows
        ],
    }
