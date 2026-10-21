"""Execution must preserve reference routing and reject empty cutout results."""
from __future__ import annotations

import base64
import io
import json

import pytest
from PIL import Image
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.asset import Asset
from app.models.generation import GenerationTask
from app.models.user import User
from app.services import generate_service
from tests.test_intent_flow import events, install, payload, png, prepare


def _plan(job):
    return {"image_count": 1, "confidence": 0.98, "reason": "按用户指定的独立输出执行", "jobs": [job]}


def _install_plan(monkeypatch, job):
    _, spawned = install(monkeypatch)

    async def stream(body):
        yield "已确认输出要求，按指定图片来源处理。\n<<<JSON>>>\n"
        yield json.dumps(_plan(job), ensure_ascii=False)

    monkeypatch.setattr("app.services.gateway_client.gateway_client.llm_text_stream", stream)
    return spawned


async def _submit(client, headers, request):
    response = await client.post("/api/chat/analyze", json=request, headers=headers)
    assert response.status_code == 200, response.text
    result = next(event["result"] for event in events(response) if event["event"] == "result")
    assert result["status"] == "completed", result
    assert result["image_count"] == 1
    return result


def _image_reply(raw):
    return {"data": [{"b64_json": base64.b64encode(raw).decode()}], "demo": False}


async def test_generate_job_uses_owned_reference_by_default_without_region_mask(client, monkeypatch):
    headers, session, uid, aid, before = await prepare(client)
    spawned = _install_plan(monkeypatch, {"label": "参考图创作", "output_kind": "generate", "prompt": "参考原图主体重新创作一张新的构图", "ops": []})
    calls = []

    async def edits(files, form):
        calls.append((files, form))
        return _image_reply(png((20, 60, 200, 255)))

    async def unexpected_generate(body):
        pytest.fail("有原图且未禁用引用时必须调用 image_edits")

    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", edits)
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_generations", unexpected_generate)
    result = await _submit(client, headers, payload(session, aid))
    assert len(spawned) == 1
    assert result["jobs"][0]["use_reference"] is True

    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        expected_cost = await generate_service.resolve_cost(db, "edit")
        asset = await db.get(Asset, aid)
        original = generate_service._local_bytes(asset.url)[0]
        assert task.type == "edit" and task.cost == expected_cost
        assert not task.params.get("ops") and not task.params.get("mask_url")
        assert (await db.get(User, uid)).balance == before - expected_cost

    await generate_service.run_task(spawned[0])
    assert len(calls) == 1
    files, _ = calls[0]
    assert [field for field, _ in files] == ["image"]
    assert files[0][1][1] == original, "必须发送没有框选标注的原始参考图"
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        assert task.status == "succeeded", task.error_message
        assert len(task.result_urls) == 1


async def test_generate_job_can_explicitly_ignore_reference_and_use_generation_price(client, monkeypatch):
    headers, session, uid, aid, before = await prepare(client)
    spawned = _install_plan(monkeypatch, {"label": "全新创作", "output_kind": "generate", "use_reference": False, "prompt": "完全重新设计一张无参考图的新画面", "ops": []})
    calls = []

    async def generations(body):
        calls.append(body)
        return _image_reply(png((30, 90, 180, 255)))

    async def unexpected_edit(files, form):
        pytest.fail("显式 use_reference=false 不应向图像模型发送原图")

    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_generations", generations)
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", unexpected_edit)
    result = await _submit(client, headers, payload(session, aid))
    assert result["jobs"][0]["use_reference"] is False
    assert len(spawned) == 1

    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        expected_cost = await generate_service.resolve_cost(db, "generate")
        assert task.type == "generate" and task.cost == expected_cost
        assert not task.params.get("base_image_url")
        assert (await db.get(User, uid)).balance == before - expected_cost

    await generate_service.run_task(spawned[0])
    assert len(calls) == 1
    assert calls[0]["n"] == 1 and calls[0]["model"] == "gpt-image-2"
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        assert task.status == "succeeded", task.error_message
        assert len(task.result_urls) == 1


async def test_sprite_is_local_crop_and_never_redrawn(client, monkeypatch):
    """素材类走本地裁切：不调用上游、产出不超出选区。

    契约变更（2026-10-21）：素材类此前送上游重画，实测上游会按「完整人物」
    补出框外内容（框到膝盖却补出腿和鞋）。现在直接从原图按选区裁切并分离
    背景，框外没有的内容不可能出现在结果里。
    """
    headers, session, uid, aid, before = await prepare(client)
    spawned = _install_plan(monkeypatch, {"label": "提取素材", "output_kind": "sprite", "prompt": "只提取第二选区主体为独立透明素材", "ops": [{"region_index": 7, "handler": "cutout", "prompt": "保持主体原样"}]})

    async def unexpected_edits(files, form):
        pytest.fail("抠图不得调用上游：上游会重绘并补出框外内容")

    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", unexpected_edits)
    await _submit(client, headers, payload(session, aid))
    assert len(spawned) == 1
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        assert (await db.get(User, uid)).balance == before - task.cost

    await generate_service.run_task(spawned[0])
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        assert task.status == "succeeded", task.error_message
        assert len(task.result_urls) == 1
        generated = (await db.execute(select(Asset).where(Asset.generation_task_id == task.id))).scalars().all()
        assert len(generated) == 1
        raw = generate_service._local_bytes(task.result_urls[0])[0]

    with Image.open(io.BytesIO(raw)) as output:
        assert output.mode == "RGBA"
        # payload 里第二个选区是右下角 0.5×0.5 → 32×32，结果不得超出这个框
        assert output.width <= 32 and output.height <= 32, "素材不得超出选区"


async def test_sprite_pixels_come_from_base_image(client, monkeypatch):
    """素材像素取自**原图**，而不是上游重绘产物。

    底图是纯色 (180,30,40)；抠图后所有不透明像素必须仍是这个颜色。
    这直接排除「上游重画」——上游返回的图与本图颜色不同。
    """
    headers, session, uid, aid, _ = await prepare(client)
    spawned = _install_plan(monkeypatch, {"label": "套索素材", "output_kind": "sprite", "prompt": "原样提取套索内主体，套索外全部透明", "ops": [{"region_index": 7, "handler": "cutout", "prompt": "严格遵循自由选区轮廓"}]})
    request = payload(session, aid)
    request["selection"]["regions"] = [{"index": 7, "region": {"x": 0, "y": 0, "w": 1, "h": 1}, "path": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 0, "y": 1}]}]

    async def unexpected_edits(files, form):
        pytest.fail("抠图不得调用上游")

    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", unexpected_edits)
    await _submit(client, headers, request)
    await generate_service.run_task(spawned[0])
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        assert task.status == "succeeded", task.error_message
        assert len(task.result_urls) == 1
        raw = generate_service._local_bytes(task.result_urls[0])[0]
    with Image.open(io.BytesIO(raw)) as output:
        assert output.mode == "RGBA"
        opaque = [px for px in output.convert("RGBA").getdata() if px[3] > 200]
        assert opaque, "素材必须有可见主体"
        assert any(px[:3] == (180, 30, 40) for px in opaque), "素材 RGB 应取自原图"
        assert all(px[:3] == (180, 30, 40) for px in opaque), "不得混入上游重绘像素"
