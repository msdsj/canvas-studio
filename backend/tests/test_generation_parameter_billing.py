"""Execution parameters and quota must agree even when callers pass metadata."""
from __future__ import annotations

import base64
import io
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from PIL import Image
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.generation import GenerationTask
from app.models.quota import QuotaTransaction
from app.models.user import User
from app.services import generate_service
from app.services.edit_handlers import BUILTIN_INDEX
from app.utils.errors import AppError, ErrorCode
from tests.conftest import register_and_activate


def capture_creation(monkeypatch):
    captured = {}

    async def create(
        db, user_id, key, kind, prompt, params, cost, session_id, canvas_id, *, team=None
    ):
        captured.update(kind=kind, params=params, cost=cost, team=team)
        return SimpleNamespace(params=params, cost=cost), True

    async def price(db, kind, quality="standard"):
        return 8 if kind == "edit" else 16 if quality == "hd" else 10

    async def handlers(db):
        return BUILTIN_INDEX

    monkeypatch.setattr(generate_service.task_service, "create_or_get", create)
    monkeypatch.setattr(generate_service, "resolve_cost", price)
    monkeypatch.setattr(generate_service, "load_handlers", handlers)
    return captured


async def test_explicit_generation_params_win_over_untrusted_metadata(monkeypatch):
    captured = capture_creation(monkeypatch)
    await generate_service.create_image_task(
        None, "u", prompt="画一张风景", model="gpt-image-2", size="1024x1024",
        quality="standard", n=1, session_id=None, canvas_id=None, idempotency_key="p",
        extra={"n": 4, "quality": "hd", "model": "other", "size": "4096x4096",
               "base_image_url": "untrusted", "ops": [{"handler": "cutout"}],
               "optimized_prompt": "替换指令", "pool_batch_id": "batch",
               "pool_task_id": "1", "pool_batch_total": 1, "batch_label": "主图"},
    )
    assert captured["cost"] == 10
    assert captured["params"]["n"] == 1 and captured["params"]["quality"] == "standard"
    assert captured["params"]["model"] == "gpt-image-2"
    assert captured["params"]["size"] == "1024x1024"
    assert not {"ops", "base_image_url", "optimized_prompt"} & captured["params"].keys()
    assert captured["params"]["pool_batch_id"] == "batch"
    assert captured["params"]["pool_task_id"] == "1"
    assert captured["params"]["pool_batch_total"] == 1
    assert captured["params"]["batch_label"] == "主图"


@pytest.mark.parametrize("requested,expected", [(0, 1), (-2, 1), (8, 4), ("3", 3)])
async def test_normalized_count_is_identical_for_dispatch_and_billing(monkeypatch, requested, expected):
    captured = capture_creation(monkeypatch)
    await generate_service.create_image_task(
        None, "u", prompt="画风景", model="gpt-image-2", size="1024x1024",
        quality=" HD ", n=requested, session_id=None, canvas_id=None, idempotency_key="p",
    )
    assert captured["params"]["n"] == expected
    assert captured["params"]["quality"] == "hd"
    assert captured["cost"] == 16 * expected


async def test_unsupported_quality_cannot_reach_quota_or_execution(monkeypatch):
    create = AsyncMock()
    monkeypatch.setattr(generate_service.task_service, "create_or_get", create)
    with pytest.raises(AppError) as error:
        await generate_service.create_image_task(
            None, "u", prompt="画风景", model="gpt-image-2", size="1024x1024",
            quality="unpriced-provider-quality", n=1, session_id=None, canvas_id=None,
            idempotency_key="p",
        )
    assert error.value.code == ErrorCode.VALIDATION_ERROR
    create.assert_not_called()


@pytest.mark.parametrize("handlers,expected_cost", [(["restyle"], 24), (["cutout"], 8), (["restyle", "cutout"], 32), ([], 24)])
async def test_edit_metadata_cannot_replace_ops_and_cost_matches_actual_outputs(monkeypatch, handlers, expected_cost):
    captured = capture_creation(monkeypatch)
    original = [{"region": {"x": 0.1, "y": 0.2, "w": 0.4, "h": 0.4}, "handler": handler, "prompt": "处理原图选区"} for handler in handlers]
    await generate_service.create_edit_task(
        None, "u", prompt="处理选区", model="gpt-image-2", size="1024x1024",
        base_image_url="/static/original.png", mask_url="/static/mask.png", edit_ops=original,
        edit_mode="fine", edit_intensity="fine", session_id=None, canvas_id=None,
        idempotency_key="p", extra={"n": "3", "ops": [], "region": [], "outputs": [],
            "base_image_url": "untrusted", "mask_url": "untrusted", "model": "other",
            "quality": "hd", "edit_mode": "override", "edit_intensity": "rebuild",
            "optimized_prompt": "替换指令", "pool_batch_id": "batch", "guide_url": "/static/guide.png"},
    )
    assert captured["cost"] == expected_cost
    assert captured["params"]["n"] == 3
    assert captured["params"]["quality"] == "standard"
    assert captured["params"]["model"] == "gpt-image-2"
    assert captured["params"]["base_image_url"] == "/static/original.png"
    assert captured["params"]["mask_url"] == "/static/mask.png"
    assert captured["params"]["edit_mode"] == captured["params"]["edit_intensity"] == "fine"
    assert "optimized_prompt" not in captured["params"]
    assert [item["handler"] for item in captured["params"].get("ops", [])] == handlers
    assert captured["params"]["pool_batch_id"] == "batch"
    assert captured["params"]["guide_url"] == "/static/guide.png"


async def test_image_api_metadata_cannot_upgrade_count_or_quality_and_quota_matches(client, monkeypatch):
    token = await register_and_activate(client, "parameter-billing@example.com")
    calls = []
    out = io.BytesIO()
    Image.new("RGB", (16, 16), "blue").save(out, "PNG")

    async def generate(payload):
        calls.append(payload)
        return {"data": [{"b64_json": base64.b64encode(out.getvalue()).decode()}], "demo": False}

    monkeypatch.setattr(generate_service.gw_module.gateway_client, "image_generations", generate)
    response = await client.post("/api/generate/image", headers={"Authorization": f"Bearer {token}"}, json={
        "prompt": "绘制一张蓝色风景", "n": 1, "quality": "standard",
        "params": {"n": 4, "quality": "hd", "size": "4096x4096", "model": "other"},
    })
    assert response.status_code == 200, response.text
    task_id = response.json()["data"]["id"]
    assert len(calls) == 1 and calls[0]["n"] == 1 and calls[0]["quality"] == "standard"
    # 参数自适应：未显式给 size 时按「文本 > 场景」推断（通用兜底 4:3，
    # 不再是全局正方形）；但 params 里的 4096x4096 绝不能覆盖执行参数。
    assert calls[0]["size"] == "1536x1024" and calls[0]["model"] == "gpt-image-2"
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, task_id)
        user = (await db.execute(select(User).where(User.email == "parameter-billing@example.com"))).scalar_one()
        charge = (await db.execute(select(QuotaTransaction).where(QuotaTransaction.ref_id == task_id))).scalar_one()
        assert task.status == "succeeded" and task.cost == 10
        assert len(task.result_urls) == 1 and task.params["n"] == 1
        assert user.balance == 190 and charge.amount == -10 and charge.status == "success"
