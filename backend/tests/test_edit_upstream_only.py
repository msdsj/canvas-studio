"""产品契约：每种图片编辑（包括抠图和透明化）都调用图像模型并按编辑产出计费。

选区掩码用于指导 GPT Image；编辑结果直接使用模型返回的图片。模型未返回抠图所需的
透明通道时拒绝结果并退款，不运行本地分割或合成。
"""
from __future__ import annotations

import base64
import io
from pathlib import Path

import pytest_asyncio
from PIL import Image, ImageChops, ImageDraw
from sqlalchemy import select

from app.database import AsyncSessionLocal, Base, engine
from app.models.generation import GenerationTask
from app.models.user import User
from app.services import asset_service, generate_service, storage_service
from app.utils.ids import new_id


@pytest_asyncio.fixture(autouse=True)
async def _ensure_schema():
    """确保表结构存在（不 drop、不 seed）。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


async def _make_user(balance: int = 200) -> str:
    async with AsyncSessionLocal() as db:
        user = User(
            id=new_id(),
            email=f"up-{new_id()[:8]}@example.com",
            password_hash="x",
            status="active",
            role="user",
            balance=balance,
        )
        db.add(user)
        await db.commit()
        return user.id


def _make_asset_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (255, 255, 255)).save(buf, format="PNG")
    return buf.getvalue()


async def _make_asset(uid: str) -> str:
    return await _make_asset_from(uid, _make_asset_bytes())


async def _make_asset_from(uid: str, raw: bytes) -> str:
    async with AsyncSessionLocal() as db:
        asset = await asset_service.create_from_bytes(
            db, uid, raw, kind="uploaded", filename="base.png", content_type="image/png"
        )
        await db.commit()
        return asset.url


def _png_b64(color: tuple[int, int, int] = (200, 40, 40), *, alpha: Image.Image | None = None) -> str:
    buf = io.BytesIO()
    image = Image.new("RGB", (64, 64), color)
    if alpha is not None:
        image.putalpha(alpha)
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class _Recorder:
    """记录 GPT Image 请求，并返回明确可识别的透明结果。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, files, form):
        self.calls.append({"files": files, "form": form})
        if form.get("background") == "transparent":
            image_bytes = files[0][1][1]
            with Image.open(io.BytesIO(image_bytes)) as opened:
                src = opened.convert("RGBA")
            width, height = src.size
            alpha = Image.new("L", src.size, 0)
            ImageDraw.Draw(alpha).ellipse(
                (round(width * 0.2), round(height * 0.2), round(width * 0.8), round(height * 0.8)),
                fill=255,
            )
            src.putalpha(alpha)
            buf = io.BytesIO()
            src.save(buf, format="PNG")
            return {
                "data": [{"b64_json": base64.b64encode(buf.getvalue()).decode()}],
                "demo": False,
            }
        return {"data": [{"b64_json": _png_b64()}], "demo": False}


def _load(url: str) -> Image.Image:
    """读取本地存储中的图片（URL → 磁盘路径）。"""
    rel = asset_service.local_path_from_url(url)
    assert rel, f"无法解析本地路径: {url}"
    return Image.open(Path(storage_service.storage_root()) / rel)


async def _create(uid: str, ops: list[dict], prompt: str) -> tuple[int, str]:
    base_url = await _make_asset(uid)
    async with AsyncSessionLocal() as db:
        task, _ = await generate_service.create_edit_task(
            db,
            uid,
            prompt=prompt,
            model="gpt-image-2",
            size="64x64",
            base_image_url=base_url,
            session_id=None,
            canvas_id=None,
            idempotency_key=new_id(),
            edit_ops=ops,
        )
        return task.cost, task.id


async def _finish(task_id: str) -> GenerationTask:
    await generate_service.run_task(task_id)
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one()


