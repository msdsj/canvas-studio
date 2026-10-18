"""画笔自由选区的并集掩码：前端上行掩码必须真正被上游用上。

覆盖三条用户可见承诺：

1. **前端掩码优先**：矩形 / 套索 / 画笔笔迹在前端合成一张「透明=可编辑」的掩码，
   后端必须直接用它（否则画笔与套索的精度会被包围盒抹平）；
2. **失败不阻断**：掩码缺失或损坏时回退到自动生成，任务仍然能出图；
3. **素材类不被全局掩码污染**：per-region（抠图）每个区域各调用一次，
   每次只能带「这一个区域」的掩码。
"""
from __future__ import annotations

import base64
import io

import pytest
import pytest_asyncio
from PIL import Image, ImageDraw
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal, Base, engine
from app.models.generation import GenerationTask
from app.models.user import User
from app.services import asset_service, generate_service
from app.utils.ids import new_id

# 底图与掩码统一 64x64，便于逐像素断言
BASE_SIZE = (64, 64)
# 中心的整图类选区：后端自动生成的掩码只在这个范围内透明
CENTER_REGION = {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}
# 左上角一小块（在 CENTER_REGION 之外）：自动生成的掩码在这里是不透明的
OUTSIDE_POINT = (2, 2)
# 中心点：自动生成的掩码在这里透明
INSIDE_POINT = (32, 32)


@pytest_asyncio.fixture(autouse=True)
async def _ensure_schema():
    """确保表结构存在（不 drop、不 seed）。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


# --------------------------------------------------------------------------- #
# 构造器
# --------------------------------------------------------------------------- #
def _base_png() -> bytes:
    """纯白底图。"""
    buf = io.BytesIO()
    Image.new("RGB", BASE_SIZE, (255, 255, 255)).save(buf, format="PNG")
    return buf.getvalue()


def _brush_mask_png() -> bytes:
    """模拟「画笔自由选区」的并集掩码：只有一条细斜线是透明的。

    它与**任何矩形掩码都不同**：斜线中段的取样点在透明区，而包围盒内、
    远离斜线的取样点必须保持不透明——一旦后端改用自动生成的矩形掩码，
    这两条断言都会失败，因此它能真正区分「用了前端掩码」和「没用」。
    """
    mask = Image.new("RGBA", BASE_SIZE, (255, 255, 255, 255))
    draw = ImageDraw.Draw(mask)
    # 画笔笔迹：从 (4,4) 到 (56,56) 的粗斜线，alpha=0 表示允许修改
    draw.line([(4, 4), (56, 56)], fill=(255, 255, 255, 0), width=9)
    buf = io.BytesIO()
    mask.save(buf, format="PNG")
    return buf.getvalue()


def _mask_transparent_at(mask_bytes: bytes, point: tuple[int, int]) -> bool:
    """掩码在某个像素上是否「允许修改」（alpha 接近 0）。"""
    with Image.open(io.BytesIO(mask_bytes)) as image:
        rgba = image.convert("RGBA")
    return rgba.getchannel("A").getpixel(point) <= 8


def _sent_mask(call: dict) -> bytes:
    """取出一次上游调用实际发送的 mask 字节。"""
    for field, payload in call["files"]:
        if field == "mask":
            return payload[1]
    raise AssertionError("本次上游调用没有携带 mask")


def _png_b64() -> str:
    """上游返回一张合法 PNG。"""
    buf = io.BytesIO()
    Image.new("RGB", BASE_SIZE, (200, 40, 40)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class _Recorder:
    """记录上游调用；返回一张合法 PNG。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, files, form):
        self.calls.append({"files": files, "form": form})
        return {"data": [{"b64_json": _png_b64()}], "demo": False}


# --------------------------------------------------------------------------- #
# 数据库辅助
# --------------------------------------------------------------------------- #
async def _make_user(balance: int = 400) -> str:
    async with AsyncSessionLocal() as db:
        user = User(
            id=new_id(),
            email=f"mask-{new_id()[:8]}@example.com",
            password_hash="x",
            status="active",
            role="user",
            balance=balance,
        )
        db.add(user)
        await db.commit()
        return user.id


