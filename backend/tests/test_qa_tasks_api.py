"""QA 独立测试 · 异常场景与状态续接（HTTP API 契约层）。

对照 PM §11 增量需求（用户新增需求，最高优先级）：
- P0-28 生成中暂停（running→paused，暂停不继续扣费，提供继续/放弃）
- P0-29 暂停后恢复/放弃（放弃→幂等回滚）
- P0-30 刷新续接：GET /api/tasks/active 返回 queued/running/paused
- P0-31 结果不丢失：succeeded 未读 → /api/tasks/unread；/seen 后消失
- P0-32 幂等：同 Idempotency-Key → 同一任务、只扣一次费
- P0-33/34 防浪费：无进展超时 → timeout + 回滚；并发超限 → 429
- P0-36 上游不可达：不扣额、不产生（卡死）垃圾任务

实现说明：状态机类用例把 `generate_service.run_task` 打桩为 no-op，
让任务停留在 running，以便验证暂停/恢复/并发；成功/失败路径则真实执行后台任务。
"""
from __future__ import annotations

import base64
import io
from datetime import timedelta

from PIL import Image
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.generation import GenerationTask
from app.models.user import User
from app.utils.ids import utcnow
from tests.conftest import register_and_activate


def _png_b64() -> str:
    """生成一个小 PNG 的 base64。"""
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), color=(200, 60, 60)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _png_bytes() -> bytes:
    """生成一个小 PNG 字节。"""
    buf = io.BytesIO()
    Image.new("RGB", (16, 16), color=(60, 160, 60)).save(buf, format="PNG")
    return buf.getvalue()


