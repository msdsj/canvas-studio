"""In-process multimodal planning, independent dispatch and pixel fidelity."""
import base64
import io
import json
from PIL import Image, ImageDraw
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.generation import GenerationTask
from app.models.user import User
from app.services import asset_service, generate_service, skills
from app.utils.errors import AppError, ErrorCode


def png(color=(180, 30, 40, 255)):
    out = io.BytesIO()
    Image.new("RGBA", (64, 64), color).save(out, "PNG")
    return out.getvalue()


async def prepare(client):
    login = await client.post("/api/auth/login", json={"email": "admin@canvas.studio", "password": "Admin@12345"})
    headers = {"Authorization": f"Bearer {login.json()['data']['access_token']}"}
    session = (await client.post("/api/chat/sessions", json={}, headers=headers)).json()["data"]["id"]
    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(User.email == "admin@canvas.studio"))).scalar_one()
        asset = await asset_service.create_from_bytes(db, user.id, png(), kind="uploaded", filename="base.png", content_type="image/png")
        await db.commit()
        return headers, session, user.id, asset.id, user.balance


def plan():
    return {"image_count": 2, "reason": "修改图和独立素材", "confidence": 0.95, "jobs": [
        {"label": "改色", "output_kind": "composite", "prompt": "仅将第一个选区底色改蓝，其余保持原样", "ops": [{"region_index": 3, "handler": "restyle", "prompt": "将底色改蓝色"}]},
        {"label": "素材", "output_kind": "sprite", "prompt": "原样提取第二个选区主体为透明PNG", "ops": [{"region_index": 7, "handler": "cutout", "prompt": "原样提取主体"}]}]}


def payload(session, aid):
    return {"session_id": session, "content": "第一处改蓝色，第二处抠成独立图片", "selection": {"asset_id": aid, "width": 64, "height": 64, "regions": [{"index": 3, "region": {"x": 0, "y": 0, "w": 0.4, "h": 0.4}}, {"index": 7, "region": {"x": 0.5, "y": 0.5, "w": 0.5, "h": 0.5}}]}}


def events(response):
    return [json.loads(line[5:].strip()) for line in response.text.splitlines() if line.startswith("data:")]


def install(monkeypatch, failure=False, bad_region=False):
    observed, spawned = [], []
    async def target(*args): return None
    async def capacity(): return {"total": 12, "available": 12, "independent_routing": True}
    async def stream(body):
        observed.append(body)
        if failure: raise AppError(ErrorCode.UPSTREAM_ERROR, "分析模型不可用")
        result = plan()
        if bad_region: result["jobs"][1]["ops"][0]["region_index"] = 99
        for text in ["识别到两类独立产出。", "保留其他区域原图。\n<<<JSON>>>\n", json.dumps(result, ensure_ascii=False)]: yield text
    monkeypatch.setattr("app.services.relay_service.resolve", target)
    monkeypatch.setattr("app.services.gateway_client.gateway_client.pool_capacity", capacity)
    monkeypatch.setattr("app.services.gateway_client.gateway_client.llm_text_stream", stream)
    monkeypatch.setattr(skills, "_spawn_run", spawned.append)
    return observed, spawned


async def test_multimodal_two_independent_outputs_and_original_pixels(client, monkeypatch):
    headers, session, uid, aid, _ = await prepare(client)
    observed, spawned = install(monkeypatch)
    response = await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers)
    trace = events(response)
    result = next(e["result"] for e in trace if e["event"] == "result")
    assert result["status"] == "completed", result
    assert result["image_count"] == len(spawned) == 2
    assert any(e["event"] == "analysis" for e in trace)
    assert not any(e["event"] == "thought" for e in trace)
    parts = observed[0]["messages"][1]["content"]
    assert sum(part["type"] == "image_url" for part in parts) == 2
    calls = []
    async def edit(files, form):
        calls.append((files, form))
        if "纯透明背景" in form["prompt"]:
            image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
            ImageDraw.Draw(image).ellipse((40, 40, 55, 55), fill=(0, 255, 0, 255))
            out = io.BytesIO(); image.save(out, "PNG"); raw = out.getvalue()
        else:
            raw = png((0, 0, 255, 255))
        return {"data": [{"b64_json": base64.b64encode(raw).decode()}], "demo": False}
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", edit)
    for tid in spawned: await generate_service.run_task(tid)
    async with AsyncSessionLocal() as db:
        tasks = list((await db.execute(select(GenerationTask).where(GenerationTask.user_id == uid).order_by(GenerationTask.created_at))).scalars())
        assert all(t.status == "succeeded" for t in tasks), [t.error_message for t in tasks]
        assert len({t.params["pool_task_id"] for t in tasks}) == 2
        assert len({t.params["pool_batch_id"] for t in tasks}) == 1
        assert [t.params["ops"][0]["index"] for t in tasks] == [3, 7]
        with Image.open(io.BytesIO(generate_service._local_bytes(tasks[0].result_urls[0])[0])) as image:
            assert image.size == (64, 64)
            # GPT Image returns the final pixels for the entire output.
            assert image.getpixel((60, 60))[:3] == (0, 0, 255)
            assert image.getpixel((8, 8))[:3] == (0, 0, 255)
        with Image.open(io.BytesIO(generate_service._local_bytes(tasks[1].result_urls[0])[0])) as image:
            # 素材类结果直接来自模型，保留模型返回的透明通道。
            assert image.mode == "RGBA"
            assert image.getpixel((0, 0))[3] == 0
            assert image.getpixel((48, 48))[3] > 200
    assert len(calls) == 2, "整图修改和素材抠图都走图像模型"
    assert "第二个" not in calls[0][1]["prompt"]
    assert "第二个" in calls[1][1]["prompt"]


async def test_analysis_failure_never_dispatches_or_charges(client, monkeypatch):
    headers, session, uid, aid, before = await prepare(client)
    _, spawned = install(monkeypatch, failure=True)
    result = next(e["result"] for e in events(await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers)) if e["event"] == "result")
    assert result["status"] == "failed" and not spawned
    async with AsyncSessionLocal() as db: assert (await db.get(User, uid)).balance == before


async def test_hallucinated_region_never_dispatches(client, monkeypatch):
    headers, session, uid, aid, before = await prepare(client)
    _, spawned = install(monkeypatch, bad_region=True)
    result = next(e["result"] for e in events(await client.post("/api/chat/analyze", json=payload(session, aid), headers=headers)) if e["event"] == "result")
    assert result["status"] == "failed" and not spawned
    async with AsyncSessionLocal() as db: assert (await db.get(User, uid)).balance == before


def test_lasso_mask_keeps_pixels_outside_selected_path():
    op = generate_service.ops_module.EditOp(
        region={"x": 0.1, "y": 0.1, "w": 0.7, "h": 0.7},
        path=[{"x": 0.1, "y": 0.1}, {"x": 0.8, "y": 0.1}, {"x": 0.1, "y": 0.8}],
    )
    mask = generate_service._render_ops_mask(png(), [op])
    with Image.open(io.BytesIO(mask)) as image:
        alpha = image.getchannel("A")
        assert alpha.getpixel((14, 14)) == 0
        assert alpha.getpixel((45, 45)) == 255
