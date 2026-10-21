"""产品口径（2026-10-17）：所有编辑操作一律提交上游 gpt-image-2，并按编辑单价计费。

这里锁死三条用户可见承诺：
1. 透明化 / 改样式等重绘类操作先调用上游；**抠图走本地确定性像素处理**，
   不送上游——上游会按「完整人物」补画框外内容（实测框到膝盖却补出了鞋）。
2. 发出去的提示词必须包含区域编号与能力内置说明（否则上游不知道要干什么）。
3. 编辑任务按产出数量计费；抠图不产生上游调用，也不应出现在上游调用里。
"""
from __future__ import annotations

import base64
import io
from pathlib import Path

import pytest
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


@pytest.fixture(autouse=True)
def _stub_optimizer(monkeypatch):
    """单测不联网：指令优化直接返回原指令。"""

    async def fake_optimize(db, instruction, **kwargs):
        return instruction, False

    monkeypatch.setattr(
        "app.services.generate_service.edit_prompt_service.optimize", fake_optimize
    )


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
    """记录上游调用。

    - 素材类请求（提示词带「纯透明背景」）→ 回显**输入裁块的透明版**：
      主体取裁块中心椭圆，其余置透明。这样测试既能断言"每个区域送的是自己的裁块"，
      也能断言后处理真的把 alpha 用起来了。
    - 其它请求 → 返回纯色图，模拟整图重绘。
    """

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, files, form):
        self.calls.append({"files": files, "form": form})
        if "纯透明背景" in form["prompt"]:
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


async def test_cutout_is_local_and_never_redraws(monkeypatch):
    """抠图 = 本地像素处理，**不调用上游**，结果只含框内原像素。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    _, task_id = await _create(
        uid,
        [{"region": {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""}],
        "把主体抠出来",
    )

    done = await _finish(task_id)
    assert not rec.calls, "抠图不得调用上游：上游会重绘并补出框外内容"
    assert done.status == "succeeded", done.error_message
    assert len(done.result_urls) == 1
    # 执行记录必须落库，前端据此在左侧展示
    thinking = (done.params or {}).get("thinking") or []
    assert len(thinking) >= 3
    assert any("素材" in step for step in thinking), thinking


async def test_mixed_ops_use_composite_upstream_plus_local_sprites(monkeypatch):
    """改样式 + 抠图：整图类合并 1 次上游，素材类每个区域本地各出一张。

    产出契约（与产品口径一致）：
    - 整图类（改样式/挖空/去物/增强）合并成 **1 次**调用，指令里含全部整图类区域；
    - 素材类（抠图）**每个区域各 1 张**，全部本地处理，不夹带任何整图类指令。
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
    assert len(rec.calls) == 1, "只有整图类需要上游；抠图本地完成"

    composite_prompt = rec.calls[0]["form"]["prompt"]
    # 整图类：只带区域1，并保留「选区外像素不变」的约束
    assert "区域1" in composite_prompt and "换成蓝色" in composite_prompt
    assert "区域2" not in composite_prompt, "整图类调用不应夹带素材类区域"
    assert "mask 外的像素保持原样" in composite_prompt
    # 整图类必须带 mask（硬约束「只改选区」，而不是靠提示词自觉）
    assert any(field == "mask" for field, _payload in rec.calls[0]["files"])

    # 产出数量：1 张修改图 + 1 张本地抠出的透明素材
    assert len(done.result_urls) == 2
    outputs = (done.params or {}).get("outputs") or []
    assert any(item.get("kind") == "sprite" for item in outputs)


async def test_each_cutout_region_yields_its_own_sprite(monkeypatch):
    """两个抠图区域必须各自产出「自己那一块」，且不调用上游。

    回归（2026-10-21 实测）：两张裁剪图分别送给上游时，上游会重画主体；
    框了两处却返回同一个居中主体，还会按「完整人物」补画框外内容。
    现在改为本地按区域逐像素裁切+分离背景，两个区域天然得到两张不同素材。
    """
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    # 左半红、右半蓝：两个区域的裁块内容必然不同，可直接用像素断言
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
    assert not rec.calls, "两个区域都在本地处理，不得调用上游"

    colors = []
    for url in done.result_urls:
        with _load(url) as sprite:
            opaque = [px[:3] for px in sprite.convert("RGBA").getdata() if px[3] > 200]
        assert opaque, "每个区域都应有可见主体"
        colors.append(max(set(opaque), key=opaque.count))
    assert colors[0][0] > colors[0][2], colors
    assert colors[1][2] > colors[1][0], colors
    assert colors[0] != colors[1], "两个区域必须各自裁自己的那一块"




async def test_transparent_calls_upstream(monkeypatch):
    """就地透明化同样先提交上游，再按选区合成并保留外部原像素。"""
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
    assert done.status == "succeeded", done.error_message
