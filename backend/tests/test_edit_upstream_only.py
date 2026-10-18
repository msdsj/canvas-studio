"""产品口径（2026-10-17）：所有编辑操作一律提交上游 gpt-image-2，并按编辑单价计费。

这里锁死三条用户可见承诺：
1. 抠图 / 透明化 / 改样式都只走一次上游调用，平台不做本地像素处理；
2. 发出去的提示词必须包含区域编号与能力内置说明（否则上游不知道要干什么）；
3. 任何编辑操作都产生费用，不再有「本地免费」路径。
"""
from __future__ import annotations

import base64
import io

import pytest
import pytest_asyncio
from PIL import Image
from sqlalchemy import select

from app.database import AsyncSessionLocal, Base, engine
from app.models.generation import GenerationTask
from app.models.user import User
from app.services import asset_service, generate_service
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


async def _make_asset(uid: str) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), (255, 255, 255)).save(buf, format="PNG")
    async with AsyncSessionLocal() as db:
        asset = await asset_service.create_from_bytes(
            db, uid, buf.getvalue(), kind="uploaded", filename="base.png", content_type="image/png"
        )
        await db.commit()
        return asset.url


def _png_b64(color: tuple[int, int, int] = (200, 40, 40)) -> str:
    buf = io.BytesIO()
    Image.new("RGB", (64, 64), color).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


class _Recorder:
    """记录上游调用；返回一张合法 PNG。"""

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def __call__(self, files, form):
        self.calls.append({"files": files, "form": form})
        return {"data": [{"b64_json": _png_b64()}], "demo": False}


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


async def test_cutout_calls_upstream_and_is_billed(monkeypatch):
    """抠图 = 一次上游调用 + 计费，且提示词里带「透明背景」说明。"""
    rec = _Recorder()
    monkeypatch.setattr("app.services.gateway_client.gateway_client.image_edits", rec)

    uid = await _make_user()
    cost, task_id = await _create(
        uid,
        [{"region": {"x": 0.3, "y": 0.3, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""}],
        "把主体抠出来",
    )
    assert cost > 0, "抠图必须计费"

    done = await _finish(task_id)
    assert len(rec.calls) == 1, "必须调用上游一次"
    sent_prompt = rec.calls[0]["form"]["prompt"]
    assert "区域1" in sent_prompt
    assert "透明背景" in sent_prompt
    assert done.status == "succeeded", done.error_message
    assert len(done.result_urls) == 1
    # 思考过程必须落库，前端据此在左侧展示
    thinking = (done.params or {}).get("thinking") or []
    assert len(thinking) >= 3
    # 只断言「关键词出现过」而不是钉死整句：思考文案会随产品口径微调，
    # 但「这次是当成独立素材处理的」这个信息必须始终可见。
    assert any("素材" in step for step in thinking), thinking


async def test_mixed_ops_use_composite_plus_per_sprite_call(monkeypatch):
    """改样式 + 抠图：整图类合并 1 次、素材类每区 1 次，各自只带自己的区域指令。

    产出契约（与产品口径一致）：
    - 整图类（改样式/挖空/去物/增强）合并成 **1 次**调用，指令里含全部整图类区域；
    - 素材类（抠图）**每个区域各 1 次**调用，指令里只含它自己那个区域
      （否则「先抠左边、再抠右边」会被上游当成一次整图重绘，丢一半结果）。
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
    assert len(rec.calls) == 2, "整图类 1 次 + 素材类 1 次"

    composite_prompt = rec.calls[0]["form"]["prompt"]
    sprite_prompt = rec.calls[1]["form"]["prompt"]
    # 整图类：只带区域1，并保留「选区外像素不变」的约束
    assert "区域1" in composite_prompt and "换成蓝色" in composite_prompt
    assert "区域2" not in composite_prompt, "整图类调用不应夹带素材类区域"
    assert "mask 外的像素保持原样" in composite_prompt
    # 素材类：只带区域2，并要求透明背景
    assert "区域2" in sprite_prompt and "透明背景" in sprite_prompt
    assert "换成蓝色" not in sprite_prompt, "素材类调用不应夹带整图类区域"

    # 每次调用都必须带 mask（硬约束「只改选区」，而不是靠提示词自觉）
    for call in rec.calls:
        assert any(field == "mask" for field, _payload in call["files"])

    # 产出数量：1 张修改图 + 1 张透明素材
    assert len(done.result_urls) == 2


async def test_transparent_calls_upstream(monkeypatch):
    """就地透明化同样提交上游，不再本地处理。"""
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