async def _make_asset(uid: str, data: bytes, filename: str) -> str:
    """把图片字节写成资产，返回对外 URL（后端用 _local_bytes 反解本地路径）。"""
    async with AsyncSessionLocal() as db:
        asset = await asset_service.create_from_bytes(
            db, uid, data, kind="uploaded", filename=filename, content_type="image/png"
        )
        await db.commit()
        return asset.url


async def _create_task(
    uid: str,
    ops: list[dict],
    *,
    mask_url: str | None = None,
    prompt: str = "按区域处理",
) -> str:
    base_url = await _make_asset(uid, _base_png(), "base.png")
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
            mask_url=mask_url,
            edit_ops=ops,
        )
        return task.id


async def _finish(task_id: str) -> GenerationTask:
    await generate_service.run_task(task_id)
    async with AsyncSessionLocal() as db:
        return (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one()


# --------------------------------------------------------------------------- #
# 1) 前端掩码优先
# --------------------------------------------------------------------------- #
async def test_uploaded_brush_mask_is_used(monkeypatch):
    """带 mask_url 时，发给上游的是前端那张掩码（形状与尺寸都对得上）。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    mask_url = await _make_asset(uid, _brush_mask_png(), "edit-mask.png")
    task_id = await _create_task(
        uid,
        [{"region": CENTER_REGION, "handler": "restyle", "prompt": "换成蓝色"}],
        mask_url=mask_url,
    )

    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message
    assert len(rec.calls) == 1, "整图类区域应合并为一次调用"

    call = rec.calls[0]
    mask_ref = next(payload for field, payload in call["files"] if field == "mask")
    assert mask_ref[0] == "mask.png"
    assert mask_ref[2] == "image/png"

    mask_bytes = _sent_mask(call)
    with Image.open(io.BytesIO(mask_bytes)) as image:
        assert image.size == BASE_SIZE, "掩码尺寸必须与底图一致"

    # 画笔笔迹处透明（可编辑）—— 自动生成的矩形掩码在这里是不透明的
    assert _mask_transparent_at(mask_bytes, INSIDE_POINT) is True, "前端掩码的笔迹区域必须保留为可编辑"
    # 包围盒内、但笔迹之外的位置不透明（保留）—— 矩形掩码会把它标成可编辑
    assert _mask_transparent_at(mask_bytes, (14, 50)) is False, "笔迹之外必须保持不透明"


async def test_mask_is_resized_to_base_size(monkeypatch):
    """掩码尺寸与底图不一致时，按底图尺寸重采样（上游要求两者同尺寸）。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    small = Image.new("RGBA", (16, 16), (255, 255, 255, 255))
    ImageDraw.Draw(small).rectangle([0, 0, 7, 7], fill=(255, 255, 255, 0))
    buf = io.BytesIO()
    small.save(buf, format="PNG")
    mask_url = await _make_asset(uid, buf.getvalue(), "small-mask.png")

    task_id = await _create_task(
        uid,
        [{"region": CENTER_REGION, "handler": "restyle", "prompt": "换成蓝色"}],
        mask_url=mask_url,
    )
    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message

    with Image.open(io.BytesIO(_sent_mask(rec.calls[0]))) as image:
        assert image.size == BASE_SIZE
        # 左上 1/4 在缩略图里是透明的，放大后左上角仍然透明
        assert image.convert("RGBA").getchannel("A").getpixel(OUTSIDE_POINT) <= 8


# --------------------------------------------------------------------------- #
# 2) 缺失 / 损坏时回退
# --------------------------------------------------------------------------- #
async def test_missing_mask_falls_back_to_generated(monkeypatch):
    """没有 mask_url 时，回退到按选区自动生成掩码。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    task_id = await _create_task(
        uid, [{"region": CENTER_REGION, "handler": "restyle", "prompt": "换成蓝色"}]
    )
    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message
    assert len(rec.calls) == 1

    mask_bytes = _sent_mask(rec.calls[0])
    assert _mask_transparent_at(mask_bytes, INSIDE_POINT) is True, "选区中心应可编辑"
    assert _mask_transparent_at(mask_bytes, OUTSIDE_POINT) is False, "选区外必须保留"


async def test_broken_mask_url_falls_back_to_generated(monkeypatch):
    """mask_url 指向不存在的文件时，不报错，改用自动生成的掩码。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    ghost = f"{settings.storage_public_base.rstrip('/')}/ghost/not-exist.png"
    task_id = await _create_task(
        uid,
        [{"region": CENTER_REGION, "handler": "restyle", "prompt": "换成蓝色"}],
        mask_url=ghost,
    )
    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message

    mask_bytes = _sent_mask(rec.calls[0])
    assert _mask_transparent_at(mask_bytes, INSIDE_POINT) is True
    assert _mask_transparent_at(mask_bytes, OUTSIDE_POINT) is False


# --------------------------------------------------------------------------- #
# 3) 素材类不被全局掩码污染
# --------------------------------------------------------------------------- #
async def test_sprite_call_uses_single_region_mask(monkeypatch):
    """抠图（素材类）即使带了全局掩码，也只用自己区域的掩码。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    mask_url = await _make_asset(uid, _brush_mask_png(), "edit-mask.png")
    task_id = await _create_task(
        uid,
        [{"region": CENTER_REGION, "handler": "cutout", "prompt": ""}],
        mask_url=mask_url,
    )
    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message
    assert len(rec.calls) == 1, "单个素材区域只调用一次"

    mask_bytes = _sent_mask(rec.calls[0])
    # 全局掩码的斜线起点在左上角；若用了它，(2,2) 会是透明的
    assert _mask_transparent_at(mask_bytes, OUTSIDE_POINT) is False, "素材调用不得使用全局并集掩码"
    assert _mask_transparent_at(mask_bytes, INSIDE_POINT) is True, "素材调用必须只挖开自己这一块"


async def test_two_sprite_regions_get_their_own_masks(monkeypatch):
    """两个素材区域各调用一次，每次的掩码只包含自己那一块。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    left = {"x": 0.05, "y": 0.05, "w": 0.3, "h": 0.3}
    right = {"x": 0.6, "y": 0.6, "w": 0.3, "h": 0.3}
    uid = await _make_user()
    mask_url = await _make_asset(uid, _brush_mask_png(), "edit-mask.png")
    task_id = await _create_task(
        uid,
        [
            {"region": left, "handler": "cutout", "prompt": ""},
            {"region": right, "handler": "cutout", "prompt": ""},
        ],
        mask_url=mask_url,
    )
    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message
    assert len(rec.calls) == 2, "每个素材区域各一次调用"

    left_point = (int(0.2 * BASE_SIZE[0]), int(0.2 * BASE_SIZE[1]))
    right_point = (int(0.75 * BASE_SIZE[0]), int(0.75 * BASE_SIZE[1]))
    for call in rec.calls:
        mask_bytes = _sent_mask(call)
        opened = _mask_transparent_at(mask_bytes, left_point)
        closed = _mask_transparent_at(mask_bytes, right_point)
        assert opened != closed, "每次调用的掩码只应包含自己那个区域"
    assert done.result_urls, "两个素材都应产出结果"


# --------------------------------------------------------------------------- #
# 4) 自动生成的掩码跟随自由选区轮廓
# --------------------------------------------------------------------------- #
async def test_generated_mask_follows_lasso_path(monkeypatch):
    """没有前端掩码时，套索多边形应参与掩码生成，而不是退化成包围盒。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    # 三角形：包围盒是左上 0.1~0.9，但右上角在三角形之外
    path = [
        {"x": 0.1, "y": 0.1},
        {"x": 0.9, "y": 0.1},
        {"x": 0.1, "y": 0.9},
    ]
    task_id = await _create_task(
        uid,
        [
            {
                "region": {"x": 0.1, "y": 0.1, "w": 0.8, "h": 0.8},
                "path": path,
                "handler": "restyle",
                "prompt": "换成蓝色",
            }
        ],
    )
    done = await _finish(task_id)
    assert done.status == "succeeded", done.error_message

    mask_bytes = _sent_mask(rec.calls[0])
    # 三角形内部（靠近左下）透明
    assert _mask_transparent_at(mask_bytes, (12, 40)) is True
    # 包围盒内、斜边之外（右上角）→ 必须保持不透明（矩形掩码会把它也挖开）
    assert _mask_transparent_at(mask_bytes, (50, 20)) is False, "套索轮廓必须被尊重，不能退化成矩形"
