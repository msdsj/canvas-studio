"""QA 独立测试 · 认证与权限（HTTP API 契约层）。

对照 PRD 验收标准：
- P0-01 邮箱注册（格式/密码强度校验、重复邮箱拦截、注册即登录）
- P0-02 邮箱二次确认（历史 pending 不可登录 → active 可登录；token 一次性）
- P0-03 确认链接时效与重发限流
- P0-04 登录（错误凭据通用提示）
- P0-05 忘记密码/重置（旧密码失效）
- P0-06 权限模型（普通用户访问 /api/admin/* → 403；管理员可访问）

说明：注册流程已简化为「邮箱 + 密码 + 确认密码 → 直接激活并签发 JWT」，
不再有邮箱确认环节；未确认拦截 / 重发限流等用例改为直接落库造 pending 账号。
本文件由 QA 独立编写，使用内存 ASGI 客户端做黑盒契约验证，
不依赖工程师既有用例的断言。
"""
from __future__ import annotations

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.email_token import EmailToken
from app.models.user import User
from app.utils.ids import utcnow

ADMIN_EMAIL = "admin@canvas.studio"
ADMIN_PASSWORD = "Admin@12345"


async def _latest_token(token_type: str) -> str | None:
    """读取最新的指定类型邮箱令牌。"""
    async with AsyncSessionLocal() as session:
        result = await session.execute(
            select(EmailToken.token)
            .where(EmailToken.type == token_type)
            .order_by(EmailToken.created_at.desc())
        )
        return result.scalars().first()


async def _user_id(email: str) -> str:
    """按邮箱取用户 id。"""
    async with AsyncSessionLocal() as session:
        return (
            await session.execute(select(User.id).where(User.email == email))
        ).scalar_one()


async def _seed_pending(email: str, password: str = "Passw0rd123") -> None:
    """直接建一个 `pending_verification` 账号并发 verify 令牌。

    注册流程已简化为「注册即激活」，此处用于覆盖仍然保留的
    未确认拦截 / token 一次性 / 过期 / 重发限流等兜底路径。
    """
    from datetime import timedelta

    from app.security import hash_password
    from app.utils.ids import new_id

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


async def _admin_headers(client) -> dict[str, str]:
    """管理员登录并返回鉴权头。"""
    resp = await client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}


