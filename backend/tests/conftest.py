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
# 本地 .env 为了限流把并发上限调成 2，但用例会一次创建 3 个任务；
# 测试必须和本地运行配置解耦，否则同一套测试在不同机器上结果不同。
os.environ.setdefault("CS_MAX_ACTIVE_TASKS_PER_USER", "12")

Path("./data").mkdir(parents=True, exist_ok=True)

# 会话开始前先删掉上一次遗留的测试库。
#
# 用例的 `client` 夹具每例都会 drop_all + create_all，但 SQLite 的 -wal/-shm
# 残留会让「删表」偶发锁失败，表没删干净 → 下一个用例拿到旧行数据，
# 于是报 `StaleDataError: UPDATE ... 0 rows matched` 这类看不懂的错。
# 本地跑久了 WAL 会涨到几 MB（实测 4.3MB），踩中概率不低。
# 测试库是可再生数据，直接删最省事。
for _suffix in ("", "-wal", "-shm"):
    _stale = Path(_TEST_DB + _suffix)
    try:
        if _stale.exists():
            _stale.unlink()
    except OSError:
        pass

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


async def register_and_activate(
    client, email: str, password: str = "Passw0rd123", role: str = "pro"
) -> str:
    """辅助：注册 → 按需提权 → 登录，返回 access_token。

    注册流程已简化为「注册即激活并直接签发 JWT」，不再有邮箱确认环节，
    所以这里不再需要读 verify token 去调 verify-email。

    默认把账号设为 `pro`：本平台的画布 / 抠图 / AI 对话 / 润色 / 图生图 属 Pro 能力，
    功能用例需要在「已解锁」的前提下验证行为；要验证普通用户受限，显式传 `role="user"`。
    """
    from sqlalchemy import select

    from app.models.user import User

    resp = await client.post("/api/auth/register", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    if role != "user":
        async with AsyncSessionLocal() as session:
            row = (
                await session.execute(select(User).where(User.email == email))
            ).scalar_one()
            row.role = role
            await session.commit()
    resp = await client.post("/api/auth/login", json={"email": email, "password": password})
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["access_token"]


@pytest.fixture
def auth_headers_factory():
    """返回构造 Authorization 头的小工具。"""

    def _make(token: str) -> dict[str, str]:
        return {"Authorization": f"Bearer {token}"}

    return _make
