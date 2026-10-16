"""pytest 公共夹具：独立测试库 + 建表/seed + 内存 ASGI 客户端。"""
from __future__ import annotations

import os
from pathlib import Path

# 必须在导入 app 之前设置测试环境变量
_TEST_DB = "./data/test_canvas_studio.db"
os.environ["CS_DATABASE_URL"] = f"sqlite+aiosqlite:///{_TEST_DB}"
os.environ.setdefault("CS_EMAIL_BACKEND", "console")
os.environ.setdefault("CS_SECRET_KEY", "test-secret")
os.environ.setdefault("CS_GATEWAY_BASE_URL", "http://localhost:8100")

Path("./data").mkdir(parents=True, exist_ok=True)

import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.database import AsyncSessionLocal, Base, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.seed import run_seed  # noqa: E402


@pytest_asyncio.fixture
async def client():
    """每个用例重建表结构并 seed，返回 ASGI 测试客户端。"""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    async with AsyncSessionLocal() as db:
        await run_seed(db)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest_asyncio.fixture
async def db():
    """提供一个可用的数据库会话。"""
    async with AsyncSessionLocal() as session:
        yield session


async def register_and_activate(client, email: str, password: str = "Passw0rd123") -> str:
    """辅助：注册 → 确认 → 登录，返回 access_token。"""
    from sqlalchemy import select

    from app.models.email_token import EmailToken
    from app.models.user import User

    resp = await client.post("/api/auth/register", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    async with AsyncSessionLocal() as session:
        user_id = (
            await session.execute(select(User.id).where(User.email == email))
        ).scalar_one()
        token = (
            await session.execute(
                select(EmailToken.token)
                .where(
                    EmailToken.user_id == user_id,
                    EmailToken.type == "verify",
                    EmailToken.used_at.is_(None),
                )
                .order_by(EmailToken.created_at.desc())
            )
        ).scalars().first()
    resp = await client.post("/api/auth/verify-email", json={"token": token})
    assert resp.status_code == 200, resp.text
    resp = await client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["access_token"]


@pytest.fixture
def auth_headers_factory():
    """返回构造 Authorization 头的小工具。"""

    def _make(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    return _make
