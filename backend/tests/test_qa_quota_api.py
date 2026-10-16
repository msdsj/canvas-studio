"""QA 独立测试 · 额度账本（HTTP API 契约层）。

对照 PRD 验收标准：
- P0-12 计费：按次扣减并落流水，余额与流水一致
- P0-13 实时展示：GET /api/me/quota 返回余额/阈值/单价
- P0-14 预警阈值字段
- P0-15 额度耗尽拦截：余额不足 → QUOTA_INSUFFICIENT(402)，不扣额、不产生任务
- §5.2 边界：余额不为负；失败回滚幂等（同一 ref_id 只回滚一次）
"""
from __future__ import annotations

import base64
import io

from PIL import Image
from sqlalchemy import select

from app.database import AsyncSessionLocal, init_models
from app.models.generation import GenerationTask
from app.models.quota import QuotaTransaction
from app.models.user import User
from app.services import quota_service
from app.utils.ids import new_id
from tests.conftest import register_and_activate

ADMIN_EMAIL = "admin@canvas.studio"
ADMIN_PASSWORD = "Admin@12345"


def _png_b64() -> str:
    """生成一张小 PNG 的 base64。"""
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), color=(10, 120, 200)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


async def _admin_headers(client) -> dict[str, str]:
    """管理员登录鉴权头。"""
    resp = await client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    return {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}


async def _uid(email: str) -> str:
    """按邮箱取用户 id。"""
    async with AsyncSessionLocal() as session:
        return (await session.execute(select(User.id).where(User.email == email))).scalar_one()


async def _balance(email: str) -> int:
    """按邮箱取余额。"""
    async with AsyncSessionLocal() as session:
        return int(
            (await session.execute(select(User.balance).where(User.email == email))).scalar_one()
        )


async def _set_balance(client, email: str, value: int) -> None:
    """通过管理员接口把用户余额直接设置为 value。"""
    admin = await _admin_headers(client)
    uid = await _uid(email)
    resp = await client.post(
        f"/api/admin/users/{uid}/quota",
        json={"mode": "set", "amount": value, "note": "QA 测试"},
        headers=admin,
    )
    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------
