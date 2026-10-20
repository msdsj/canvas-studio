"""网关 pytest 夹具：内存 ASGI 客户端 + 上游 MockTransport。"""
from __future__ import annotations

import os

os.environ.setdefault("CS_GATEWAY_INTERNAL_TOKEN", "dev-internal-token")

from collections.abc import Callable  # noqa: E402

import httpx  # noqa: E402
import pytest  # noqa: E402
import pytest_asyncio  # noqa: E402
from httpx import ASGITransport, AsyncClient  # noqa: E402

from app.main import app  # noqa: E402

TOKEN = "dev-internal-token"


@pytest_asyncio.fixture
async def client():
    """网关 ASGI 测试客户端。"""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://gw") as ac:
        yield ac


@pytest.fixture
def headers() -> dict[str, str]:
    """内部令牌请求头。"""
    return {"X-Internal-Token": TOKEN}


@pytest.fixture(autouse=True)
def isolated_pool(monkeypatch):
    """让每个用例使用独立号池文件，避免污染仓库里的真实 data/。

    号池默认落在 ./data/provider_accounts.json，测试若直接复用会写入脏数据、
    并让后续用例的账号数对不上。这里把 POOL_FILE 指到 tests/.tmp 并重置内存缓存。
    """
    from pathlib import Path

    from app.services.account_pool import account_pool

    pool_dir = Path(__file__).resolve().parent / ".tmp"
    try:
        pool_dir.mkdir(exist_ok=True)
    except Exception:  # noqa: BLE001 - 沙箱 shim 对 mkdir 会抛 EEXIST，目录已存在即可
        pass
    pool_path = pool_dir / "provider_accounts.json"
    pool_path.write_text('{"version": 1, "accounts": []}', encoding="utf-8")

    monkeypatch.setattr("app.config.settings.pool_file", str(pool_path), raising=False)
    monkeypatch.setattr(account_pool, "_accounts", {}, raising=False)
    monkeypatch.setattr(account_pool, "_loaded", False, raising=False)
    monkeypatch.setattr(account_pool, "_batches", {}, raising=False)
    monkeypatch.setattr(account_pool, "_cursor", 0, raising=False)
    yield
    monkeypatch.setattr(account_pool, "_accounts", {}, raising=False)
    monkeypatch.setattr(account_pool, "_loaded", False, raising=False)
    monkeypatch.setattr(account_pool, "_batches", {}, raising=False)


@pytest.fixture
def mock_upstream(monkeypatch):
    """把上游客户端替换为 httpx.MockTransport。"""

    def _install(handler: Callable[[httpx.Request], httpx.Response]) -> None:
        from app.state import runtime_config

        # Pool proxy resolves its root URL before creating the mocked client.
        # Tests must not depend on a developer's untracked .env being present.
        if not runtime_config.image_base_url:
            monkeypatch.setattr(runtime_config, "image_base_url", "http://upstream/v1")
        transport = httpx.MockTransport(handler)

        def factory(*_args, **_kwargs):
            return httpx.AsyncClient(
                transport=transport, base_url="http://upstream", trust_env=False
            )

        # 新架构统一走 provider_client(role) 工厂；各模块各自持有一份引用，需逐个替换。
        monkeypatch.setattr("app.upstream.provider_client", factory, raising=False)
        for module in (
            "app.services.pool_proxy",
            "app.services.image_router",
            "app.services.chat_router",
        ):
            monkeypatch.setattr(f"{module}.provider_client", factory, raising=False)
        # 兼容仍按旧名导入的调用点
        monkeypatch.setattr("app.upstream.chatgpt2api_client", factory, raising=False)
        monkeypatch.setattr("app.upstream.sub2api_client", factory, raising=False)

    return _install
