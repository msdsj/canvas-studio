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


async def _seed_pending_user(email: str, password: str = "Passw0rd123") -> None:
    """直接建一个 `pending_verification` 账号并发 verify 令牌。

    注册流程已不再产生这类账号，但仍可能由历史数据 / 后台代建产生，
    「未确认禁止登录 + 确认后可登录」这条兜底路径需要保留覆盖。
    """
    from datetime import timedelta

    from app.models.user import User
    from app.security import hash_password
    from app.utils.ids import new_id, utcnow

    async with AsyncSessionLocal() as session:
        user = User(
            id=new_id(),
            email=email,
            password_hash=hash_password(password),
            role="user",
            status="pending_verification",
            display_name=email.split("@")[0],
        )
        session.add(user)
        await session.flush()
        session.add(
            EmailToken(
                id=new_id(),
                user_id=user.id,
                token=new_id().replace("-", ""),
                type="verify",
                expires_at=utcnow() + timedelta(hours=24),
            )
        )
        await session.commit()


async def test_register_returns_login_token(client):
    """注册即登录：直接返回 access_token，账号 active 且邮箱已标记确认。"""
    resp = await client.post(
        "/api/auth/register", json={"email": "a@example.com", "password": "Passw0rd123"}
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["access_token"]
    assert data["user"]["status"] == "active"
    assert data["user"]["role"] == "user"
    assert data["user"]["email_verified_at"] is not None

    me = await client.get(
        "/api/auth/me", headers={"Authorization": f"Bearer {data['access_token']}"}
    )
    assert me.status_code == 200
    assert me.json()["data"]["email"] == "a@example.com"


async def test_register_grants_initial_balance(client):
    """注册即发放初始额度 200（不再需要邮箱确认这一步）。"""
    resp = await client.post(
        "/api/auth/register", json={"email": "b@example.com", "password": "Passw0rd123"}
    )
    headers = {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}
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


async def test_legacy_pending_user_blocked_until_verified(client):
    """历史 pending 账号禁止登录；确认邮箱后才可登录（保留兜底路径）。"""
    await _seed_pending_user("e@example.com")
    resp = await client.post(
        "/api/auth/login", json={"email": "e@example.com", "password": "Passw0rd123"}
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"

    token = await _latest_token("verify")
    assert token
    assert (
        await client.post("/api/auth/verify-email", json={"token": token})
    ).status_code == 200

    resp = await client.post(
        "/api/auth/login", json={"email": "e@example.com", "password": "Passw0rd123"}
    )
    assert resp.status_code == 200


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
    """60s 内重发被限流；超窗后允许重发。"""
    from datetime import timedelta

    from sqlalchemy import update

    from app.utils.ids import utcnow

    await _seed_pending_user("g@example.com")
    # 刚建号就已发过一封，60s 内重发应被限流
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