# P0-13 额度实时展示
# --------------------------------------------------------------------------
async def test_qa_quota_view_shape(client):
    """GET /api/me/quota 返回余额/阈值/单价（P0-13）。"""
    token = await register_and_activate(client, "q-view@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    resp = await client.get("/api/me/quota", headers=headers)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["balance"] == 200
    assert data["total_granted"] == 200
    # P0-14 预警阈值与 §8.1 单价表
    assert data["threshold_pct"] == 20
    assert data["prices"] == {"image_standard": 10, "image_hd": 16, "edit": 8, "chat": 2}


# --------------------------------------------------------------------------
# P0-15 额度耗尽拦截
# --------------------------------------------------------------------------
async def test_qa_generate_insufficient_quota_402_no_charge_no_task(client, monkeypatch):
    """余额不足时生图 → 402 QUOTA_INSUFFICIENT，不扣额、不产生任务（P0-15）。"""
    email = "q-low@example.com"
    token = await register_and_activate(client, email)
    headers = {"Authorization": f"Bearer {token}"}
    await _set_balance(client, email, 5)  # 余额 5 < 生图单价 10

    called = {"n": 0}

    async def fake_generations(payload):  # pragma: no cover - 不应被调用
        called["n"] += 1
        return {"data": [{"b64_json": _png_b64()}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )

    resp = await client.post(
        "/api/generate/image", json={"prompt": "余额不足"}, headers=headers
    )
    assert resp.status_code == 402
    assert resp.json()["code"] == "QUOTA_INSUFFICIENT"
    # 不扣额
    assert await _balance(email) == 5
    # 不产生垃圾任务、不调上游
    assert called["n"] == 0
    uid = await _uid(email)
    async with AsyncSessionLocal() as session:
        tasks = (
            await session.execute(
                select(GenerationTask).where(GenerationTask.user_id == uid)
            )
        ).scalars().all()
    assert len(tasks) == 0


# --------------------------------------------------------------------------
# P0-12 计费与流水一致性
# --------------------------------------------------------------------------
async def test_qa_generate_charges_and_records_transaction(client, monkeypatch):
    """生图成功 → 扣 10 分、余额与流水一致（P0-12）。"""
    email = "q-charge@example.com"
    token = await register_and_activate(client, email)
    headers = {"Authorization": f"Bearer {token}"}

    async def fake_generations(payload):
        return {"data": [{"b64_json": _png_b64()}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )

    resp = await client.post(
        "/api/generate/image",
        json={"prompt": "计费测试"},
        headers={**headers, "Idempotency-Key": "qa-charge-1"},
    )
    assert resp.status_code == 200
    task_id = resp.json()["data"]["id"]

    assert await _balance(email) == 190  # 200 - 10
    tx = await client.get("/api/me/quota/transactions", headers=headers)
    items = tx.json()["data"]["items"]
    consume = [t for t in items if t["ref_id"] == task_id]
    assert len(consume) == 1
    assert consume[0]["type"] == "consume_image"
    assert consume[0]["amount"] == -10
    assert consume[0]["status"] == "success"


async def test_qa_failed_generation_refunds(client, monkeypatch):
    """生图失败 → 预扣回滚，余额复原、流水 refunded（P0-12/§5.2）。"""
    from app.utils.errors import AppError, ErrorCode

    email = "q-refund@example.com"
    token = await register_and_activate(client, email)
    headers = {"Authorization": f"Bearer {token}"}

    async def fake_generations(payload):
        raise AppError(ErrorCode.UPSTREAM_ERROR, "上游繁忙")

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )

    resp = await client.post(
        "/api/generate/image",
        json={"prompt": "失败回滚"},
        headers={**headers, "Idempotency-Key": "qa-refund-1"},
    )
    assert resp.status_code == 200
    task_id = resp.json()["data"]["id"]

    assert await _balance(email) == 200  # 全额回滚
    tx = await client.get("/api/me/quota/transactions", headers=headers)
    rows = [t for t in tx.json()["data"]["items"] if t["ref_id"] == task_id]
    assert len(rows) == 1
    assert rows[0]["status"] == "refunded"


# --------------------------------------------------------------------------
# §5.2 边界：回滚幂等 / 余额不为负
# --------------------------------------------------------------------------
async def test_qa_refund_idempotent_same_ref(db):
    """同一 ref_id 重复回滚只退还一次（§5.2）。"""
    await init_models()
    uid = f"qa-refund-{new_id()}"
    async with AsyncSessionLocal() as session:
        session.add(
            User(
                id=uid,
                email=f"qa-refund-{new_id()[:8]}@example.com",
                password_hash="x",
                status="active",
                role="user",
                balance=100,
            )
        )
        await session.commit()

    ref = new_id()
    await quota_service.pre_deduct(db, uid, "consume_image", 40, ref_id=ref)
    await db.commit()
    assert (await _balance_by_id(uid)) == 60

    await quota_service.refund(db, ref)
    await db.commit()
    assert (await _balance_by_id(uid)) == 100

    await quota_service.refund(db, ref)
    await db.commit()
    assert (await _balance_by_id(uid)) == 100  # 只回滚一次


async def test_qa_refund_skips_confirmed_tx(db):
    """已确认(success)的流水不被回滚（保护：出了图不能退）(§5.2)。"""
    await init_models()
    uid = f"qa-confirm-{new_id()}"
    async with AsyncSessionLocal() as session:
        session.add(
            User(
                id=uid,
                email=f"qa-confirm-{new_id()[:8]}@example.com",
                password_hash="x",
                status="active",
                role="user",
                balance=100,
            )
        )
        await session.commit()

    ref = new_id()
    await quota_service.pre_deduct(db, uid, "consume_image", 30, ref_id=ref)
    await db.commit()
    await quota_service.confirm(db, ref)
    await db.commit()

    await quota_service.refund(db, ref)  # 已确认，不应退款
    await db.commit()
    assert (await _balance_by_id(uid)) == 70

    txs = (
        await db.execute(select(QuotaTransaction).where(QuotaTransaction.ref_id == ref))
    ).scalars().all()
    assert txs and txs[0].status == "success"


async def test_qa_pre_deduct_exact_balance_then_zero_left(db):
    """恰好扣到 0 允许；再扣则 QUOTA_INSUFFICIENT，余额不为负（§5.2）。"""
    from app.utils.errors import AppError

    await init_models()
    uid = f"qa-zero-{new_id()}"
    async with AsyncSessionLocal() as session:
        session.add(
            User(
                id=uid,
                email=f"qa-zero-{new_id()[:8]}@example.com",
                password_hash="x",
                status="active",
                role="user",
                balance=30,
            )
        )
        await session.commit()

    await quota_service.pre_deduct(db, uid, "consume_image", 30, ref_id=new_id())
    await db.commit()
    assert (await _balance_by_id(uid)) == 0

    try:
        await quota_service.pre_deduct(db, uid, "consume_image", 10, ref_id=new_id())
        raise AssertionError("应当抛出 QUOTA_INSUFFICIENT")
    except AppError:
        await db.rollback()
    assert (await _balance_by_id(uid)) == 0


async def _balance_by_id(uid: str) -> int:
    """按 id 取余额。"""
    async with AsyncSessionLocal() as session:
        return int((await session.execute(select(User.balance).where(User.id == uid))).scalar_one())
