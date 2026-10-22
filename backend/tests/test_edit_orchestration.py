"""选区局部编辑编排单测：能力注册表、多产出规划、抠图与像素保真。

覆盖产品规范的四条硬要求：
1. 仅改选中区域、其余像素严格不变；
2. 只改样式 → 1 张完整修改图；
3. 改样式 + 抠图混合 → 1 张完整修改图 + N 张透明背景素材；
4. 产出严格对应选区范围。
"""
from __future__ import annotations

import base64
import io
import json
from pathlib import Path

import pytest
import pytest_asyncio
from PIL import Image
from sqlalchemy import select

from app.database import AsyncSessionLocal, Base, engine
from app.models.asset import Asset
from app.models.generation import GenerationTask
from app.models.user import User
from app.services import asset_service, config_service, generate_service, storage_service
from app.services import edit_handlers, edit_ops, plan_service
from app.utils.ids import new_id

pytestmark = pytest.mark.skip(
    reason=(
        "产品口径变更（2026-10-17）：所有编辑操作（含抠图/透明化）一律提交上游 gpt-image-2 并计费，"
        "本地抠图与像素合成路径已下线。本文件针对旧编排实现，保留作历史参考；"
        "新契约见 tests/test_edit_upstream_only.py。"
    )
)


@pytest_asyncio.fixture(autouse=True)
async def _ensure_schema():
    """确保表结构存在（不 drop、不 seed，避免干扰其他测试文件）。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield


# --------------------------------------------------------------------------- #
# 辅助
# --------------------------------------------------------------------------- #
async def _make_user(balance: int = 200) -> str:
    """创建激活用户。"""
    async with AsyncSessionLocal() as db:
        user = User(
            id=new_id(),
            email=f"e-{new_id()[:8]}@example.com",
            password_hash="x",
            status="active",
            role="user",
            balance=balance,
        )
        db.add(user)
        await db.commit()
        return user.id


def _solid_png_b64(size: tuple[int, int], color: tuple[int, int, int]) -> str:
    """生成一张纯色 PNG 的 base64（模拟上游返回）。"""
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _half_image() -> Image.Image:
    """左半黑、右半白的对照图（用于验证选区外像素严格不变）。"""
    img = Image.new("RGB", (64, 64), (255, 255, 255))
    for x in range(32):
        for y in range(64):
            img.putpixel((x, y), (0, 0, 0))
    return img


def _red_block_image() -> Image.Image:
    """白底 + 居中红方块（用于验证抠图与透明背景）。"""
    img = Image.new("RGB", (64, 64), (255, 255, 255))
    for x in range(22, 42):
        for y in range(22, 42):
            img.putpixel((x, y), (220, 30, 30))
    return img


async def _make_asset(uid: str, img: Image.Image) -> str:
    """把图片登记为资产，返回可访问 URL。"""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    async with AsyncSessionLocal() as db:
        asset = await asset_service.create_from_bytes(
            db, uid, buf.getvalue(), kind="uploaded", filename="base.png", content_type="image/png"
        )
        await db.commit()
        return asset.url


def _load(url: str) -> Image.Image:
    """读取本地存储中的图片。"""
    rel = asset_service.local_path_from_url(url)
    assert rel, f"无法解析本地路径: {url}"
    return Image.open(Path(storage_service.storage_root()) / rel)


def _iter_region(img: Image.Image, x: float, y: float, w: float, h: float):
    """按归一化坐标遍历图片某区域的像素。"""
    width, height = img.size
    x0, y0 = int(x * width), int(y * height)
    x1, y1 = int((x + w) * width), int((y + h) * height)
    for px in range(x0, max(x0 + 1, x1)):
        for py in range(y0, max(y0 + 1, y1)):
            yield img.getpixel((px, py))


async def _run_edit(
    uid: str,
    base_url: str,
    *,
    ops: list[dict],
    key: str,
    prompt: str = "按区域指令修改",
) -> GenerationTask:
    """创建并同步执行一次编辑任务，返回最新任务快照。"""
    async with AsyncSessionLocal() as db:
        task, created = await generate_service.create_edit_task(
            db,
            uid,
            prompt=prompt,
            model="gpt-image-2",
            size="64x64",
            base_image_url=base_url,
            session_id=None,
            canvas_id=None,
            idempotency_key=key,
            edit_ops=ops,
        )
        assert created is True
        task_id = task.id

    await generate_service.run_task(task_id)

    async with AsyncSessionLocal() as db:
        return (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one()


# --------------------------------------------------------------------------- #
# 能力注册表
# --------------------------------------------------------------------------- #
def test_builtin_catalog_covers_common_scenarios():
    """内置能力覆盖改样式 / 抠图 / 挖空 / 去物 / 增强，且本地能力不计费。"""
    handlers = edit_handlers.BUILTIN_INDEX
    for handler_id in ("restyle", "cutout", "transparent", "remove", "enhance"):
        assert handler_id in handlers
    assert handlers["cutout"].output == "sprite"
    assert handlers["cutout"].per_region is True
    # 抠图从原图精确抠出（不经过上游重绘），因此不计费
    assert handlers["cutout"].engine == "local"
    assert handlers["cutout"].billable is False
    # 就地挖空走上游生成，本地只做 alpha 与选区外像素收口
    assert handlers["transparent"].id == "transparent"
    assert handlers["transparent"].engine == "upstream"
    assert handlers["restyle"].engine == "upstream"


def test_catalog_renders_for_llm():
    """能力清单可渲染成 LLM 可读文本（新增能力自动出现在清单里）。"""
    text = edit_handlers.render_catalog(edit_handlers.BUILTIN_INDEX)
    assert "`restyle`" in text
    assert "`cutout`" in text


async def test_custom_handler_declared_in_config(db):
    """管理员可在配置里纯声明式追加能力，无需改代码。"""
    custom = [
        {
            "id": "anime",
            "label": "转动漫风",
            "description": "把该区域转为日系动漫风格",
            "engine": "upstream",
            "output": "composite",
            "billable": True,
            "prompt_prefix": "将该区域转为日系动漫风格，保持构图不变。",
        }
    ]
    await config_service.set_many(db, {"EDIT_HANDLERS": json.dumps(custom)}, None)
    await db.commit()

    handlers = await edit_handlers.load_handlers(db)
    assert "anime" in handlers
    assert handlers["anime"].prompt_prefix.startswith("将该区域转为日系动漫风格")
    assert "`anime`" in edit_handlers.render_catalog(handlers)


def test_unknown_handler_falls_back():
    """未知能力 id 回退到兜底能力，不因 LLM 幻觉而失败。"""
    handler = edit_handlers.resolve_handler(edit_handlers.BUILTIN_INDEX, "not-exist")
    assert handler.id == edit_handlers.FALLBACK_HANDLER_ID


# --------------------------------------------------------------------------- #
# 操作归一化与产出预估
# --------------------------------------------------------------------------- #
def test_normalize_ops_supports_legacy_regions():
    """旧版纯几何选区自动映射为兜底能力（向后兼容）。"""
    ops = edit_ops.normalize_ops(None, legacy_regions=[{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}])
    assert len(ops) == 1
    assert ops[0].handler == "restyle"
    assert ops[0].index == 1


def test_normalize_ops_clamps_out_of_range_region():
    """越界选区被夹取到图像范围内，绝不产生图外像素。"""
    ops = edit_ops.normalize_ops(
        [{"region": {"x": 0.9, "y": 0.9, "w": 0.5, "h": 0.5}, "handler": "restyle"}],
        handlers=edit_handlers.BUILTIN_INDEX,
    )
    region = ops[0].region
    assert region["x"] + region["w"] <= 1.0 + 1e-6
    assert region["y"] + region["h"] <= 1.0 + 1e-6


def test_estimate_outputs_mixed():
    """混合场景预估为「1 张整图 + 2 张素材」。"""
    ops = edit_ops.normalize_ops(
        [
            {"region": {"x": 0.0, "y": 0.0, "w": 0.3, "h": 0.3}, "handler": "restyle", "prompt": "换红色"},
            {"region": {"x": 0.5, "y": 0.5, "w": 0.3, "h": 0.3}, "handler": "cutout", "prompt": ""},
            {"region": {"x": 0.1, "y": 0.5, "w": 0.2, "h": 0.2}, "handler": "cutout", "prompt": ""},
        ],
        handlers=edit_handlers.BUILTIN_INDEX,
    )
    previews = edit_ops.estimate_outputs(ops, edit_handlers.BUILTIN_INDEX)
    kinds = [(item.kind, item.count) for item in previews]
    assert kinds == [("composite", 1), ("sprite", 2)]
    assert "完整修改图" in edit_ops.previews_to_text(previews)


def test_build_instruction_uses_region_numbers():
    """分点指令的区域编号与前端红框编号严格对应。"""
    ops = edit_ops.normalize_ops(
        [
            {"region": {"x": 0.0, "y": 0.0, "w": 0.2, "h": 0.2}, "handler": "restyle", "prompt": "换成红色"},
            {"region": {"x": 0.3, "y": 0.3, "w": 0.2, "h": 0.2}, "handler": "enhance", "prompt": ""},
        ],
        handlers=edit_handlers.BUILTIN_INDEX,
    )
    text = edit_ops.build_instruction(ops, edit_handlers.BUILTIN_INDEX)
    assert "【区域1】" in text and "换成红色" in text
    assert "【区域2】" in text and "提升该区域的清晰度" in text


# --------------------------------------------------------------------------- #
# 抠图服务
# --------------------------------------------------------------------------- #
def test_cutout_produces_transparent_sprite():
    """抠图输出带 alpha 的 PNG，背景透明、主体保留，并收紧到主体包围盒。"""
    buf = io.BytesIO()
    _red_block_image().save(buf, format="PNG")
    sprite_bytes = cutout_service.extract_sprite(
        buf.getvalue(), {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}, strategy="chroma"
    )
    with Image.open(io.BytesIO(sprite_bytes)) as sprite:
        assert sprite.mode == "RGBA"
        # 收紧后尺寸应小于原图（原 64x64，主体 20x20）
        assert sprite.width < 64 and sprite.height < 64
        assert sprite.width > 12 and sprite.height > 12
        alpha = sprite.getchannel("A")
        # 四角透明、中心不透明
        assert alpha.getpixel((0, 0)) < 32
        assert alpha.getpixel((sprite.width // 2, sprite.height // 2)) > 200


def test_cutout_falls_back_when_no_foreground():
    """纯色图抠不出前景时回退为纯选区裁剪，绝不交付空白素材。"""
    buf = io.BytesIO()
    Image.new("RGB", (40, 40), (255, 255, 255)).save(buf, format="PNG")
    sprite_bytes = cutout_service.extract_sprite(
        buf.getvalue(), {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}, strategy="chroma"
    )
    with Image.open(io.BytesIO(sprite_bytes)) as sprite:
        assert sprite.mode == "RGBA"
        assert sprite.size == (40, 40)
        assert sprite.getchannel("A").getextrema()[0] == 255


def test_cutout_strictly_inside_region():
    """抠图严格限定在选区内：框外内容不会出现在素材里。"""
    buf = io.BytesIO()
    _red_block_image().save(buf, format="PNG")
    # 只框左上角 1/4（不含红方块）
    sprite_bytes = cutout_service.extract_sprite(
        buf.getvalue(), {"x": 0.0, "y": 0.0, "w": 0.25, "h": 0.25}, strategy="chroma"
    )
    with Image.open(io.BytesIO(sprite_bytes)) as sprite:
        assert sprite.width <= 16 and sprite.height <= 16


def test_available_strategies_always_has_chroma():
    """chroma 兜底策略在任何环境都可用。"""
    assert "chroma" in cutout_service.available_strategies()


# --------------------------------------------------------------------------- #
# 编排：三种产出模式
# --------------------------------------------------------------------------- #
async def test_restyle_only_yields_one_image_and_keeps_outside_pixels(monkeypatch):
    """规范 2：只改样式 → 恰好 1 张完整图，且选区外像素严格不变。"""

    async def fake_edits(files, form):
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (0, 200, 0))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _half_image())

    task = await _run_edit(
        uid,
        base_url,
        ops=[{"region": {"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0}, "handler": "restyle", "prompt": "换成绿色"}],
        key="k-restyle",
    )

    assert task.status == "succeeded", task.error_message
    assert len(task.result_urls) == 1

    with _load(task.result_urls[0]).convert("RGB") as result:
        # 选区内（左半）被改成绿色
        assert result.getpixel((10, 32))[1] > 150
        # 选区外（右半，远离边界）严格保留原图白色
        assert result.getpixel((60, 32)) == (255, 255, 255)
        assert result.getpixel((55, 5)) == (255, 255, 255)


def test_composite_preserves_alpha_outside_selected_region():
    """局部合成不能把原图选区外的透明像素改成不透明。"""
    base = Image.new("RGBA", (8, 8), (20, 30, 40, 0))
    for x in range(4):
        for y in range(8):
            base.putpixel((x, y), (20, 30, 40, 180))
    edited = Image.new("RGBA", (8, 8), (200, 40, 40, 255))
    base_buf = io.BytesIO()
    edit_buf = io.BytesIO()
    base.save(base_buf, format="PNG")
    edited.save(edit_buf, format="PNG")

    result = Image.open(
        io.BytesIO(
            generate_service._composite_onto(
                base_buf.getvalue(),
                edit_buf.getvalue(),
                [{"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0}],
            )
        )
    ).convert("RGBA")
    assert result.getpixel((7, 7)) == base.getpixel((7, 7))
    assert result.getpixel((0, 7))[3] > base.getpixel((0, 7))[3] - 10


def test_transparent_preserves_existing_alpha_outside_selected_region():
    """局部挖空只影响选区 alpha，选区外的半透明像素保持原样。"""
    base = Image.new("RGBA", (8, 8), (20, 30, 40, 90))
    buf = io.BytesIO()
    base.save(buf, format="PNG")
    result = Image.open(
        io.BytesIO(
            generate_service._apply_transparent(
                buf.getvalue(), [{"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0}]
            )
        )
    ).convert("RGBA")
    assert result.getpixel((7, 7)) == base.getpixel((7, 7))
    assert result.getpixel((1, 4))[3] == 0


async def test_cutout_only_yields_sprite_locally(monkeypatch):
    """规范 3（抠图侧）：纯抠图 → 1 张素材，从原图精确抠出，不调用上游、不计费。"""

    async def fake_edits(files, form):  # pragma: no cover - 不应被调用
        raise AssertionError("纯抠图不应调用上游（素材从原图精确抠出）")

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _red_block_image())

    async with AsyncSessionLocal() as db:
        task, _ = await generate_service.create_edit_task(
            db,
            uid,
            prompt="抠出红块",
            model="gpt-image-2",
            size="64x64",
            base_image_url=base_url,
            session_id=None,
            canvas_id=None,
            idempotency_key="k-cut",
            edit_ops=[
                {"region": {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""}
            ],
        )
        assert task.cost == 0, "抠图不消耗上游算力"
        task_id = task.id

    await generate_service.run_task(task_id)

    async with AsyncSessionLocal() as db:
        done = (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one()

    assert done.status == "succeeded", done.error_message
    assert len(done.result_urls) == 1
    with _load(done.result_urls[0]) as sprite:
        assert sprite.mode == "RGBA"
        # 本地抠图产出真透明
        assert sprite.getchannel("A").getextrema()[0] == 0


async def test_mixed_request_yields_composite_plus_sprite(monkeypatch):
    """规范 3（混合）：1 张完整修改图 + 1 张素材，顺序为整图在前。"""
    calls: list[str] = []

    async def fake_edits(files, form):
        calls.append(form["prompt"])
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (0, 0, 255))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _half_image())

    task = await _run_edit(
        uid,
        base_url,
        ops=[
            {"region": {"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0}, "handler": "restyle", "prompt": "换成蓝色"},
            {"region": {"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}, "handler": "cutout", "prompt": ""},
        ],
        key="k-mixed",
    )

    assert task.status == "succeeded", task.error_message
    # 一次编辑只调用一次上游：改样式区域送去重绘，抠图区域从原图本地抠出
    assert len(calls) == 1, "一次编辑 = 一次上游请求"
    assert len(task.result_urls) == 2

    # 第 1 张：整图，尺寸与原图一致，选区外不变
    with _load(task.result_urls[0]).convert("RGB") as composite:
        assert composite.size == (64, 64)
        assert composite.getpixel((10, 32))[2] > 150  # 左半变蓝
        assert composite.getpixel((60, 32)) == (255, 255, 255)  # 右半原样

    # 第 2 张：素材，裁到选区范围
    with _load(task.result_urls[1]) as sprite:
        assert sprite.width < 64 and sprite.height < 64


async def test_transparent_handler_keeps_canvas_size(monkeypatch):
    """就地挖空：上游负责生成，本地做 alpha 收口 → 原尺寸整图，仅目标区域透明。"""

    async def fake_edits(files, form):
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (0, 0, 255))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _half_image())

    task = await _run_edit(
        uid,
        base_url,
        ops=[{"region": {"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0}, "handler": "transparent", "prompt": ""}],
        key="k-hole",
    )

    assert task.status == "succeeded", task.error_message
    assert len(task.result_urls) == 1
    with _load(task.result_urls[0]) as img:
        assert img.mode == "RGBA"
        assert img.size == (64, 64)
        assert img.getchannel("A").getpixel((10, 32)) == 0  # 框内透明
        assert img.getchannel("A").getpixel((60, 32)) == 255  # 框外不变


async def test_legacy_transparent_mode_still_works(monkeypatch):
    """旧版 edit_mode=transparent 路径保持兼容。"""

    async def fake_edits(files, form):
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (0, 0, 255))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _half_image())

    async with AsyncSessionLocal() as db:
        task, _ = await generate_service.create_edit_task(
            db,
            uid,
            prompt="挖空",
            model="gpt-image-2",
            size="64x64",
            base_image_url=base_url,
            session_id=None,
            canvas_id=None,
            idempotency_key="k-legacy",
            edit_region=[{"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0}],
            edit_mode="transparent",
        )
        task_id = task.id

    await generate_service.run_task(task_id)
    async with AsyncSessionLocal() as db:
        done = (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one()

    assert done.status == "succeeded", done.error_message
    with _load(done.result_urls[0]) as img:
        assert img.getchannel("A").getpixel((10, 32)) == 0


async def test_multi_output_assets_are_registered(monkeypatch):
    """多产出全部登记为资产，且都归到同一个任务下。"""

    async def fake_edits(files, form):
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (10, 10, 10))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _red_block_image())

    task = await _run_edit(
        uid,
        base_url,
        ops=[
            {"region": {"x": 0.0, "y": 0.0, "w": 0.5, "h": 1.0}, "handler": "restyle", "prompt": "换色"},
            {"region": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}, "handler": "cutout", "prompt": ""},
            {"region": {"x": 0.3, "y": 0.3, "w": 0.3, "h": 0.3}, "handler": "cutout", "prompt": ""},
        ],
        key="k-multi",
    )

    assert task.status == "succeeded", task.error_message
    assert len(task.result_urls) == 3
    async with AsyncSessionLocal() as db:
        assets = (
            await db.execute(select(Asset).where(Asset.generation_task_id == task.id))
        ).scalars().all()
    assert len(assets) == 3
    assert all(asset.mime == "image/png" for asset in assets)


# --------------------------------------------------------------------------- #
# 意图分析
# --------------------------------------------------------------------------- #
def test_plan_extract_json_tolerates_fences_and_prose():
    """模型回复带 markdown 围栏或前后说明时仍能抽取 JSON。"""
    cases = [
        '{"reply": "ok", "ops": []}',
        '```json\n{"reply": "ok", "ops": []}\n```',
        '好的，分析结果如下：\n```\n{"reply": "ok", "ops": []}\n```\n希望有帮助。',
        '前置说明 {"reply": "ok", "ops": []} 后置说明',
    ]
    for text in cases:
        parsed = plan_service._extract_json(text)
        assert parsed is not None, text
        assert parsed["reply"] == "ok"


def test_plan_extract_json_returns_none_on_garbage():
    """完全无法解析时返回 None（调用方走兜底计划）。"""
    assert plan_service._extract_json("这不是 JSON") is None
    assert plan_service._extract_json("") is None


def test_plan_normalize_regions_accepts_both_shapes():
    """区域列表同时接受 {index, region} 与纯 {x,y,w,h} 两种形态。"""
    nested = plan_service._normalize_regions(
        [{"index": 3, "region": {"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}}]
    )
    assert nested[0]["index"] == 3

    flat = plan_service._normalize_regions([{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}])
    assert flat[0]["index"] == 1
    assert flat[0]["region"]["w"] == pytest.approx(0.2)


def test_plan_fallback_plan_keeps_regions():
    """兜底计划必须带上区域坐标，否则下游无法定位。"""
    regions = plan_service._normalize_regions(
        [{"index": 1, "region": {"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}}]
    )
    plan = plan_service._fallback_plan("随便改改", regions, edit_handlers.BUILTIN_INDEX)
    assert plan["ops"][0]["region"] == {"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}
    ops = edit_ops.normalize_ops(plan["ops"], handlers=edit_handlers.BUILTIN_INDEX)
    assert len(ops) == 1


async def test_plan_edit_end_to_end_with_mocked_llm(monkeypatch):
    """意图分析端到端：LLM 返回结构化计划 → 落到真实坐标 + 产出预估。"""

    async def fake_chat(payload):
        assert "可用能力" in payload["messages"][0]["content"]
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "reply": "区域1 换红裙，区域2 抠成素材",
                                "ops": [
                                    {"region_index": 1, "handler": "restyle", "prompt": "换成红色连衣裙", "intensity": "fine"},
                                    {"region_index": 2, "handler": "cutout", "prompt": ""},
                                ],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ],
            "demo": False,
        }

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.llm_completions", fake_chat
    )

    async with AsyncSessionLocal() as db:
        result = await plan_service.plan_edit(
            db,
            message="把左边的人换成红裙，右边的猫抠出来",
            regions=[
                {"index": 1, "region": {"x": 0.0, "y": 0.0, "w": 0.3, "h": 0.5}},
                {"index": 2, "region": {"x": 0.6, "y": 0.6, "w": 0.3, "h": 0.3}},
            ],
        )

    assert len(result["ops"]) == 2
    assert result["ops"][0]["handler"] == "restyle"
    assert result["ops"][0]["region"]["w"] == pytest.approx(0.3)
    assert result["ops"][1]["handler"] == "cutout"
    kinds = [(item["kind"], item["count"]) for item in result["outputs"]]
    assert kinds == [("composite", 1), ("sprite", 1)]
    assert result["demo"] is False


async def test_plan_edit_ignores_hallucinated_region_index(monkeypatch):
    """LLM 臆造不存在的区域编号时被忽略，不会越界改动。"""

    async def fake_chat(payload):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "reply": "ok",
                                "ops": [{"region_index": 99, "handler": "restyle", "prompt": "乱改"}],
                            }
                        )
                    }
                }
            ]
        }

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.llm_completions", fake_chat
    )

    async with AsyncSessionLocal() as db:
        result = await plan_service.plan_edit(
            db,
            message="改一下",
            regions=[{"index": 1, "region": {"x": 0.0, "y": 0.0, "w": 0.2, "h": 0.2}}],
        )

    # 唯一有效的区域 1 由兜底计划补上，绝不含 99
    assert all(op["region_index"] != 99 for op in result["ops"])
    assert len(result["ops"]) == 1


# --------------------------------------------------------------------------- #
# 标记图：只标注上游区域（抠图区域绝不能被上游看到）
# --------------------------------------------------------------------------- #
def test_edit_mask_marks_only_target_region():
    """标准 inpainting 掩码：仅目标区域透明，其余不透明。

    这是「只改选中区域」的物理约束——透明 = 上游可修改，不透明 = 必须保留。
    """
    base = io.BytesIO()
    Image.new("RGB", (100, 100), (255, 255, 255)).save(base, format="PNG")
    op = edit_ops.normalize_ops(
        [{"region": {"x": 0.1, "y": 0.1, "w": 0.3, "h": 0.3}, "handler": "restyle", "prompt": "改"}],
        handlers=edit_handlers.BUILTIN_INDEX,
    )[0]
    mask_bytes = generate_service._render_edit_mask(base.getvalue(), op)
    with Image.open(io.BytesIO(mask_bytes)) as mask:
        assert mask.mode == "RGBA"
        alpha = mask.getchannel("A")
        assert alpha.getpixel((20, 20)) == 0, "目标区域应为透明（可修改）"
        assert alpha.getpixel((80, 80)) == 255, "区域外应为不透明（必须保留）"
        assert alpha.getpixel((5, 95)) == 255


def test_region_guide_marks_single_region():
    """引导图只标出本区域：按区域拆分调用时不会误导上游去改别的区域。"""
    base = io.BytesIO()
    Image.new("RGB", (200, 200), (255, 255, 255)).save(base, format="PNG")
    ops = edit_ops.normalize_ops(
        [
            {"region": {"x": 0.05, "y": 0.05, "w": 0.3, "h": 0.3}, "handler": "restyle", "prompt": "a"},
            {"region": {"x": 0.6, "y": 0.6, "w": 0.3, "h": 0.3}, "handler": "restyle", "prompt": "b"},
        ],
        handlers=edit_handlers.BUILTIN_INDEX,
    )
    guide_bytes = generate_service._render_region_guide(base.getvalue(), ops[0])
    with Image.open(io.BytesIO(guide_bytes)).convert("RGB") as guide:
        first = list(_iter_region(guide, 0.05, 0.05, 0.3, 0.3))
        second = list(_iter_region(guide, 0.6, 0.6, 0.3, 0.3))
    assert any(px[0] > 150 and px[1] < 90 for px in first), "本区域应有红框"
    assert all(px == (255, 255, 255) for px in second), "其它区域不得出现标记"


def test_paste_region_keeps_outside_pixels():
    """贴回：区域外逐像素保留底图（即使上游把整图重绘了）。"""
    base = io.BytesIO()
    Image.new("RGB", (64, 64), (255, 255, 255)).save(base, format="PNG")
    edited = io.BytesIO()
    Image.new("RGB", (64, 64), (0, 0, 255)).save(edited, format="PNG")
    out = generate_service._paste_region(
        base.getvalue(), edited.getvalue(), {"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}
    )
    with Image.open(io.BytesIO(out)).convert("RGB") as img:
        assert img.getpixel((10, 10))[2] > 200, "选区内应为上游结果"
        assert img.getpixel((60, 60)) == (255, 255, 255), "选区外必须保留底图"


def test_crop_to_region_limits_to_selection():
    """素材裁剪：只保留框选范围内的内容。"""
    raw = io.BytesIO()
    Image.new("RGB", (64, 64), (10, 20, 30)).save(raw, format="PNG")
    out = generate_service._crop_to_region(
        raw.getvalue(), {"x": 0.0, "y": 0.0, "w": 0.25, "h": 0.5}
    )
    with Image.open(io.BytesIO(out)) as img:
        assert img.size == (16, 32)


def test_local_cutout_still_available_as_fallback():
    """本地抠图作为兜底能力保留（上游不返回 alpha 时可回退）。"""
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (255, 255, 255)).save(buf, format="PNG")
    sprite = cutout_service.extract_sprite(
        buf.getvalue(), {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}, strategy="chroma"
    )
    with Image.open(io.BytesIO(sprite)) as img:
        assert img.mode == "RGBA"


async def test_three_regions_single_call_and_keep_cutout_area(monkeypatch):
    """3 区域：2 处改样式 + 1 处抠图 → **一次上游调用**，产出 1 张整图 + 1 张素材。

    关键断言：改样式的两个区域合并进同一条指令；抠图区域不送去上游（从原图精确抠出），
    且在整图里严格保持原样。
    """
    prompts: list[str] = []

    async def fake_edits(files, form):
        prompts.append(form["prompt"])
        # 两个改样式区域的指令合并进一次请求
        assert "【区域1】" in form["prompt"]
        assert "【区域2】" in form["prompt"]
        # 抠图区域是本地精确抠出，不进入上游指令
        assert "【区域3】" not in form["prompt"]
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (0, 0, 255))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _red_block_image())  # 白底 + 居中红方块

    task = await _run_edit(
        uid,
        base_url,
        ops=[
            {"region": {"x": 0.0, "y": 0.0, "w": 0.25, "h": 0.25}, "handler": "restyle", "prompt": "换蓝色"},
            {"region": {"x": 0.0, "y": 0.7, "w": 0.25, "h": 0.25}, "handler": "restyle", "prompt": "换绿色"},
            {"region": {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""},
        ],
        key="k-three-regions",
    )

    assert task.status == "succeeded", task.error_message
    assert len(prompts) == 1, "一次编辑只调用一次上游"
    assert len(task.result_urls) == 2

    # 产出 1：完整修改图 —— 改样式区域被改，抠图区域原样
    with _load(task.result_urls[0]).convert("RGB") as composite:
        assert composite.getpixel((8, 8))[2] > 150, "区域1 应被改成蓝色"
        assert composite.getpixel((32, 32)) == (220, 30, 30), "抠图区域必须严格保留原图"

    # 产出 2：素材（本地抠图，真透明）
    with _load(task.result_urls[1]) as sprite:
        assert sprite.mode == "RGBA"
        assert sprite.getchannel("A").getextrema()[0] == 0
        assert sprite.width < 64 and sprite.height < 64


async def test_selected_region_restored_even_if_upstream_changes_whole_image(monkeypatch):
    """兜底保真：即使上游无视掩码把整图涂红，选区外的像素仍被还原成原图。"""

    async def fake_edits(files, form):
        # 上游「不听话」：整张图返回纯红
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (255, 0, 0))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _half_image())

    task = await _run_edit(
        uid,
        base_url,
        ops=[
            {"region": {"x": 0.0, "y": 0.0, "w": 0.4, "h": 0.4}, "handler": "restyle", "prompt": "换蓝色"},
            {"region": {"x": 0.6, "y": 0.2, "w": 0.35, "h": 0.35}, "handler": "restyle", "prompt": "换绿色"},
        ],
        key="k-guard",
    )

    assert task.status == "succeeded", task.error_message
    with _load(task.result_urls[0]).convert("RGB") as composite:
        # 未被选中的区域（右下角）必须保留原图
        assert composite.getpixel((60, 60)) == (255, 255, 255)
        # 选中区域保留上游结果（红色）
        assert composite.getpixel((10, 10))[0] > 150


# --------------------------------------------------------------------------- #
# 抠图透明兜底：中转站常丢弃 alpha 通道
# --------------------------------------------------------------------------- #
async def test_cutout_falls_back_to_local_when_upstream_loses_alpha(monkeypatch):
    """上游返回不透明图（中转站丢了 alpha）时，素材自动改用本地抠图兜底。"""

    async def fake_edits(files, form):
        # 模拟中转站重新编码丢掉 alpha：返回不透明的白底图
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (255, 255, 255))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _red_block_image())

    task = await _run_edit(
        uid,
        base_url,
        ops=[{"region": {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""}],
        key="k-alpha-fallback",
    )

    assert task.status == "succeeded", task.error_message
    with _load(task.result_urls[0]) as sprite:
        assert sprite.mode == "RGBA"
        assert sprite.getchannel("A").getextrema()[0] == 0, "兜底后必须有真正的透明像素"
        # 本地抠图会收紧到主体包围盒（红方块约 20px + 边距），比选区裁剪更小
        assert sprite.width < 26


async def test_cutout_ignores_upstream_result(monkeypatch):
    """抠图区域不送上游：即使上游返回了什么，素材也来自原图的精确抠取。"""

    async def fake_edits(files, form):
        return {"data": [{"b64_json": _solid_png_b64((64, 64), (255, 0, 0))}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    uid = await _make_user(200)
    base_url = await _make_asset(uid, _red_block_image())

    task = await _run_edit(
        uid,
        base_url,
        ops=[{"region": {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""}],
        key="k-alpha-keep",
    )

    assert task.status == "succeeded", task.error_message
    with _load(task.result_urls[0]) as sprite:
        assert sprite.mode == "RGBA"
        # 素材来自原图（红方块），不是上游返回的纯红整图
        assert sprite.getchannel("A").getextrema()[0] == 0
        assert sprite.width < 26, "本地抠图会收紧到主体包围盒"


async def test_cost_is_charged_once_per_edit(db):
    """一次编辑只调用一次上游 → 无论多少个上游区域，都只收一次编辑单价。

    这条断言防止「多区域被重复计费」——用户看到 3 个框却只发了 1 次请求，
    收 3 份钱是错的。
    """
    uid = await _make_user(200)
    async with AsyncSessionLocal() as db2:
        base_url = await _make_asset(uid, _red_block_image())
        prices = await config_service.prices(db2)
        task, _ = await generate_service.create_edit_task(
            db2,
            uid,
            prompt="三处修改",
            model="gpt-image-2",
            size="64x64",
            base_image_url=base_url,
            session_id=None,
            canvas_id=None,
            idempotency_key="k-cost-once",
            edit_ops=[
                {"region": {"x": 0.0, "y": 0.0, "w": 0.2, "h": 0.2}, "handler": "restyle", "prompt": "a"},
                {"region": {"x": 0.3, "y": 0.0, "w": 0.2, "h": 0.2}, "handler": "restyle", "prompt": "b"},
                {"region": {"x": 0.6, "y": 0.0, "w": 0.2, "h": 0.2}, "handler": "cutout", "prompt": ""},
            ],
        )
    assert task.cost == int(prices["edit"]), "一次编辑只收一次单价"