# --------------------------------------------------------------------------
# P0-01 注册校验
# --------------------------------------------------------------------------
async def test_qa_register_rejects_invalid_email(client):
    """非法邮箱格式 → 422 VALIDATION_ERROR（P0-01）。"""
    resp = await client.post(
        "/api/auth/register", json={"email": "not-an-email", "password": "Passw0rd123"}
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_qa_register_rejects_weak_password(client):
    """弱密码（<8 位）→ 422 VALIDATION_ERROR（P0-01）。"""
    resp = await client.post(
        "/api/auth/register", json={"email": "weak@example.com", "password": "abc"}
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_qa_register_duplicate_email_rejected(client):
    """重复注册同邮箱 → VALIDATION_ERROR（P0-01 / §5.1）。"""
    payload = {"email": "dup@example.com", "password": "Passw0rd123"}
    first = await client.post("/api/auth/register", json=payload)
    assert first.status_code == 200
    second = await client.post("/api/auth/register", json=payload)
    assert second.status_code == 422
    assert second.json()["code"] == "VALIDATION_ERROR"


async def test_qa_register_normalizes_email_case(client):
    """邮箱大小写归一：大写注册、小写登录视为同账号（§5.1）。"""
    reg = await client.post(
        "/api/auth/register", json={"email": "CaseTest@Example.com", "password": "Passw0rd123"}
    )
    assert reg.status_code == 200
    login = await client.post(
        "/api/auth/login", json={"email": "casetest@example.com", "password": "Passw0rd123"}
    )
    assert login.status_code == 200


# --------------------------------------------------------------------------
# P0-02 / P0-04 邮箱确认（历史遗留账号兜底）与登录
# --------------------------------------------------------------------------
async def test_qa_pending_cannot_login_then_active_can(client):
    """未确认不可登录（403）；确认后可登录（P0-02 / P0-04）。"""
    email = "pending@example.com"
    await _seed_pending(email)

    blocked = await client.post(
        "/api/auth/login", json={"email": email, "password": "Passw0rd123"}
    )
    assert blocked.status_code == 403
    assert blocked.json()["code"] == "FORBIDDEN"

    token = await _latest_token("verify")
    verify = await client.post("/api/auth/verify-email", json={"token": token})
    assert verify.status_code == 200
    assert verify.json()["data"]["status"] == "active"

    ok = await client.post("/api/auth/login", json={"email": email, "password": "Passw0rd123"})
    assert ok.status_code == 200
    assert ok.json()["data"]["access_token"]


async def test_qa_verify_token_single_use(client):
    """确认 token 一次性消费：二次使用 → 422（P0-02）。"""
    await _seed_pending("once@example.com")
    token = await _latest_token("verify")
    assert (await client.post("/api/auth/verify-email", json={"token": token})).status_code == 200
    reuse = await client.post("/api/auth/verify-email", json={"token": token})
    assert reuse.status_code == 422
    assert reuse.json()["code"] == "VALIDATION_ERROR"


async def test_qa_verify_invalid_token_rejected(client):
    """无效确认 token → 422（P0-02）。"""
    resp = await client.post("/api/auth/verify-email", json={"token": "totally-invalid"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_qa_verify_expired_token_rejected(client):
    """过期确认链接 → 422（P0-03）。"""
    from datetime import timedelta

    from sqlalchemy import update

    await _seed_pending("expired@example.com")
    token = await _latest_token("verify")
    async with AsyncSessionLocal() as session:
        await session.execute(
            update(EmailToken)
            .where(EmailToken.token == token)
            .values(expires_at=utcnow() - timedelta(hours=1))
        )
        await session.commit()

    resp = await client.post("/api/auth/verify-email", json={"token": token})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_qa_login_wrong_password_generic(client):
    """错误密码 → 401 UNAUTHORIZED 且不泄露账号是否存在（P0-04/§5.1）。"""
    await client.post(
        "/api/auth/register", json={"email": "u1@example.com", "password": "Passw0rd123"}
    )

    wrong_pw = await client.post(
        "/api/auth/login", json={"email": "u1@example.com", "password": "WrongPass9"}
    )
    unknown = await client.post(
        "/api/auth/login", json={"email": "ghost@example.com", "password": "WrongPass9"}
    )
    assert wrong_pw.status_code == unknown.status_code == 401
    # 两种失败返回相同通用文案（避免账号枚举）
    assert wrong_pw.json()["message"] == unknown.json()["message"]


# --------------------------------------------------------------------------
# P0-03 重发限流
# --------------------------------------------------------------------------
async def test_qa_resend_rate_limited_then_allowed(client):
    """60s 内重发 → 429；超窗后可重发（P0-03）。"""
    from datetime import timedelta

    from sqlalchemy import update

    await _seed_pending("resend@example.com")
    blocked = await client.post(
        "/api/auth/resend-verification", json={"email": "resend@example.com"}
    )
    assert blocked.status_code == 429
    assert blocked.json()["code"] == "RATE_LIMITED"

    async with AsyncSessionLocal() as session:
        await session.execute(
            update(EmailToken)
            .where(EmailToken.type == "verify")
            .values(created_at=utcnow() - timedelta(minutes=2))
        )
        await session.commit()
    ok = await client.post("/api/auth/resend-verification", json={"email": "resend@example.com"})
    assert ok.status_code == 200


async def test_qa_resend_unknown_email_no_leak(client):
    """重发未知邮箱不泄露账号存在性（统一 200，§5.1）。"""
    resp = await client.post("/api/auth/resend-verification", json={"email": "nobody@example.com"})
    assert resp.status_code == 200


# --------------------------------------------------------------------------
# P0-05 重置密码
# --------------------------------------------------------------------------
async def test_qa_reset_password_old_invalid(client):
    """重置密码后旧密码失效、新密码可登录（P0-05）。"""
    email = "resetme@example.com"
    await client.post("/api/auth/register", json={"email": email, "password": "Passw0rd123"})

    await client.post("/api/auth/forgot-password", json={"email": email})
    reset = await _latest_token("reset")
    assert reset
    done = await client.post(
        "/api/auth/reset-password", json={"token": reset, "new_password": "NewPassw0rd9"}
    )
    assert done.status_code == 200

    old = await client.post("/api/auth/login", json={"email": email, "password": "Passw0rd123"})
    new = await client.post("/api/auth/login", json={"email": email, "password": "NewPassw0rd9"})
    assert old.status_code == 401
    assert new.status_code == 200


# --------------------------------------------------------------------------
# P0-06 权限模型
# --------------------------------------------------------------------------
async def test_qa_non_admin_forbidden_on_all_admin_endpoints(client):
    """普通用户访问任意 /api/admin/* → 403 FORBIDDEN（P0-06）。"""
    await client.post(
        "/api/auth/register", json={"email": "normal@example.com", "password": "Passw0rd123"}
    )
    login = await client.post(
        "/api/auth/login", json={"email": "normal@example.com", "password": "Passw0rd123"}
    )
    headers = {"Authorization": f"Bearer {login.json()['data']['access_token']}"}

    for path in (
        "/api/admin/overview",
        "/api/admin/users",
        "/api/admin/pool/stats",
        "/api/admin/config",
        "/api/admin/logs",
    ):
        resp = await client.get(path, headers=headers)
        assert resp.status_code == 403, f"{path} 应为 403，实际 {resp.status_code}"
        assert resp.json()["code"] == "FORBIDDEN"


async def test_qa_anonymous_forbidden_on_admin(client):
    """未登录访问 /api/admin/* → 401 UNAUTHORIZED（P0-06/§8.3）。"""
    resp = await client.get("/api/admin/users")
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"


async def test_qa_admin_can_access_admin_endpoints(client):
    """管理员可访问后台接口（P0-06）。"""
    headers = await _admin_headers(client)
    overview = await client.get("/api/admin/overview", headers=headers)
    users = await client.get("/api/admin/users", headers=headers)
    assert overview.status_code == 200
    assert "users_total" in overview.json()["data"]
    assert users.status_code == 200
    assert "items" in users.json()["data"]


async def test_qa_banned_user_login_forbidden(client):
    """被封禁账号登录 → 403（P0-06/P0-04）。"""
    email = "banned@example.com"
    await client.post("/api/auth/register", json={"email": email, "password": "Passw0rd123"})
    uid = await _user_id(email)

    admin = await _admin_headers(client)
    ban = await client.post(f"/api/admin/users/{uid}/ban", json={"reason": "违规"}, headers=admin)
    assert ban.status_code == 200

    login = await client.post("/api/auth/login", json={"email": email, "password": "Passw0rd123"})
    assert login.status_code == 403
    assert login.json()["code"] == "FORBIDDEN"


async def test_qa_admin_creates_user_can_login(client):
    """超管创建企业账号：新账号可登录且自动加入刚开通的企业。"""
    admin = await _admin_headers(client)
    created = await client.post(
        "/api/admin/users",
        json={
            "email": "byadmin@example.com",
            "password": "Member12345",
            "team_name": "星跃设计",
        },
        headers=admin,
    )
    assert created.status_code == 200, created.text
    data = created.json()["data"]
    assert data["role"] == "user"
    assert data["status"] == "active"
    assert data["team_name"] == "星跃设计"
    assert data["active_team_id"]

    login = await client.post(
        "/api/auth/login", json={"email": "byadmin@example.com", "password": "Member12345"}
    )
    assert login.status_code == 200
    assert login.json()["data"]["user"]["role"] == "user"
    teams = await client.get(
        "/api/teams", headers={"Authorization": f"Bearer {login.json()['data']['access_token']}"}
    )
    assert teams.json()["data"]["items"][0]["role"] == "owner"


async def test_qa_admin_create_user_duplicate_email_rejected(client):
    """超管新建用户时重复邮箱 → 422（P0-06）。"""
    admin = await _admin_headers(client)
    payload = {"email": "dup-by-admin@example.com", "password": "Member12345"}
    assert (await client.post("/api/admin/users", json=payload, headers=admin)).status_code == 200
    second = await client.post("/api/admin/users", json=payload, headers=admin)
    assert second.status_code == 422
    assert second.json()["code"] == "VALIDATION_ERROR"


async def test_qa_non_admin_cannot_create_user(client):
    """普通用户调用后台新建用户 → 403（P0-06）。"""
    await client.post(
        "/api/auth/register", json={"email": "nosy@example.com", "password": "Passw0rd123"}
    )
    login = await client.post(
        "/api/auth/login", json={"email": "nosy@example.com", "password": "Passw0rd123"}
    )
    headers = {"Authorization": f"Bearer {login.json()['data']['access_token']}"}
    resp = await client.post(
        "/api/admin/users",
        json={"email": "hacked@example.com", "password": "Member12345"},
        headers=headers,
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"
