"""额度服务：预扣 / 确认 / 幂等回滚 / 管理员调整 / 流水。

账本唯一真源。核心保证：
- 余额不为负（条件 UPDATE 原子扣减，防并发超扣）；
- `(ref_id,type)` 唯一，回滚幂等（同一 ref 只回滚一次）；
- 预扣(processing) → 成功确认(success) / 未完成回滚(refunded)。

团队共享额度池
--------------
`team` 参数非空**且** `team.shared_quota()` 为真时，扣减/回滚发生在 `teams.balance` 上，
流水行同时记录 `team_id`（动的是谁的池）与 `user_id`（谁花的）。回滚时按流水行上的
`team_id` 反查，因此同一条流水无论从哪个入口回滚，账都不会串到个人余额上。
"""
from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quota import QuotaTransaction
from app.models.team import Team
from app.models.user import User
from app.services import config_service, usage_stats_service
from app.services.usage_stats_service import CONSUME_TYPES
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id

# 说明：`CONSUME_TYPES` 定义在 `usage_stats_service`（统计口径的唯一来源），
# 这里 re-export，历史调用方（如 team_service）继续 `quota_service.CONSUME_TYPES` 即可。


async def _balance(db: AsyncSession, user_id: str) -> int:
    """读取用户当前余额。"""
    result = await db.execute(select(User.balance).where(User.id == user_id))
    return int(result.scalar_one())


async def _team_balance(db: AsyncSession, team_id: str) -> int:
    """读取团队共享池余额。"""
    result = await db.execute(select(Team.balance).where(Team.id == team_id))
    return int(result.scalar_one())


def _pool_team(team: Team | None) -> Team | None:
    """只有开启共享池的团队才接管扣费，否则沿用成员个人余额。"""
    if team is None or not team.shared_quota():
        return None
    return team


async def get_account(db: AsyncSession, user: User, team: Team | None = None) -> dict:
    """返回额度账户视图。

    `team` 传入且启用共享池时，`balance` 是团队池余额，并额外给出 `team_id` /
    `team_balance`，前端据此显示「团队共享额度」而不是个人额度。

    统计字段（累计获得 / 累计消耗 / 趋势 / 类型分布）全部来自
    `usage_stats_service.quota_summary`：口径只有一份，避免「概览和用量页两个数字打架」。
    注意 `total_granted` 恒为**个人**累计入账，即使余额显示的是团队池余额。
    """
    summary = await usage_stats_service.quota_summary(db, user)
    pool = _pool_team(team)
    balance = team.balance if pool is not None else user.balance
    return {
        "balance": balance,
        "threshold_pct": int(await config_service.get_value(db, "QUOTA_WARN_PCT", 20)),
        "total_granted": summary["total_granted"],
        "total_consumed": summary["total_consumed"],
        "series": summary["series"],
        "by_type": summary["by_type"],
        "prices": await config_service.prices(db),
        "pool": (
            {
                "scope": "team",
                "team_id": pool.id,
                "team_name": pool.name,
                "team_balance": pool.balance,
                "personal_balance": user.balance,
            }
            if pool is not None
            else {"scope": "personal", "team_id": None, "team_balance": None,
                  "personal_balance": user.balance}
        ),
    }


async def pre_deduct(
    db: AsyncSession,
    user_id: str,
    tx_type: str,
    cost: int,
    ref_id: str,
    note: str = "",
    team: Team | None = None,
) -> QuotaTransaction:
    """预扣额度：条件 UPDATE 原子扣减，余额不足抛 QUOTA_INSUFFICIENT。

    团队共享池开启时扣团队余额；池余额不足**不**自动回落个人余额——
    静默换账本会让管理员完全看不懂费用从哪出的，宁可明确报「额度不够」。
    """
    if cost <= 0:
        raise AppError(ErrorCode.VALIDATION_ERROR, "消耗额度必须大于 0")
    pool = _pool_team(team)
    if pool is not None:
        result = await db.execute(
            update(Team)
            .where(Team.id == pool.id, Team.balance >= cost)
            .values(balance=Team.balance - cost)
        )
    else:
        result = await db.execute(
            update(User)
            .where(User.id == user_id, User.balance >= cost)
            .values(balance=User.balance - cost)
        )
    if result.rowcount == 0:
        await db.rollback()
        raise AppError(ErrorCode.QUOTA_INSUFFICIENT)
    balance_after = (
        await _team_balance(db, pool.id) if pool is not None else await _balance(db, user_id)
    )
    tx = QuotaTransaction(
        id=new_id(),
        user_id=user_id,
        team_id=pool.id if pool is not None else None,
        type=tx_type,
        amount=-cost,
        status="processing",
        ref_id=ref_id,
        balance_after=balance_after,
        note=note,
    )
    db.add(tx)
    await db.flush()
    return tx


