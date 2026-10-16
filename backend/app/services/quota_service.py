"""额度服务：预扣 / 确认 / 幂等回滚 / 管理员调整 / 流水。

账本唯一真源。核心保证：
- 余额不为负（条件 UPDATE 原子扣减，防并发超扣）；
- `(ref_id,type)` 唯一，回滚幂等（同一 ref 只回滚一次）；
- 预扣(processing) → 成功确认(success) / 未完成回滚(refunded)。
"""
from __future__ import annotations

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quota import QuotaTransaction
from app.models.user import User
from app.services import config_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id

CONSUME_TYPES = ("consume_image", "consume_edit", "consume_chat")


async def _balance(db: AsyncSession, user_id: str) -> int:
    """读取用户当前余额。"""
    result = await db.execute(select(User.balance).where(User.id == user_id))
    return int(result.scalar_one())


async def get_account(db: AsyncSession, user: User) -> dict:
    """返回额度账户视图。"""
    total_granted = int(
        (
            await db.execute(
                select(func.coalesce(func.sum(QuotaTransaction.amount), 0)).where(
                    QuotaTransaction.user_id == user.id,
                    QuotaTransaction.type == "grant",
                )
            )
        ).scalar()
        or 0
    )
    return {
        "balance": user.balance,
        "threshold_pct": int(await config_service.get_value(db, "QUOTA_WARN_PCT", 20)),
        "total_granted": total_granted,
        "prices": await config_service.prices(db),
    }


async def pre_deduct(
    db: AsyncSession,
    user_id: str,
    tx_type: str,
    cost: int,
    ref_id: str,
    note: str = "",
) -> QuotaTransaction:
    """预扣额度：条件 UPDATE 原子扣减，余额不足抛 QUOTA_INSUFFICIENT。"""
    if cost <= 0:
        raise AppError(ErrorCode.VALIDATION_ERROR, "消耗额度必须大于 0")
    result = await db.execute(
        update(User)
        .where(User.id == user_id, User.balance >= cost)
        .values(balance=User.balance - cost)
    )
    if result.rowcount == 0:
        await db.rollback()
        raise AppError(ErrorCode.QUOTA_INSUFFICIENT)
    balance_after = await _balance(db, user_id)
    tx = QuotaTransaction(
        id=new_id(),
        user_id=user_id,
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
) -> QuotaTransaction:
    """发放额度（初始赠送 / 管理员增加）。"""
    await db.execute(
        update(User).where(User.id == user_id).values(balance=User.balance + amount)
    )
    balance_after = await _balance(db, user_id)
    tx = QuotaTransaction(
        id=new_id(),
        user_id=user_id,
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


async def consumed_today(db: AsyncSession) -> int:
    """统计今日消耗总额（供后台概览）。"""
    from datetime import date, datetime, time

    from app.utils.ids import utcnow

    today = utcnow().date()
    start = datetime.combine(today, time.min)
    stmt = select(func.coalesce(func.sum(func.abs(QuotaTransaction.amount)), 0)).where(
        QuotaTransaction.type.in_(CONSUME_TYPES),
        QuotaTransaction.created_at >= start,
    )
    return int((await db.execute(stmt)).scalar() or 0)
