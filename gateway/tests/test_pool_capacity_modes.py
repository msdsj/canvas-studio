"""容量快照必须覆盖「账号在上游」这一最常见部署形态。

回归背景：用户导入了 4 个 ChatGPT 凭据，账号在上游 chatgpt2api 里，
本地独立池是空的。旧版 `/gw/pool/capacity` 只报本地池（0/0），
批量预检据此认为「没有可路由账号」，把「拆成 2 张图」直接拒掉——
账号明明在、单张也能出，多图却出不了。这里锁死三种模式的判定。
"""
from __future__ import annotations

import pytest

from app.services import pool_proxy
from app.state import runtime_config


@pytest.fixture(autouse=True)
def _fresh_cache(monkeypatch):
    """容量缓存是模块级的：每个用例都要从「没有缓存」开始。"""
    monkeypatch.setattr(
        "app.routers.pool._upstream_cache", {"at": 0.0, "total": 0.0, "healthy": 0.0}
    )


@pytest.fixture
def upstream_configured(monkeypatch):
    monkeypatch.setattr(runtime_config, "image_base_url", "http://upstream/v1", raising=False)


async def test_capacity_uses_upstream_pool_when_local_empty(client, headers, upstream_configured, monkeypatch):
    async def fake_list():
        return {
            "items": [
                {"source": "upstream", "status": "normal"},
                {"source": "upstream", "status": "normal"},
                {"source": "upstream", "status": "normal"},
                {"source": "upstream", "status": "limited"},
            ]
        }

    monkeypatch.setattr(pool_proxy, "list_accounts", fake_list)
    data = (await client.get("/gw/pool/capacity", headers=headers)).json()["data"]

    assert data["routing_mode"] == "upstream"
    assert data["upstream_total"] == 4
    assert data["upstream_healthy"] == 3
    assert data["effective_total"] == 4
    assert data["effective_available"] == 3
    # 本地独立路由仍然是 0——两个概念不能混
    assert data["total"] == 0


async def test_capacity_none_without_local_or_upstream(client, headers, monkeypatch):
    monkeypatch.setattr(runtime_config, "image_base_url", "", raising=False)
    data = (await client.get("/gw/pool/capacity", headers=headers)).json()["data"]

    assert data["routing_mode"] == "none"
    assert data["effective_total"] == 0
    assert data["effective_available"] == 0