async def confirm(db: AsyncSession, ref_id: str) -> QuotaTransaction | None:
    """确认预扣（任务成功）：processing → success。"""
    result = await db.execute(
        select(QuotaTransaction).where(
            QuotaTransaction.ref_id == ref_id,
            QuotaTransaction.status == "processing",
        )
    )
    tx = result.scalars().first()
    if tx is None:
        return None
    tx.status = "success"
    await db.flush()
    return tx


async def refund(db: AsyncSession, ref_id: str) -> QuotaTransaction | None:
    """幂等回滚预扣：仅对处于 processing 的消耗流水生效，重复调用安全。"""
    result = await db.execute(
        select(QuotaTransaction).where(
            QuotaTransaction.ref_id == ref_id,
            QuotaTransaction.type.in_(CONSUME_TYPES),
        )
    )
    tx = result.scalars().first()
    if tx is None:
        return None
    if tx.status == "refunded":
        return tx  # 已回滚，幂等返回
    if tx.status == "success":
        return tx  # 已确认成功，不再回滚（保护）
    refund_amount = -tx.amount
    if tx.team_id:
        await db.execute(
            update(Team).where(Team.id == tx.team_id).values(balance=Team.balance + refund_amount)
        )
        tx.status = "refunded"
        tx.balance_after = await _team_balance(db, tx.team_id)
    else:
        await db.execute(
            update(User).where(User.id == tx.user_id).values(balance=User.balance + refund_amount)
        )
        tx.status = "refunded"
        tx.balance_after = await _balance(db, tx.user_id)
    await db.flush()
    return tx


async def grant(
    db: AsyncSession,
    user_id: str,
    amount: int,
    note: str = "",
    ref_id: str | None = None,
    tx_type: str = "grant",
    team: Team | None = None,
) -> QuotaTransaction:
    """发放额度（初始赠送 / 管理员增加 / 团队充值）。

    `team` 非空即向团队共享池充值（不受 `shared_quota` 开关影响：
    管理员给团队充值是显式动作，开关只决定「扣费时走哪个池」）。
    """
    if team is not None:
        await db.execute(
            update(Team).where(Team.id == team.id).values(balance=Team.balance + amount)
        )
        balance_after = await _team_balance(db, team.id)
    else:
        await db.execute(
            update(User).where(User.id == user_id).values(balance=User.balance + amount)
        )
        balance_after = await _balance(db, user_id)
    tx = QuotaTransaction(
        id=new_id(),
        user_id=user_id,
        team_id=team.id if team is not None else None,
        type=tx_type,
        amount=amount,
        status="success",
        ref_id=ref_id or new_id(),
        balance_after=balance_after,
        note=note,
    )
    db.add(tx)
    await db.flush()
    return tx


async def admin_adjust(
    db: AsyncSession,
    user: User,
    mode: str,
    amount: int,
    note: str,
    operator_id: str,
) -> tuple[int, QuotaTransaction]:
    """管理员调整额度：increase | decrease | set。"""
    if mode == "increase":
        await db.execute(update(User).where(User.id == user.id).values(balance=User.balance + amount))
        delta = amount
    elif mode == "decrease":
        result = await db.execute(
            update(User)
            .where(User.id == user.id, User.balance >= amount)
            .values(balance=User.balance - amount)
        )
        if result.rowcount == 0:
            await db.rollback()
            raise AppError(ErrorCode.VALIDATION_ERROR, "扣减后余额不能为负")
        delta = -amount
    elif mode == "set":
        old = await _balance(db, user.id)
        await db.execute(update(User).where(User.id == user.id).values(balance=amount))
        delta = amount - old
    else:
        raise AppError(ErrorCode.VALIDATION_ERROR, "mode 必须是 increase|decrease|set")

    balance_after = await _balance(db, user.id)
    tx = QuotaTransaction(
        id=new_id(),
        user_id=user.id,
        type="admin_adjust",
        amount=delta,
        status="success",
        ref_id=new_id(),
        operator_id=operator_id,
        balance_after=balance_after,
        note=note,
    )
    db.add(tx)
    await db.flush()
    return balance_after, tx


async def list_transactions(
    db: AsyncSession, user_id: str, page: int, size: int, tx_type: str | None = None
) -> tuple[list[QuotaTransaction], int]:
    """分页查询用户额度流水。"""
    conditions = [QuotaTransaction.user_id == user_id]
    if tx_type:
        conditions.append(QuotaTransaction.type == tx_type)
    base = select(QuotaTransaction).where(*conditions)
    total = int(
        (
            await db.execute(
                select(func.count()).select_from(base.order_by(None).subquery())
            )
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(QuotaTransaction.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    return list(result.scalars().all()), total
