"""Real database checks for whole batches, confirmation and rollback safety."""
from __future__ import annotations

import asyncio
import copy
import json

import pytest
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.chat import ChatMessage
from app.models.generation import GenerationTask
from app.models.quota import QuotaTransaction
from app.models.skill import SkillRun
from app.models.user import User
from app.services import compose_service, generate_service, relay_service
from app.services.gateway_client import gateway_client
from app.services.relay_service import build_target_from_draft
from app.utils.errors import AppError, ErrorCode
from tests.test_intent_flow import events, install, payload, plan, prepare


def _three_outputs():
    result = plan()
    result["image_count"] = 3
    result["reason"] = "分别生成修改图、独立素材与另一个修改版本"
    result["jobs"].append({
        "label": "绿色版本", "output_kind": "composite",
        "prompt": "另输出一张仅将第一个选区底色改为绿色的原图，其余像素保持不变",
        "ops": [{"region_index": 3, "handler": "restyle", "prompt": "将底色改绿色"}],
    })
    return result


def _install_plan(monkeypatch, result):
    _, spawned = install(monkeypatch)

    async def stream(body):
        yield "已核对原图、选区编号和各项独立产出。\n<<<JSON>>>\n"
        yield json.dumps(result, ensure_ascii=False)

    monkeypatch.setattr(gateway_client, "llm_text_stream", stream)
    return spawned


def _result(response):
    assert response.status_code == 200, response.text
    return next(event["result"] for event in events(response) if event["event"] == "result")


async def _snapshot(user_id):
    async with AsyncSessionLocal() as db:
        user = await db.get(User, user_id)
        tasks = list((await db.execute(select(GenerationTask).where(GenerationTask.user_id == user_id).order_by(GenerationTask.created_at))).scalars())
        charges = list((await db.execute(select(QuotaTransaction).where(QuotaTransaction.user_id == user_id, QuotaTransaction.type.in_(("consume_image", "consume_edit"))))).scalars())
        return user.balance, tasks, charges


async def test_remote_only_pool_rejects_multiple_outputs_before_any_charge(client, monkeypatch):
    headers, session, uid, aid, before = await prepare(client)
    spawned = _install_plan(monkeypatch, plan())

    async def remote_only_capacity():
        return {"total": 0, "healthy": 0, "available": 0, "independent_routing": True}

    monkeypatch.setattr(gateway_client, "pool_capacity", remote_only_capacity)
    result = _result(await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers))
    assert result["status"] == "failed"
    assert "号池里还没有可用账号" in result["reply"]
    balance, tasks, charges = await _snapshot(uid)
    assert balance == before and tasks == charges == spawned == []


async def test_upstream_pool_allows_multiple_outputs(client, monkeypatch):
    """账号在 chatgpt2api（上游）时，多输出必须放行。

    这是本轮修复的核心：用户导入 4 个 ChatGPT 凭据后，本地独立池仍是 0，
    旧逻辑据此拒绝「拆成 2 张」。网关现在会返回 routing_mode=upstream，
    预检应按上游健康账号数判断，而不是本地池。
    """
    headers, session, uid, aid, _before = await prepare(client)
    spawned = _install_plan(monkeypatch, plan())

    async def upstream_capacity():
        return {
            "total": 0,
            "healthy": 0,
            "available": 0,
            "independent_routing": False,
            "routing_mode": "upstream",
            "upstream_total": 4,
            "upstream_healthy": 4,
            "effective_total": 4,
            "effective_available": 4,
        }

    monkeypatch.setattr(gateway_client, "pool_capacity", upstream_capacity)
    result = _result(await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers))
    assert result["status"] == "completed", result
    assert len(result["tasks"]) == len(spawned) == 2


@pytest.mark.parametrize("capability", ["unreachable", "unverified"])
async def test_unverified_capacity_rejects_multiple_outputs_without_charging(client, monkeypatch, capability):
    headers, session, uid, aid, before = await prepare(client)
    spawned = _install_plan(monkeypatch, plan())

    async def capacity():
        if capability == "unreachable":
            raise AppError(ErrorCode.UPSTREAM_ERROR, "网关容量端点不可用")
        return {"total": 12, "healthy": 12, "available": 12, "independent_routing": False}

    monkeypatch.setattr(gateway_client, "pool_capacity", capacity)
    result = _result(await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers))
    assert result["status"] == "failed" and result["tasks"] == []
    balance, tasks, charges = await _snapshot(uid)
    assert balance == before and tasks == charges == spawned == []


