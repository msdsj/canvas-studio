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


@pytest.fixture
def mock_upstream(monkeypatch):
    """把上游客户端替换为 httpx.MockTransport。"""

    def _install(handler: Callable[[httpx.Request], httpx.Response]) -> None:
        transport = httpx.MockTransport(handler)

        def factory(*_args, **_kwargs):
            return httpx.AsyncClient(
                transport=transport, base_url="http://upstream", trust_env=False
            )

        monkeypatch.setattr("app.upstream.chatgpt2api_client", factory)
        monkeypatch.setattr("app.upstream.sub2api_client", factory)
        monkeypatch.setattr("app.services.pool_proxy.chatgpt2api_client", factory)
        monkeypatch.setattr("app.services.image_router.chatgpt2api_client", factory)
        monkeypatch.setattr("app.services.chat_router.sub2api_client", factory)

    return _install