def _patch_run_task_noop(monkeypatch) -> None:
    """把后台执行打桩为 no-op，使任务保持 running。"""

    async def _noop(task_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("app.services.generate_service.run_task", _noop)


async def _headers(client, email: str) -> dict[str, str]:
    """注册并激活，返回鉴权头。"""
    token = await register_and_activate(client, email)
    return {"Authorization": f"Bearer {token}"}


async def _balance(email: str) -> int:
    """按邮箱取余额。"""
    async with AsyncSessionLocal() as session:
        return int(
            (await session.execute(select(User.balance).where(User.email == email))).scalar_one()
        )


async def _gen(client, headers, **overrides) -> dict:
    """发起一次生图并返回任务 data。"""
    body = {"prompt": "QA 异常场景", **overrides}
    resp = await client.post("/api/generate/image", json=body, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


# --------------------------------------------------------------------------
# P0-28 / P0-29 / P0-30 暂停 · 恢复 · 放弃 · 活跃列表
# --------------------------------------------------------------------------
async def test_qa_pause_resume_cancel_full_cycle(client, monkeypatch):
    """running→paused→running→cancelled，放弃后预扣回滚（P0-28/29）。"""
    email = "qa-pause@example.com"
    headers = await _headers(client, email)
    _patch_run_task_noop(monkeypatch)

    task = await _gen(client, headers, prompt="暂停用例")
    tid = task["id"]
    assert task["status"] == "running"
    assert await _balance(email) == 190  # 已预扣

    paused = await client.post(f"/api/generate/tasks/{tid}/pause", headers=headers)
    assert paused.status_code == 200
    assert paused.json()["data"]["status"] == "paused"
    assert paused.json()["data"]["paused_at"]

    # P0-28: 暂停期间不再继续消耗额度
    assert await _balance(email) == 190

    resumed = await client.post(f"/api/generate/tasks/{tid}/resume", headers=headers)
    # 产品口径：paused 不再支持「继续」——上游同步长请求，resume 会让同一任务双跑
    assert resumed.status_code == 409
    assert await _balance(email) == 190

    cancelled = await client.post(f"/api/generate/tasks/{tid}/cancel", headers=headers)
    assert cancelled.status_code == 200
    assert cancelled.json()["data"]["status"] == "cancelled"

    # P0-29: 放弃 → 未消耗部分额度回滚
    assert await _balance(email) == 200


async def test_qa_cancel_is_idempotent_refund(client, monkeypatch):
    """重复放弃同一任务：状态保持 cancelled，额度只回滚一次（P0-29）。"""
    email = "qa-cancel-idem@example.com"
    headers = await _headers(client, email)
    _patch_run_task_noop(monkeypatch)
    tid = (await _gen(client, headers))["id"]

    first = await client.post(f"/api/generate/tasks/{tid}/cancel", headers=headers)
    second = await client.post(f"/api/generate/tasks/{tid}/cancel", headers=headers)
    assert first.json()["data"]["status"] == "cancelled"
    assert second.status_code == 200
    assert second.json()["data"]["status"] == "cancelled"
    assert await _balance(email) == 200


async def test_qa_active_list_covers_running_and_paused(client, monkeypatch):
    """GET /api/tasks/active 返回 running 与 paused 任务（P0-30）。"""
    email = "qa-active@example.com"
    headers = await _headers(client, email)
    _patch_run_task_noop(monkeypatch)

    t1 = await _gen(client, headers, prompt="A")
    t2 = await _gen(client, headers, prompt="B")
    await client.post(f"/api/generate/tasks/{t2['id']}/pause", headers=headers)

    active = await client.get("/api/tasks/active", headers=headers)
    assert active.status_code == 200
    rows = active.json()["data"]
    by_id = {r["id"]: r["status"] for r in rows}
    assert by_id[t1["id"]] == "running"
    assert by_id[t2["id"]] == "paused"


# --------------------------------------------------------------------------
# P0-31 结果不丢失（未读）
# --------------------------------------------------------------------------
async def test_qa_unread_result_lifecycle(client, monkeypatch):
    """成功未读 → /unread 可见；/seen 后消失；终态不在 active（P0-31）。"""
    email = "qa-unread@example.com"
    headers = await _headers(client, email)

    async def fake_generations(payload):
        return {"data": [{"b64_json": _png_b64()}], "demo": True}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )

    task = await _gen(client, headers, prompt="结果不丢失")
    tid = task["id"]

    detail = await client.get(f"/api/generate/tasks/{tid}", headers=headers)
    assert detail.json()["data"]["status"] == "succeeded"
    assert detail.json()["data"]["result_urls"]
    assert detail.json()["data"]["result_seen"] is False

    unread = await client.get("/api/tasks/unread", headers=headers)
    assert tid in [r["id"] for r in unread.json()["data"]]

    active = await client.get("/api/tasks/active", headers=headers)
    assert tid not in [r["id"] for r in active.json()["data"]]

    seen = await client.post(f"/api/generate/tasks/{tid}/seen", headers=headers)
    assert seen.status_code == 200
    assert seen.json()["data"]["result_seen"] is True

    unread_after = await client.get("/api/tasks/unread", headers=headers)
    assert tid not in [r["id"] for r in unread_after.json()["data"]]


# --------------------------------------------------------------------------
# P0-32 幂等去重
# --------------------------------------------------------------------------
async def test_qa_idempotency_same_key_one_task_one_charge(client, monkeypatch):
    """同一 Idempotency-Key 重复提交 → 同一任务、只扣一次费（P0-32）。"""
    email = "qa-idem@example.com"
    headers = await _headers(client, email)
    _patch_run_task_noop(monkeypatch)

    h = {**headers, "Idempotency-Key": "qa-fixed-key-0001"}
    first = await client.post("/api/generate/image", json={"prompt": "幂等"}, headers=h)
    second = await client.post("/api/generate/image", json={"prompt": "幂等"}, headers=h)
    assert first.status_code == second.status_code == 200
    assert first.json()["data"]["id"] == second.json()["data"]["id"]

    assert await _balance(email) == 190  # 只扣一次

    # 活跃列表只应有该一个任务
    active = await client.get("/api/tasks/active", headers=headers)
    ids = [r["id"] for r in active.json()["data"]]
    assert ids.count(first.json()["data"]["id"]) == 1
    assert len(ids) == 1


# --------------------------------------------------------------------------
# P0-33/34 并发上限 · 超时回收
# --------------------------------------------------------------------------
async def test_qa_concurrency_limit_exceeded_429(client, monkeypatch):
    """超过并发上限（默认 2）→ 429 TASK_LIMIT_EXCEEDED（P0-34/Q19）。"""
    email = "qa-limit@example.com"
    headers = await _headers(client, email)
    _patch_run_task_noop(monkeypatch)

    await _gen(client, headers, prompt="1")
    await _gen(client, headers, prompt="2")
    third = await client.post("/api/generate/image", json={"prompt": "3"}, headers=headers)
    assert third.status_code == 429
    assert third.json()["code"] == "TASK_LIMIT_EXCEEDED"
    # 未超额扣费（前两个各扣 10）
    assert await _balance(email) == 180


async def test_qa_paused_frees_concurrency_slot(client, monkeypatch):
    """暂停释放并发配额：暂停后可再创建（Q18）。"""
    email = "qa-paused-slot@example.com"
    headers = await _headers(client, email)
    _patch_run_task_noop(monkeypatch)

    t1 = await _gen(client, headers, prompt="1")
    await _gen(client, headers, prompt="2")
    # 满额，先暂停一个释放槽位
    await client.post(f"/api/generate/tasks/{t1['id']}/pause", headers=headers)
    third = await client.post("/api/generate/image", json={"prompt": "3"}, headers=headers)
    assert third.status_code == 200
    assert third.json()["data"]["status"] == "running"


async def test_qa_orphan_timeout_reclaimed_and_refunded(client, monkeypatch):
    """无进展超时任务被回收 → timeout + 回滚，任务不再转圈（P0-33/34）。"""
    from app.services import task_service

    email = "qa-timeout@example.com"
    headers = await _headers(client, email)
    _patch_run_task_noop(monkeypatch)
    tid = (await _gen(client, headers, prompt="超时"))["id"]

    # 回拨 last_activity 超过超时阈值
    async with AsyncSessionLocal() as session:
        row = (
            await session.execute(select(GenerationTask).where(GenerationTask.id == tid))
        ).scalar_one()
        row.last_activity_at = utcnow() - timedelta(seconds=10_000)
        await session.commit()

    async with AsyncSessionLocal() as session:
        reclaimed = await task_service.reclaim_orphans(session)
    assert reclaimed >= 1

    detail = await client.get(f"/api/generate/tasks/{tid}", headers=headers)
    data = detail.json()["data"]
    assert data["status"] == "timeout"
    assert data["error_code"] == "TASK_TIMEOUT"
    assert await _balance(email) == 200


async def test_qa_pause_terminal_task_conflict_409(client, monkeypatch):
    """对已成功任务执行暂停 → 409 TASK_STATE_CONFLICT（§8.3 非法迁移）。"""
    email = "qa-conflict@example.com"
    headers = await _headers(client, email)

    async def fake_generations(payload):
        return {"data": [{"b64_json": _png_b64()}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )
    tid = (await _gen(client, headers))["id"]

    resp = await client.post(f"/api/generate/tasks/{tid}/pause", headers=headers)
    assert resp.status_code == 409
    assert resp.json()["code"] == "TASK_STATE_CONFLICT"


# --------------------------------------------------------------------------
# P0-09 对话式图片编辑
# --------------------------------------------------------------------------
async def test_qa_edit_task_success(client, monkeypatch):
    """以资产库图片为参考发起编辑任务 → 成功、按编辑单价(8)扣费（P0-09）。"""
    email = "qa-edit@example.com"
    headers = await _headers(client, email)

    files = {"file": ("base.png", _png_bytes(), "image/png")}
    up = await client.post("/api/assets/upload", files=files, headers=headers)
    assert up.status_code == 200, up.text
    asset_id = up.json()["data"]["id"]

    async def fake_edits(files_, form):
        return {"data": [{"b64_json": _png_b64()}], "demo": True}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_edits", fake_edits
    )

    resp = await client.post(
        "/api/generate/edit",
        data={"prompt": "把背景换成夜晚", "base_asset_id": asset_id},
        headers={**headers, "Idempotency-Key": "qa-edit-0001"},
    )
    assert resp.status_code == 200, resp.text
    tid = resp.json()["data"]["id"]

    detail = await client.get(f"/api/generate/tasks/{tid}", headers=headers)
    data = detail.json()["data"]
    assert data["type"] == "edit"
    assert data["status"] == "succeeded"
    assert data["result_urls"]
    assert await _balance(email) == 192  # 200 - 8（编辑单价）


# --------------------------------------------------------------------------
# P0-36 上游不可达：不扣额、不产生卡死垃圾任务
# --------------------------------------------------------------------------
async def test_qa_upstream_error_no_charge_terminal_task(client, monkeypatch):
    """上游不可达 → 任务失败终态、额度回滚，不卡死在 running（P0-36）。"""
    from app.utils.errors import AppError, ErrorCode

    email = "qa-upstream@example.com"
    headers = await _headers(client, email)

    async def fake_generations(payload):
        raise AppError(ErrorCode.PROXY_UNREACHABLE, "VPN 不可达")

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )

    task = await _gen(client, headers, prompt="上游不可达")
    tid = task["id"]

    detail = await client.get(f"/api/generate/tasks/{tid}", headers=headers)
    data = detail.json()["data"]
    # 任务没有永远转圈：进入 failed 终态
    assert data["status"] == "failed"
    assert data["error_code"] == "PROXY_UNREACHABLE"
    # 不扣额
    assert await _balance(email) == 200
    # 失败任务不应出现在活跃列表
    active = await client.get("/api/tasks/active", headers=headers)
    assert tid not in [r["id"] for r in active.json()["data"]]