async def test_three_outputs_create_three_single_image_tasks_with_separate_pool_slots(client, monkeypatch):
    headers, session, uid, aid, before = await prepare(client)
    expected = _three_outputs()
    spawned = _install_plan(monkeypatch, expected)
    request = payload(session, aid)
    request["content"] = "分别输出蓝底修改图、主体透明素材，以及绿色底修改图，共三张"
    result = _result(await client.post("/api/chat/analyze", json=request, headers=headers))
    assert result["status"] == "completed", result
    assert result["image_count"] == len(result["tasks"]) == len(spawned) == 3
    balance, tasks, charges = await _snapshot(uid)
    assert len(tasks) == len(charges) == 3
    assert {task.params["pool_task_id"] for task in tasks} == {"1", "2", "3"}
    assert len({task.params["pool_batch_id"] for task in tasks}) == 1
    assert all(task.params["pool_batch_total"] == 3 and task.params["n"] == 1 for task in tasks)
    assert {task.prompt for task in tasks} == {job["prompt"] for job in expected["jobs"]}
    assert before - balance == sum(task.cost for task in tasks)


async def test_second_task_quota_rollback_refunds_first_and_returns_failed_sse(client, monkeypatch):
    headers, session, uid, aid, before = await prepare(client)
    spawned = _install_plan(monkeypatch, plan())
    real_create = generate_service.create_edit_task
    calls = 0

    async def create(db, user_id, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            # Match quota_service.pre_deduct's real failure behavior: rollback
            # expires ORM instances in this request's session.
            await db.rollback()
            raise AppError(ErrorCode.QUOTA_INSUFFICIENT, "并发扣费后余额不足")
        return await real_create(db, user_id, **kwargs)

    monkeypatch.setattr(generate_service, "create_edit_task", create)
    response = await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers)
    result = _result(response)
    assert result["status"] == "failed" and result["tasks"] == []
    assert calls == 2 and spawned == []
    balance, tasks, charges = await _snapshot(uid)
    assert balance == before
    assert len(tasks) == len(charges) == 1
    assert tasks[0].status == "failed" and charges[0].status == "refunded"
    assert "MissingGreenlet" not in response.text


def _confirmation_plan():
    result = plan()
    result["needs_confirmation"] = True
    result["question"] = "需要单张修改图，还是三项独立产出？"
    result["options"] = [
        {"label": "单张修改图", "description": "只输出改底色后的原图", "reason": "只需一项产出", "image_count": 1, "jobs": [copy.deepcopy(result["jobs"][0])]},
        {"label": "三项独立产出", "description": "两个底色版本和一份独立素材", **_three_outputs()},
    ]
    return result


async def test_dynamic_confirmation_uses_selected_jobs_and_repeated_confirmation_is_free(client, monkeypatch):
    headers, session, uid, aid, before = await prepare(client)
    expected = _confirmation_plan()
    spawned = _install_plan(monkeypatch, expected)
    analysis = _result(await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers))
    assert analysis["status"] == "confirm" and spawned == []
    assert [option["image_count"] for option in analysis["options"]] == [1, 3]
    assert (await _snapshot(uid))[0] == before
    fingerprint = analysis["selection_fingerprint"]
    endpoint = f"/api/chat/runs/{analysis['run_id']}/confirm"
    response = await client.post(endpoint, json={"option_id": "option2", "selection_fingerprint": fingerprint}, headers=headers)
    assert response.status_code == 200, response.text
    confirmed = response.json()["data"]
    assert len(confirmed["task_ids"]) == len(spawned) == 3
    after, tasks, charges = await _snapshot(uid)
    assert len(tasks) == len(charges) == 3
    assert {task.prompt for task in tasks} == {job["prompt"] for job in expected["options"][1]["jobs"]}
    repeated = await client.post(endpoint, json={"option_id": "option1", "selection_fingerprint": fingerprint}, headers=headers)
    assert repeated.status_code == 200, repeated.text
    assert repeated.json()["data"]["task_ids"] == confirmed["task_ids"]
    balance, tasks_after, charges_after = await _snapshot(uid)
    assert balance == after and len(tasks_after) == len(charges_after) == len(spawned) == 3
    async with AsyncSessionLocal() as db:
        run = await db.get(SkillRun, analysis["run_id"])
        assert run.plan["chosen_option_id"] == "option2" and run.image_count == 3
        message = await db.get(ChatMessage, analysis["message_id"])
        attachment = next(item for item in message.attachments if item.get("type") == "skill_run")
        assert attachment["chosen_option_id"] == "option2" and attachment["image_count"] == 3


