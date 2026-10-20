"""任务状态机 / 生成编排单测（mock 网关）。"""
from __future__ import annotations

import base64
import io
from datetime import timedelta

import pytest
from PIL import Image
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.asset import Asset
from app.models.generation import GenerationTask
from app.models.user import User
from app.services import generate_service, task_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow


async def make_user(balance: int = 200) -> str:
    """创建激活用户。"""
    async with AsyncSessionLocal() as db:
        user = User(
            id=new_id(),
            email=f"t-{new_id()[:8]}@example.com",
            password_hash="x",
            status="active",
            role="user",
            balance=balance,
        )
        db.add(user)
        await db.commit()
        return user.id


async def balance_of(uid: str) -> int:
    """读取余额。"""
    async with AsyncSessionLocal() as db:
        return int((await db.execute(select(User.balance).where(User.id == uid))).scalar_one())


def _png_b64() -> str:
    """生成一张小 PNG 的 base64。"""
    buf = io.BytesIO()
    Image.new("RGB", (8, 8), color=(0, 128, 255)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


async def test_create_or_get_idempotent(db):
    """相同幂等键只创建一个任务且只扣费一次。"""
    uid = await make_user(200)
    task1, created1 = await task_service.create_or_get(
        db, uid, "idem-key-1", "generate", "一只猫", {"size": "1024x1024"}, 10, None, None
    )
    assert created1 is True
    task2, created2 = await task_service.create_or_get(
        db, uid, "idem-key-1", "generate", "一只猫", {"size": "1024x1024"}, 10, None, None
    )
    assert created2 is False
    assert task1.id == task2.id
    assert await balance_of(uid) == 190


async def test_concurrency_limit(db, monkeypatch):
    """超过并发上限抛 TASK_LIMIT_EXCEEDED。"""
    original = task_service.config_service.get_value
    async def configured_limit(db, key, default=None):
        return 2 if key == "MAX_ACTIVE_TASKS_PER_USER" else await original(db, key, default)
    monkeypatch.setattr(task_service.config_service, "get_value", configured_limit)
    uid = await make_user(200)
    await task_service.create_or_get(db, uid, "k1", "generate", "p", {}, 10, None, None)
    await task_service.create_or_get(db, uid, "k2", "generate", "p", {}, 10, None, None)
    with pytest.raises(AppError) as exc:
        await task_service.create_or_get(db, uid, "k3", "generate", "p", {}, 10, None, None)
    assert exc.value.code == ErrorCode.TASK_LIMIT_EXCEEDED


async def test_pause_resume_cancel(db):
    """running→paused；paused 不再支持「继续」（resume 会二次 dispatch 上游）；cancel 回滚预扣。"""
    uid = await make_user(200)
    task, _ = await task_service.create_or_get(
        db, uid, "k-pause", "generate", "p", {}, 10, None, None
    )
    paused = await task_service.pause(db, uid, task.id)
    assert paused.status == "paused"

    # 产品口径：上游是同步长请求，没有真挂起能力，resume 会让同一任务双跑 → 禁止
    with pytest.raises(AppError) as exc:
        await task_service.resume(db, uid, task.id)
    assert exc.value.code == ErrorCode.TASK_STATE_CONFLICT

    cancelled = await task_service.cancel(db, uid, task.id)
    assert cancelled.status == "cancelled"
    assert await balance_of(uid) == 200  # 未完成不扣费


async def test_reclaim_covers_paused(db):
    """paused 也必须被回收：否则会永久滞留、预扣停在 processing。"""
    uid = await make_user(200)
    task, _ = await task_service.create_or_get(
        db, uid, "k-paused-orphan", "generate", "p", {}, 10, None, None
    )
    await task_service.pause(db, uid, task.id)
    task.last_activity_at = utcnow() - timedelta(seconds=9999)
    await db.commit()

    count = await task_service.reclaim_orphans(db)
    assert count >= 1
    refreshed = await task_service.get_task(db, uid, task.id)
    assert refreshed.status == "timeout"
    assert await balance_of(uid) == 200


async def test_pause_invalid_transition(db):
    """已取消任务不能暂停 → TASK_STATE_CONFLICT。"""
    uid = await make_user(200)
    task, _ = await task_service.create_or_get(
        db, uid, "k-cancel", "generate", "p", {}, 10, None, None
    )
    await task_service.cancel(db, uid, task.id)
    with pytest.raises(AppError) as exc:
        await task_service.pause(db, uid, task.id)
    assert exc.value.code == ErrorCode.TASK_STATE_CONFLICT


async def test_reclaim_orphans(db):
    """无进展超时任务被回收并回滚。"""
    uid = await make_user(200)
    task, _ = await task_service.create_or_get(
        db, uid, "k-orphan", "generate", "p", {}, 10, None, None
    )
    task.last_activity_at = utcnow() - timedelta(seconds=999)
    await db.commit()

    count = await task_service.reclaim_orphans(db)
    assert count == 1
    refreshed = (
        await db.execute(select(GenerationTask).where(GenerationTask.id == task.id))
    ).scalar_one()
    assert refreshed.status == "timeout"
    assert await balance_of(uid) == 200


async def test_paused_not_counted_in_concurrency(db):
    """paused 不占并发配额：暂停后可再创建新任务。"""
    uid = await make_user(200)
    t1, _ = await task_service.create_or_get(db, uid, "pc1", "generate", "p", {}, 10, None, None)
    await task_service.create_or_get(db, uid, "pc2", "generate", "p", {}, 10, None, None)
    await task_service.pause(db, uid, t1.id)  # 释放一个并发槽
    t3, created = await task_service.create_or_get(db, uid, "pc3", "generate", "p", {}, 10, None, None)
    assert created is True and t3.status == "running"


async def test_idempotency_window_recreate(db):
    """窗口内 replay；窗口外且已终态视为新任务。"""
    uid = await make_user(200)
    t1, c1 = await task_service.create_or_get(db, uid, "win", "generate", "p", {}, 10, None, None)
    assert c1 is True

    # 窗口内重复 → replay
    t2, c2 = await task_service.create_or_get(db, uid, "win", "generate", "p", {}, 10, None, None)
    assert c2 is False and t2.id == t1.id

    # 置为终态 + 超窗 → 可再次创建
    t1.status = "succeeded"
    t1.result_seen = True
    t1.created_at = utcnow() - timedelta(seconds=400)
    await db.commit()

    t3, c3 = await task_service.create_or_get(db, uid, "win", "generate", "p", {}, 10, None, None)
    assert c3 is True and t3.id != t1.id


async def test_run_task_success(monkeypatch):
    """成功路径：落资产库、确认扣费、标记未读。"""
    uid = await make_user(200)

    async def fake_generations(payload):
        return {"data": [{"b64_json": _png_b64()}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )

    async with AsyncSessionLocal() as db:
        task, _ = await generate_service.create_image_task(
            db,
            uid,
            prompt="日落",
            model="gpt-image-2",
            size="1024x1024",
            quality="standard",
            n=1,
            session_id=None,
            canvas_id=None,
            idempotency_key="k-run",
        )
        task_id = task.id

    await generate_service.run_task(task_id)

    async with AsyncSessionLocal() as db:
        refreshed = (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one()
        assert refreshed.status == "succeeded"
        assert refreshed.result_urls
        assert refreshed.result_seen is False
        assets = (
            await db.execute(select(Asset).where(Asset.generation_task_id == task_id))
        ).scalars().all()
        assert len(assets) == 1
    assert await balance_of(uid) == 190  # 成功才扣费


async def test_run_task_failure_refunds(monkeypatch):
    """失败路径：不扣费。"""
    uid = await make_user(200)

    async def fake_generations(payload):
        raise AppError(ErrorCode.UPSTREAM_ERROR, "上游繁忙")

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )

    async with AsyncSessionLocal() as db:
        task, _ = await generate_service.create_image_task(
            db,
            uid,
            prompt="失败",
            model="gpt-image-2",
            size="1024x1024",
            quality="standard",
            n=1,
            session_id=None,
            canvas_id=None,
            idempotency_key="k-fail",
        )
        task_id = task.id

    await generate_service.run_task(task_id)

    async with AsyncSessionLocal() as db:
        refreshed = (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one()
        assert refreshed.status == "failed"
        assert refreshed.error_code == "UPSTREAM_ERROR"
    assert await balance_of(uid) == 200