async def test_cutout_calls_image_model_and_keeps_alpha(monkeypatch):
    """Cutout is an image-model operation and its transparent output is used directly."""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    _, task_id = await _create(
        uid,
        [{"region": {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""}],
        "把主体抠出来",
    )

    done = await _finish(task_id)
    assert len(rec.calls) == 1
    assert done.status == "succeeded", done.error_message
    assert len(done.result_urls) == 1
    assert rec.calls[0]["form"]["background"] == "transparent"
    assert rec.calls[0]["form"]["output_format"] == "png"
    assert [field for field, _ in rec.calls[0]["files"]] == ["image", "image", "mask"]
    with _load(done.result_urls[0]) as output:
        assert output.mode == "RGBA"
        assert output.getpixel((0, 0))[3] == 0
    # 执行记录必须落库，前端据此在左侧展示
    thinking = (done.params or {}).get("thinking") or []
    assert len(thinking) >= 3
    assert any("素材" in step for step in thinking), thinking


async def test_model_image_bytes_are_saved_without_transcoding(monkeypatch):
    """The stored asset must retain the exact bytes and format returned by the model."""
    output = io.BytesIO()
    Image.new("RGB", (48, 32), (30, 80, 180)).save(output, format="JPEG", quality=91)
    model_bytes = output.getvalue()

    async def edits(_files, _form):
        return {
            "data": [{"b64_json": base64.b64encode(model_bytes).decode()}],
            "demo": False,
        }

    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", edits)
    uid = await _make_user()
    _, task_id = await _create(
        uid,
        [{"region": {"x": 0.2, "y": 0.2, "w": 0.5, "h": 0.5}, "handler": "restyle", "prompt": "调整色调"}],
        "调整选区色调",
    )

    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message
    stored, extension = generate_service._local_bytes(done.result_urls[0])
    assert stored == model_bytes
    assert extension == "jpg"


async def test_mixed_ops_use_upstream_for_composite_and_sprites(monkeypatch):
    """改样式 + 抠图：整图编辑和透明素材都调用图片模型。

    产出契约（与产品口径一致）：
    - 整图类操作合并成 **1 次**调用；
    - 素材类每个区域各调用一次，并单独输出透明素材。
    """
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    cost, task_id = await _create(
        uid,
        [
            {"region": {"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}, "handler": "restyle", "prompt": "换成蓝色"},
            {"region": {"x": 0.5, "y": 0.5, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""},
        ],
        "按区域处理",
    )
    assert cost > 0
    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message
    assert len(rec.calls) == 2, "整图修改与抠图均须调用上游"

    composite_prompt = rec.calls[0]["form"]["prompt"]
    # 整图类：只带区域1，并保留「选区外像素不变」的约束
    assert "区域1" in composite_prompt and "换成蓝色" in composite_prompt
    assert "区域2" not in composite_prompt, "整图类调用不应夹带素材类区域"
    assert "mask 外的像素保持原样" in composite_prompt
    # 整图类必须带 mask（硬约束「只改选区」，而不是靠提示词自觉）
    assert any(field == "mask" for field, _payload in rec.calls[0]["files"])
    assert "区域2" in rec.calls[1]["form"]["prompt"]
    assert rec.calls[1]["form"]["background"] == "transparent"

    # 产出数量：1 张修改图 + 1 张模型生成的透明素材
    assert len(done.result_urls) == 2
    outputs = (done.params or {}).get("outputs") or []
    assert any(item.get("kind") == "sprite" for item in outputs)


async def test_each_cutout_region_yields_its_own_sprite(monkeypatch):
    """每个抠图区域单独发送给模型，模型分别返回透明素材。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    # 两个区域使用不同颜色，避免测试输入被意外替换为一个合并后的请求。
    canvas = Image.new("RGB", (64, 64), (220, 30, 30))
    ImageDraw.Draw(canvas).rectangle((32, 0, 63, 63), fill=(30, 60, 220))
    buf = io.BytesIO()
    canvas.save(buf, format="PNG")
    base_url = await _make_asset_from(uid, buf.getvalue())

    async with AsyncSessionLocal() as db:
        task, _ = await generate_service.create_edit_task(
            db,
            uid,
            prompt="把这两个都抠出来",
            model="gpt-image-2",
            size="64x64",
            base_image_url=base_url,
            session_id=None,
            canvas_id=None,
            idempotency_key=new_id(),
            edit_ops=[
                {"region": {"x": 0.0, "y": 0.0, "w": 0.25, "h": 1.0}, "handler": "cutout", "prompt": ""},
                {"region": {"x": 0.75, "y": 0.0, "w": 0.25, "h": 1.0}, "handler": "cutout", "prompt": ""},
            ],
        )

    done = await _finish(task.id)
    assert done.status == "succeeded", done.error_message
    assert len(done.result_urls) == 2, "两个区域必须各出一张素材"
    assert len(rec.calls) == 2
    assert all(call["form"]["background"] == "transparent" for call in rec.calls)
    assert [field for field, _ in rec.calls[0]["files"]] == ["image", "image", "mask"]
    assert rec.calls[0]["files"][2][1][1] != rec.calls[1]["files"][2][1][1]




async def test_transparent_calls_upstream(monkeypatch):
    """透明化 requests a transparent PNG from the image model and uses it directly."""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    cost, task_id = await _create(
        uid,
        [{"region": {"x": 0.2, "y": 0.2, "w": 0.5, "h": 0.5}, "handler": "transparent", "prompt": ""}],
        "把这里挖空",
    )
    assert cost > 0
    done = await _finish(task_id)
    assert len(rec.calls) == 1
    assert "透明" in rec.calls[0]["form"]["prompt"]
    assert rec.calls[0]["form"]["background"] == "transparent"
    assert rec.calls[0]["form"]["output_format"] == "png"
    assert done.status == "succeeded", done.error_message
    with _load(done.result_urls[0]) as output:
        assert output.mode == "RGBA"
        assert output.getpixel((32, 32))[3] > 200


async def test_opaque_cutout_result_fails_and_refunds(monkeypatch):
    """模型未返回透明像素时失败退款，不运行本地抠图兜底。"""
    opaque = io.BytesIO()
    Image.new("RGB", (64, 64), (200, 40, 40)).save(opaque, format="PNG")
    returned = base64.b64encode(opaque.getvalue()).decode()

    async def edits(_files, form):
        assert form["background"] == "transparent"
        return {"data": [{"b64_json": returned}], "demo": False}

    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", edits)
    uid = await _make_user()
    cost, task_id = await _create(
        uid,
        [{"region": {"x": 0.2, "y": 0.2, "w": 0.5, "h": 0.5}, "handler": "cutout", "prompt": ""}],
        "把主体抠出来",
    )

    done = await _finish(task_id)
    assert cost > 0
    assert done.status == "failed"
    assert "透明背景" in (done.error_message or "")
    async with AsyncSessionLocal() as db:
        user = await db.get(User, uid)
        assert user is not None and user.balance == 200