async def test_confirmation_claim_prevents_another_option_from_starting_during_dispatch(client, monkeypatch):
    headers, session, uid, aid, _ = await prepare(client)
    spawned = _install_plan(monkeypatch, _confirmation_plan())
    analysis = _result(await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers))
    endpoint = f"/api/chat/runs/{analysis['run_id']}/confirm"
    entered, release = asyncio.Event(), asyncio.Event()
    real_create = generate_service.create_edit_task

    async def blocked_create(*args, **kwargs):
        entered.set()
        await release.wait()
        return await real_create(*args, **kwargs)

    monkeypatch.setattr(generate_service, "create_edit_task", blocked_create)
    first = asyncio.create_task(client.post(endpoint, json={"option_id": "option1", "selection_fingerprint": analysis["selection_fingerprint"]}, headers=headers))
    try:
        await asyncio.wait_for(entered.wait(), timeout=2)
        second = await client.post(endpoint, json={"option_id": "option2", "selection_fingerprint": analysis["selection_fingerprint"]}, headers=headers)
        assert second.status_code == 409, second.text
        assert second.json()["code"] == ErrorCode.TASK_STATE_CONFLICT.value
    finally:
        release.set()
        first_response = await asyncio.wait_for(first, timeout=2)
    assert first_response.status_code == 200, first_response.text
    assert len(spawned) == 1
    _, tasks, charges = await _snapshot(uid)
    assert len(tasks) == len(charges) == 1


async def test_compose_unsupported_model_count_returns_visible_failed_result_without_charging(client, monkeypatch):
    headers, session, uid, _, before = await prepare(client)
    spawned = []
    target = build_target_from_draft(base_url="https://relay.test/v1", api_key="test", model="m")

    async def resolve(*args):
        return target

    async def stream(*args, **kwargs):
        yield "已读懂需求，正在核对产出数量。\n<<<JSON>>>\n"
        yield json.dumps({"summary": "系列插画", "subject": "风景", "image_count": compose_service.MAX_IMAGES + 1, "confidence": 0.95, "ambiguity": {"is_ambiguous": False}, "missing": []})

    monkeypatch.setattr(relay_service, "resolve", resolve)
    monkeypatch.setattr(relay_service, "chat_stream", stream)
    monkeypatch.setattr(compose_service, "_spawn_run", spawned.append)
    response = await client.post("/api/chat/compose", json={"session_id": session, "content": "请分别绘制十三张四季水彩风景系列插画，每张一个画面"}, headers=headers)
    result = _result(response)
    assert result["status"] == "failed" and result["tasks"] == []
    assert result["error_code"] == ErrorCode.VALIDATION_ERROR.value
    assert "最多支持" in result["reply"]
    balance, tasks, charges = await _snapshot(uid)
    assert balance == before and tasks == charges == spawned == []


async def test_compose_second_task_quota_rollback_refunds_batch_and_returns_failed_sse(client, monkeypatch):
    headers, session, uid, _, before = await prepare(client)
    spawned = []
    target = build_target_from_draft(base_url="https://relay.test/v1", api_key="test", model="m")
    analysis = {
        "summary": "两张四季风景", "subject": "春夏风景", "image_count": 2, "confidence": 0.95,
        "ambiguity": {"is_ambiguous": False}, "missing": [],
        "images": [{"label": "春", "prompt": "春天樱花小路水彩风景插画"}, {"label": "夏", "prompt": "夏天海边落日水彩风景插画"}],
    }

    async def resolve(*args):
        return target

    async def stream(target, messages, **kwargs):
        if any("本轮事实（JSON）" in str(message.get("content")) for message in messages):
            yield "本批次未能提交，额度已退回。"
        else:
            yield "分别准备两张不同季节的风景。\n<<<JSON>>>\n"
            yield json.dumps(analysis, ensure_ascii=False)

    async def capacity():
        return {"total": 12, "available": 12, "independent_routing": True}

    async def pool_stats():
        return {"total": 12, "normal": 12}

    real_create = generate_service.create_image_task
    calls = 0

    async def create(db, user_id, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2:
            await db.rollback()
            raise AppError(ErrorCode.QUOTA_INSUFFICIENT, "并发扣费后余额不足")
        return await real_create(db, user_id, **kwargs)

    monkeypatch.setattr(relay_service, "resolve", resolve)
    monkeypatch.setattr(relay_service, "chat_stream", stream)
    monkeypatch.setattr(gateway_client, "pool_capacity", capacity)
    monkeypatch.setattr(compose_service, "_pool_capacity", pool_stats)
    monkeypatch.setattr(compose_service, "_spawn_run", spawned.append)
    monkeypatch.setattr(generate_service, "create_image_task", create)
    response = await client.post("/api/chat/compose", json={"session_id": session, "content": "请分别绘制春天樱花小路和夏天海边落日的两张水彩插画"}, headers=headers)
    result = _result(response)
    assert result["status"] == "failed" and result["tasks"] == []
    assert calls == 2 and spawned == []
    balance, tasks, charges = await _snapshot(uid)
    assert balance == before and len(tasks) == len(charges) == 1
    assert tasks[0].status == "failed" and charges[0].status == "refunded"
    assert "MissingGreenlet" not in response.text
