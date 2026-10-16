"""认证 / 邮件流程单测。"""
from __future__ import annotations

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.email_token import EmailToken
from tests.conftest import register_and_activate


async def _latest_token(token_type: str) -> str:
    """读取最新的邮箱令牌。"""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(EmailToken.token)
            .where(EmailToken.type == token_type)
            .order_by(EmailToken.created_at.desc())
        )
        return result.scalars().first()


async def test_register_pending_then_verify(client):
    """注册后为 pending，确认后为 active。"""
    resp = await client.post(
        "/api/auth/register", json={"email": "a@example.com", "password": "Passw0rd123"}
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "pending_verification"

    token = await _latest_token("verify")
    assert token

    resp = await client.post("/api/auth/verify-email", json={"token": token})
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "active"


async def test_verify_grants_initial_balance(client):
    """邮箱确认后发放初始额度 200。"""
    await client.post(
        "/api/auth/register", json={"email": "b@example.com", "password": "Passw0rd123"}
    )
    token = await _latest_token("verify")
    await client.post("/api/auth/verify-email", json={"token": token})

    login = await client.post(
        "/api/auth/login", json={"email": "b@example.com", "password": "Passw0rd123"}
    )
    headers = {"Authorization": f"Bearer {login.json()['data']['access_token']}"}
    quota = await client.get("/api/me/quota", headers=headers)
    assert quota.json()["data"]["balance"] == 200


async def test_login_and_me(client):
    """登录签发 JWT，/api/auth/me 可读。"""
    token = await register_and_activate(client, "c@example.com")
    me = await client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["data"]["email"] == "c@example.com"


async def test_login_wrong_password(client):
    """错误密码返回 UNAUTHORIZED。"""
    await register_and_activate(client, "d@example.com")
    resp = await client.post(
        "/api/auth/login", json={"email": "d@example.com", "password": "wrong-pass"}
    )
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"


async def test_login_before_verify_forbidden(client):
    """未确认邮箱禁止登录。"""
    await client.post(
        "/api/auth/register", json={"email": "e@example.com", "password": "Passw0rd123"}
    )
    resp = await client.post(
        "/api/auth/login", json={"email": "e@example.com", "password": "Passw0rd123"}
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"


async def test_forgot_and_reset_password(client):
    """忘记密码 → 重置 → 新密码可登录。"""
    await register_and_activate(client, "f@example.com")
    resp = await client.post("/api/auth/forgot-password", json={"email": "f@example.com"})
    assert resp.status_code == 200

    token = await _latest_token("reset")
    resp = await client.post(
        "/api/auth/reset-password", json={"token": token, "new_password": "NewPassw0rd1"}
    )
    assert resp.status_code == 200

    resp = await client.post(
        "/api/auth/login", json={"email": "f@example.com", "password": "NewPassw0rd1"}
    )
    assert resp.status_code == 200


async def test_resend_verification_rate_limited(client):
    """注册后 60s 内重发被限流；超窗后允许重发。"""
    from datetime import timedelta

    from sqlalchemy import update

    from app.models.email_token import EmailToken
    from app.utils.ids import utcnow

    await client.post(
        "/api/auth/register", json={"email": "g@example.com", "password": "Passw0rd123"}
    )
    # 注册本身已发送一封，60s 内重发应被限流
    blocked = await client.post("/api/auth/resend-verification", json={"email": "g@example.com"})
    assert blocked.status_code == 429
    assert blocked.json()["code"] == "RATE_LIMITED"

    # 把已有 verify 令牌时间回拨 2 分钟，模拟冷却结束
    async with AsyncSessionLocal() as session:
        await session.execute(
            update(EmailToken)
            .where(EmailToken.type == "verify")
            .values(created_at=utcnow() - timedelta(minutes=2))
        )
        await session.commit()

    ok = await client.post("/api/auth/resend-verification", json={"email": "g@example.com"})
    assert ok.status_code == 200


async def test_require_admin_guard(client):
    """普通用户访问后台返回 403。"""
    token = await register_and_activate(client, "h@example.com")
    resp = await client.get("/api/admin/overview", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"


async def test_change_password(client):
    """修改密码后旧 token 失效。"""
    token = await register_and_activate(client, "i@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    resp = await client.post(
        "/api/me/change-password",
        json={"old_password": "Passw0rd123", "new_password": "Changed12345"},
        headers=headers,
    )
    assert resp.status_code == 200
    # token_version 递增，旧 token 失效
    stale = await client.get("/api/me", headers=headers)
    assert stale.status_code == 401
