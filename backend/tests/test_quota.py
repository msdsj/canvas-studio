"""额度服务单测：预扣 / 确认 / 幂等回滚 / 管理员调整 / 并发防超扣。"""
from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.user import User
from app.services import quota_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id


async def make_user(balance: int = 100) -> str:
    """直接创建激活用户。"""
    async with AsyncSessionLocal() as db:
        user = User(
            id=new_id(),
            email=f"q-{new_id()[:8]}@example.com",
            password_hash="x",
            status="active",
            role="user",
            balance=balance,
        )
        db.add(user)
        await db.commit()
        return user.id


async def fetch_user(db, uid: str) -> User:
    """读取用户。"""
    return (await db.execute(select(User).where(User.id == uid))).scalar_one()


async def test_pre_deduct_confirm(db):
    """预扣 → 确认：余额减少，流水为 success。"""
    uid = await make_user(100)
    await quota_service.pre_deduct(db, uid, "consume_image", 30, ref_id="task-1")
    await db.commit()
    user = await fetch_user(db, uid)
    assert user.balance == 70

    tx = await quota_service.confirm(db, "task-1")
    await db.commit()
    assert tx is not None and tx.status == "success"
    assert (await fetch_user(db, uid)).balance == 70


async def test_refund_is_idempotent(db):
    """回滚仅生效一次：重复回滚不改动余额。"""
    uid = await make_user(100)
    await quota_service.pre_deduct(db, uid, "consume_image", 30, ref_id="task-2")
    await db.commit()
    await quota_service.refund(db, "task-2")
    await db.commit()
    first = (await fetch_user(db, uid)).balance
    assert first == 100
    await quota_service.refund(db, "task-2")
    await db.commit()
    assert (await fetch_user(db, uid)).balance == 100


async def test_insufficient_raises(db):
    """余额不足抛 QUOTA_INSUFFICIENT，且不扣减。"""
    uid = await make_user(10)
    with pytest.raises(AppError) as exc:
        await quota_service.pre_deduct(db, uid, "consume_image", 50, ref_id="task-3")
    assert exc.value.code == ErrorCode.QUOTA_INSUFFICIENT
    assert (await fetch_user(db, uid)).balance == 10


async def test_admin_adjust_modes(db):
    """管理员调整：increase / decrease / set。"""
    uid = await make_user(100)
    user = await fetch_user(db, uid)
    balance, _ = await quota_service.admin_adjust(db, user, "increase", 50, "补偿", "admin")
    await db.commit()
    assert balance == 150

    balance, _ = await quota_service.admin_adjust(db, user, "decrease", 30, "扣减", "admin")
    await db.commit()
    assert balance == 120

    balance, _ = await quota_service.admin_adjust(db, user, "set", 5, "重置", "admin")
    await db.commit()
    assert balance == 5


async def test_admin_decrease_below_zero_rejected(db):
    """扣减到负值被拒绝。"""
    uid = await make_user(10)
    user = await fetch_user(db, uid)
    with pytest.raises(AppError) as exc:
        await quota_service.admin_adjust(db, user, "decrease", 20, "扣减", "admin")
    assert exc.value.code == ErrorCode.VALIDATION_ERROR


async def test_concurrent_pre_deduct_no_overdraw():
    """并发预扣不超扣：100 额度、每笔 30、4 并发 → 仅 3 笔成功。"""
    uid = await make_user(100)

    async def attempt(ref: str) -> bool:
        async with AsyncSessionLocal() as session:
            try:
                await quota_service.pre_deduct(session, uid, "consume_image", 30, ref_id=ref)
                await session.commit()
                return True
            except AppError:
                await session.rollback()
                return False

    results = await asyncio.gather(*[attempt(f"c-{i}") for i in range(4)])
    async with AsyncSessionLocal() as session:
        user = (await session.execute(select(User).where(User.id == uid))).scalar_one()
    assert sum(results) == 3
    assert user.balance == 10
