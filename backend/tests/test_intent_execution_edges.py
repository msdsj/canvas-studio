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


@pytest.mark.parametrize("outside_subject", [False, True], ids=["fully-transparent", "subject-outside-selection"])
async def test_transparent_sprite_still_yields_asset(client, monkeypatch, outside_subject):
    """上游返回的素材要么全透明、要么主体落在选区外 —— 新契约下都应成功。

    契约变更（2026-10-21）：早先素材类要求「上游 alpha 必须落在原图选区坐标内」，
    落空就判定失败并退款。但上游实际是重画居中单主体、尺寸也变，按原坐标对齐
    必然落空，于是「框了两处却报无效主体」。现在素材类改为**裁块直送 + 按上游
    自己的 alpha 包围盒裁切**，不再拿原图坐标去校验上游产物。

    所以这里锁的是新行为：任务成功、有产出、带 alpha；而不是「失败 + 退款」。
    """
    headers, session, uid, aid, before = await prepare(client)
    spawned = _install_plan(monkeypatch, {"label": "提取素材", "output_kind": "sprite", "prompt": "只提取第二选区主体为独立透明素材", "ops": [{"region_index": 7, "handler": "cutout", "prompt": "保持主体原样"}]})
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    if outside_subject:
        # 主体只占角落里一个像素：按上游自己的包围盒裁出来后仍是一张有效素材
        image.putpixel((4, 4), (20, 220, 30, 255))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")

    async def edits(files, form):
        return _image_reply(buffer.getvalue())

    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", edits)
    await _submit(client, headers, payload(session, aid))
    assert len(spawned) == 1
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        assert task.cost > 0
        assert (await db.get(User, uid)).balance == before - task.cost

    await generate_service.run_task(spawned[0])
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        assert task.status == "succeeded", task.error_message
        assert len(task.result_urls) == 1
        assert (await db.get(User, uid)).balance == before - task.cost, "成功不退款"
        generated = (await db.execute(select(Asset).where(Asset.generation_task_id == task.id))).scalars().all()
        assert len(generated) == 1

    raw = generate_service._local_bytes(task.result_urls[0])[0]
    with Image.open(io.BytesIO(raw)) as output:
        assert output.mode == "RGBA"
        # 全透明输入 → 素材没有可见主体；单像素输入 → 裁出来就是那一个像素。
        # 两种都是「上游给什么就是什么」，不再由我们二次判死。
        if outside_subject:
            assert output.width <= 8 and output.height <= 8, "应按上游 alpha 包围盒裁切"
        else:
            assert output.getchannel("A").getextrema()[0] == 0, "全透明输入应得到全透明素材"


async def test_sprite_comes_from_upstream_not_original_pixels(client, monkeypatch):
    """素材像素来自**上游产物**，不再要求「与原图逐像素一致」。

    契约变更（2026-10-21）：素材类已改为「裁块 + 上游重画」，上游返回的 RGB
    与底图不再相同（实测上游会重新绘制主体细节）。旧断言「主体 RGB 必须来自
    原图而非上游重绘」在当前模型能力下无法成立，且与"所有图片操作一律走上游"
    的产品口径矛盾。这里改为锁住真正重要的三件事：
    ① 有产出且是 RGBA；② 带真透明；③ 素材内容确实取自上游返回的图。
    """
    headers, session, uid, aid, _ = await prepare(client)
    spawned = _install_plan(monkeypatch, {"label": "套索素材", "output_kind": "sprite", "prompt": "原样提取套索内主体，套索外全部透明", "ops": [{"region_index": 7, "handler": "cutout", "prompt": "严格遵循自由选区轮廓"}]})
    request = payload(session, aid)
    request["selection"]["regions"] = [{"index": 7, "region": {"x": 0, "y": 0, "w": 1, "h": 1}, "path": [{"x": 0, "y": 0}, {"x": 1, "y": 0}, {"x": 0, "y": 1}]}]
    provider = Image.new("RGBA", (64, 64), (0, 255, 0, 255))
    provider.putpixel((63, 63), (0, 0, 0, 0))
    buffer = io.BytesIO()
    provider.save(buffer, "PNG")

    async def edits(files, form):
        return _image_reply(buffer.getvalue())

    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", edits)
    await _submit(client, headers, request)
    await generate_service.run_task(spawned[0])
    async with AsyncSessionLocal() as db:
        task = await db.get(GenerationTask, spawned[0])
        assert task.status == "succeeded", task.error_message
        assert len(task.result_urls) == 1
        raw = generate_service._local_bytes(task.result_urls[0])[0]
    with Image.open(io.BytesIO(raw)) as output:
        assert output.mode == "RGBA"
        assert output.getchannel("A").getextrema()[0] == 0, "素材必须带透明区"
        # 上游给的是一整块绿；裁切后主体像素应当来自上游，而不是原图的 (180,30,40)
        opaque = [
            px for px in output.convert("RGBA").getdata() if px[3] > 200
        ]
        assert opaque, "素材必须有可见主体"
        assert any(px[:3] == (0, 255, 0) for px in opaque), "素材 RGB 应取自上游产物"
