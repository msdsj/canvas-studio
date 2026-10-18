"""权限分级（普通用户 / Pro）与激活码体系。

覆盖：
- 普通用户（role=user）只能文生图；画布 / 抠图 / AI 对话 / 润色 一律 PRO_REQUIRED；
- 激活码兑换后升级为 Pro，受限能力立即解锁；
- 激活码管理（管理员生成 / 列表 / 禁用 / 删除）与越权访问；
- 已解锁用户重复兑换不消耗激活码。
"""
from __future__ import annotations

import pytest
import pytest_asyncio

from app.services import generate_service
from tests.conftest import register_and_activate

FREE = "free-user@example.com"
ADMIN = "admin@example.com"


@pytest.fixture(autouse=True)
def _noop_run_task(monkeypatch):
    """生图后台任务打桩：用例只验证鉴权与状态，不真的去打上游。"""

    async def _noop(_task_id: str) -> None:
        return None

    monkeypatch.setattr(generate_service, "run_task", _noop)


@pytest_asyncio.fixture
async def free_headers(client, auth_headers_factory):
    token = await register_and_activate(client, FREE, role="user")
    return auth_headers_factory(token)


async def _login_admin(client) -> dict[str, str]:
    from app.config import settings

    resp = await client.post(
        "/api/auth/login",
        json={"email": settings.default_admin_email, "password": settings.default_admin_password},
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}


async def test_free_user_can_only_text_to_image(client, free_headers, auth_headers_factory):
    """普通用户：文生图放行，画布/抠图/润色/对话全部拦截。"""
    # 文生图：允许
    ok = await client.post(
        "/api/generate/image", json={"prompt": "一只在雪地里的猫"}, headers=free_headers
    )
    assert ok.status_code == 200, ok.text

    # 图生图 / 编辑计划 / 提示词润色：Pro 专属
    edit = await client.post("/api/generate/edit", data={"prompt": "换背景"}, headers=free_headers)
    assert edit.status_code == 402, edit.text
    assert edit.json()["code"] == "PRO_REQUIRED"

    plan = await client.post(
        "/api/generate/plan", json={"message": "把背景换成蓝色"}, headers=free_headers
    )
    assert plan.status_code == 402
    assert plan.json()["code"] == "PRO_REQUIRED"

    polish = await client.post(
        "/api/ai/polish", json={"text": "一只猫", "mode": "auto"}, headers=free_headers
    )
    assert polish.status_code == 402
    assert polish.json()["code"] == "PRO_REQUIRED"

    # AI 对话全链路：Pro 专属
    compose = await client.post(
        "/api/chat/compose", json={"session_id": "x", "content": "画一只猫"}, headers=free_headers
    )
    assert compose.status_code == 402

    # 画布：Pro 专属。普通用户建项目不给默认画布，也不能自己建画布
    resp = await client.post("/api/projects", json={"name": "p"}, headers=free_headers)
    pid = resp.json()["data"]["id"]
    listed = await client.get(f"/api/projects/{pid}/canvases", headers=free_headers)
    assert listed.json()["data"] == [], "普通用户不应有默认画布"
    blocked = await client.post(
        f"/api/projects/{pid}/canvases", json={"name": "c"}, headers=free_headers
    )
    assert blocked.status_code == 402
    assert blocked.json()["code"] == "PRO_REQUIRED"

    # 借 Pro 账号建一块画布：验证普通用户读 / 写都被拦在门外
    pro_headers = auth_headers_factory(
        await register_and_activate(client, "pro-canvas@example.com")
    )
    pro_pid = (
        await client.post("/api/projects", json={"name": "proj"}, headers=pro_headers)
    ).json()["data"]["id"]
    created = await client.post(
        f"/api/projects/{pro_pid}/canvases", json={"name": "c"}, headers=pro_headers
    )
    assert created.status_code == 200, created.text
    canvas_id = created.json()["data"]["id"]

    save = await client.patch(
        f"/api/canvases/{canvas_id}", json={"state": {"elements": []}}, headers=free_headers
    )
    assert save.status_code == 402
    assert save.json()["code"] == "PRO_REQUIRED"
    read = await client.get(f"/api/canvases/{canvas_id}", headers=free_headers)
    assert read.status_code == 402


async def test_redeem_activates_pro_and_unlocks(client, free_headers):
    """激活码兑换后普通用户升级为 Pro，受限能力立即解锁。"""
    admin = await _login_admin(client)
    created = await client.post(
        "/api/admin/pro-codes", json={"count": 2, "max_uses": 1}, headers=admin
    )
    assert created.status_code == 200, created.text
    codes = [item["code"] for item in created.json()["data"]["items"]]
    assert len(codes) == 2

    # 无效码
    bad = await client.post("/api/me/pro/redeem", json={"code": "NOPE-CODE"}, headers=free_headers)
    assert bad.status_code == 422
    assert bad.json()["code"] == "VALIDATION_ERROR"

    # 有效码 → 升级
    good = await client.post("/api/me/pro/redeem", json={"code": codes[0]}, headers=free_headers)
    assert good.status_code == 200, good.text
    assert good.json()["data"]["already_pro"] is False
    assert good.json()["data"]["user"]["role"] == "pro"

    # 重新登录后，之前被拦截的能力全部放行
    me = await client.post(
        "/api/auth/login", json={"email": FREE, "password": "Passw0rd123"}
    )
    headers = {"Authorization": f"Bearer {me.json()['data']['access_token']}"}
    polish = await client.post(
        "/api/ai/polish", json={"text": "一只猫", "mode": "auto"}, headers=headers
    )
    assert polish.status_code == 200, polish.text

    # 已经是 Pro：再兑换不消耗激活码
    again = await client.post("/api/me/pro/redeem", json={"code": codes[1]}, headers=headers)
    assert again.status_code == 200
    assert again.json()["data"]["already_pro"] is True
    listed = await client.get("/api/admin/pro-codes", headers=admin)
    remaining = [item for item in listed.json()["data"]["items"] if item["code"] == codes[1]]
    assert remaining and remaining[0]["used_count"] == 0


async def test_pro_code_admin_lifecycle(client, auth_headers_factory):
    """激活码后台：生成 / 列表 / 禁用 / 删除；非管理员拒绝。"""
    admin = await _login_admin(client)

    created = await client.post(
        "/api/admin/pro-codes",
        json={"count": 1, "max_uses": 3, "note": "内测"},
        headers=admin,
    )
    assert created.status_code == 200
    row = created.json()["data"]["items"][0]
    assert row["max_uses"] == 3 and row["status"] == "active" and row["note"] == "内测"

    listed = await client.get("/api/admin/pro-codes", headers=admin)
    assert listed.status_code == 200
    assert any(item["id"] == row["id"] for item in listed.json()["data"]["items"])

    disabled = await client.patch(
        f"/api/admin/pro-codes/{row['id']}", json={"status": "disabled"}, headers=admin
    )
    assert disabled.status_code == 200
    assert disabled.json()["data"]["status"] == "disabled"

    other = await register_and_activate(client, "plain@example.com", role="user")
    denied = await client.get(
        "/api/admin/pro-codes", headers=auth_headers_factory(other)
    )
    assert denied.status_code == 403

    removed = await client.delete(f"/api/admin/pro-codes/{row['id']}", headers=admin)
    assert removed.status_code == 200
