"""本轮新增能力：消息删除、素材批量删除、对话分享。

原则：分享出去的是**只读视图**；「继续创作」必须复制一份到访问者名下，
不能让人通过分享链接改到原作者的对话或画布。
"""
from __future__ import annotations

from sqlalchemy import func, select

from app.database import AsyncSessionLocal
from app.models.chat import ChatMessage, ChatSession

ADMIN_EMAIL = "admin@canvas.studio"
ADMIN_PASSWORD = "Admin@12345"


async def _headers(client) -> dict[str, str]:
    resp = await client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}


async def _new_session(client, headers) -> str:
    resp = await client.post("/api/chat/sessions", json={"new_canvas": True}, headers=headers)
    return resp.json()["data"]["id"]


async def _count_messages(session_id: str, *, include_deleted: bool = False) -> int:
    async with AsyncSessionLocal() as db:
        stmt = select(func.count()).select_from(ChatMessage).where(
            ChatMessage.session_id == session_id
        )
        if not include_deleted:
            stmt = stmt.where(ChatMessage.deleted_at.is_(None))
        return int((await db.execute(stmt)).scalar_one())


# ---------------------------------------------------------------------------
# 消息删除（对话「全选删除」）
# ---------------------------------------------------------------------------
async def test_batch_delete_messages_is_soft(client):
    """批量删消息：软删（保留审计痕迹），列表里不再出现。"""
    headers = await _headers(client)
    session_id = await _new_session(client, headers)
    # 直接落两条消息（不走 SSE，避免依赖中转站）
    async with AsyncSessionLocal() as db:
        for text in ("第一条", "第二条", "第三条"):
            db.add(ChatMessage(session_id=session_id, user_id=(await _admin_id()), role="user", content=text))
        await db.commit()

    listed = await client.get(f"/api/chat/sessions/{session_id}/messages", headers=headers)
    ids = [item["id"] for item in listed.json()["data"]["items"]]
    assert len(ids) == 3

    resp = await client.post(
        "/api/chat/messages/batch-delete", json={"ids": ids[:2]}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["deleted"] == 2

    after = await client.get(f"/api/chat/sessions/{session_id}/messages", headers=headers)
    assert len(after.json()["data"]["items"]) == 1
    # 软删：库里还在，只是带 deleted_at
    assert await _count_messages(session_id, include_deleted=True) == 3


async def test_delete_single_message(client):
    headers = await _headers(client)
    session_id = await _new_session(client, headers)
    async with AsyncSessionLocal() as db:
        message = ChatMessage(session_id=session_id, user_id=(await _admin_id()), role="user", content="x")
        db.add(message)
        await db.commit()
        message_id = message.id

    resp = await client.delete(f"/api/chat/messages/{message_id}", headers=headers)
    assert resp.status_code == 200, resp.text
    # 再删一次：已经不存在 → 404 而不是静默成功
    again = await client.delete(f"/api/chat/messages/{message_id}", headers=headers)
    assert again.status_code == 404


async def _admin_id() -> str:
    from app.models.user import User

    async with AsyncSessionLocal() as db:
        return (await db.execute(select(User.id).where(User.email == ADMIN_EMAIL))).scalar_one()


# ---------------------------------------------------------------------------
# 素材批量删除
# ---------------------------------------------------------------------------
async def test_batch_delete_assets(client):
    """批量删素材：只影响自己的，别人的 id 被静默跳过。"""
    headers = await _headers(client)
    # 造两个自己的资产（直接入库，避免构造图片上传）
    async with AsyncSessionLocal() as db:
        from app.models.asset import Asset

        owner = await _admin_id()
        rows = [
            Asset(owner_id=owner, kind="uploaded", url=f"/static/fake-{i}.png")
            for i in range(2)
        ]
        db.add_all(rows)
        await db.commit()
        ids = [row.id for row in rows]

    resp = await client.post("/api/assets/batch-delete", json={"ids": ids}, headers=headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["deleted"] == 2

    page = await client.get("/api/assets?page=1&size=50", headers=headers)
    remaining = {item["id"] for item in page.json()["data"]["items"]}
    assert not (set(ids) & remaining)


# ---------------------------------------------------------------------------
# 对话分享
# ---------------------------------------------------------------------------
async def test_share_chat_roundtrip(client):
    """分享 → 匿名可读 → 关闭后失效。"""
    headers = await _headers(client)
    session_id = await _new_session(client, headers)
    async with AsyncSessionLocal() as db:
        db.add(ChatMessage(session_id=session_id, user_id=(await _admin_id()), role="user", content="做一张海报"))
        await db.commit()

    shared = await client.post(f"/api/chat/sessions/{session_id}/share", headers=headers)
    assert shared.status_code == 200, shared.text
    payload = shared.json()["data"]
    assert payload["share_token"]
    assert "/share/chat/" in payload["url"]

    # 公开读取（不带 Authorization）
    public = await client.get(f"/api/share/chat/{payload['share_token']}")
    assert public.status_code == 200, public.text
    data = public.json()["data"]
    assert data["title"] == "新对话"
    assert any(item["content"] == "做一张海报" for item in data["messages"])
    # 执行态附件不外泄
    for message in data["messages"]:
        for item in message["attachments"]:
            assert item.get("type") not in {"compose_run", "skill_run"}

    # 关闭分享：旧 token 立即失效
    closed = await client.delete(f"/api/chat/sessions/{session_id}/share", headers=headers)
    assert closed.status_code == 200
    gone = await client.get(f"/api/share/chat/{payload['share_token']}")
    assert gone.status_code == 404


async def test_fork_shared_chat_copies_into_my_account(client):
    """「继续创作」= 复制一份：新会话属于访问者，原会话消息数不变。"""
    headers = await _headers(client)
    session_id = await _new_session(client, headers)
    async with AsyncSessionLocal() as db:
        db.add(ChatMessage(session_id=session_id, user_id=(await _admin_id()), role="user", content="原始需求"))
        await db.commit()

    shared = await client.post(f"/api/chat/sessions/{session_id}/share", headers=headers)
    token = shared.json()["data"]["share_token"]

    forked = await client.post(f"/api/share/chat/{token}/fork", headers=headers)
    assert forked.status_code == 200, forked.text
    clone_id = forked.json()["data"]["session_id"]
    assert clone_id != session_id

    clone_messages = await client.get(f"/api/chat/sessions/{clone_id}/messages", headers=headers)
    contents = [item["content"] for item in clone_messages.json()["data"]["items"]]
    assert "原始需求" in contents
    # 原件没被改动
    assert await _count_messages(session_id) == 1

    async with AsyncSessionLocal() as db:
        clone = (
            await db.execute(select(ChatSession).where(ChatSession.id == clone_id))
        ).scalar_one()
        assert clone.share_token is None, "复制出来的会话不应继承分享状态"
