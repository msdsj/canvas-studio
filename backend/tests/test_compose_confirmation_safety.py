"""Confirmation claims and refunded-batch retries must not double bill or drop outputs."""
import asyncio

from app.database import AsyncSessionLocal
from app.models.skill import SkillRun
from app.services import compose_service, generate_service
from app.services.gateway_client import gateway_client
from app.utils.errors import AppError, ErrorCode
from tests.test_intent_batch_safety import _snapshot
from tests.test_intent_flow import prepare


async def setup_confirmation(client, monkeypatch):
    headers, session, uid, _, before = await prepare(client)
    spawned = []

    async def capacity():
        return {"total": 12, "available": 12, "independent_routing": True}

    async def stats():
        return {"total": 12, "normal": 12}

    monkeypatch.setattr(gateway_client, "pool_capacity", capacity)
    monkeypatch.setattr(compose_service, "_pool_capacity", stats)
    monkeypatch.setattr(compose_service, "_spawn_run", spawned.append)
    async with AsyncSessionLocal() as db:
        run = SkillRun(
            user_id=uid, session_id=session, skill_id=compose_service.SKILL_COMPOSE,
            status="clarify", image_count=2, input={"content": "做两张水彩风景插画"},
            plan={"image_refs": [], "size": "1024x1024"},
            options=[
                {"id": "spring", "label": "春日", "image_count": 2,
                 "prompt": "绘制春日樱花风景插画，水彩风格，柔和自然光，主体清晰，构图简洁"},
                {"id": "summer", "label": "夏日", "image_count": 1,
                 "prompt": "绘制夏日海边风景插画，水彩风格，柔和自然光，主体清晰，构图简洁"},
            ],
        )
        db.add(run)
        await db.commit()
        return headers, uid, before, f"/api/chat/runs/{run.id}/confirm", spawned


async def test_concurrent_compose_choices_claim_once_and_repeated_confirm_is_free(client, monkeypatch):
    headers, uid, before, endpoint, spawned = await setup_confirmation(client, monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()
    real_create = generate_service.create_image_task

    async def create(*args, **kwargs):
        entered.set()
        await release.wait()
        return await real_create(*args, **kwargs)

    monkeypatch.setattr(generate_service, "create_image_task", create)
    first = asyncio.create_task(client.post(endpoint, headers=headers, json={"option_id": "spring", "selection_fingerprint": ""}))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        second = await client.post(endpoint, headers=headers, json={"option_id": "summer", "selection_fingerprint": ""})
        assert second.status_code == 409, second.text
        assert second.json()["code"] == ErrorCode.TASK_STATE_CONFLICT.value
    finally:
        release.set()
        response = await asyncio.wait_for(first, 2)
    assert response.status_code == 200, response.text
    assert len(response.json()["data"]["task_ids"]) == len(spawned) == 2
    after, tasks, charges = await _snapshot(uid)
    assert len(tasks) == len(charges) == 2
    assert before - after == sum(task.cost for task in tasks)
    repeated = await client.post(endpoint, headers=headers, json={"option_id": "summer", "selection_fingerprint": ""})
    assert repeated.status_code == 200
    assert repeated.json()["data"]["task_ids"] == response.json()["data"]["task_ids"]
    assert (await _snapshot(uid))[0] == after and len(spawned) == 2


async def test_refunded_compose_batch_can_retry_without_replaying_failed_task(client, monkeypatch):
    headers, uid, before, endpoint, spawned = await setup_confirmation(client, monkeypatch)
    real_create = generate_service.create_image_task
    calls = 0

    async def create(db, user_id, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            await db.rollback()
            raise AppError(ErrorCode.QUOTA_INSUFFICIENT, "模拟并发扣费冲突")
        return await real_create(db, user_id, **kwargs)

    monkeypatch.setattr(generate_service, "create_image_task", create)
    failed = await client.post(endpoint, headers=headers, json={"option_id": "spring", "selection_fingerprint": ""})
    assert failed.status_code >= 400, failed.text
    balance, tasks, charges = await _snapshot(uid)
    assert balance == before and spawned == []
    assert len(tasks) == len(charges) == 1
    old_id = tasks[0].id
    assert tasks[0].status == "failed" and charges[0].status == "refunded"
    retry = await client.post(endpoint, headers=headers, json={"option_id": "spring", "selection_fingerprint": ""})
    assert retry.status_code == 200, retry.text
    ids = retry.json()["data"]["task_ids"]
    assert len(ids) == len(spawned) == 2 and old_id not in ids
    balance, tasks, charges = await _snapshot(uid)
    assert len(tasks) == len(charges) == 3
    assert before - balance == sum(task.cost for task in tasks if task.id in ids)
    assert all(task.status == "running" for task in tasks if task.id in ids)
