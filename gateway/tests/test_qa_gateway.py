"""QA 独立测试 · 网关（内网令牌 / Demo 降级 / 上游归一 / 健康探测）。

对照架构 §4.9 与 PRD P0-35/36：
- `/gw/*` 无或错误 X-Internal-Token → 401 UNAUTHORIZED
- Demo 模式（CS_DEMO_MODE=on）→ 占位图 + 模拟对话，响应标 demo:true
- Demo 模式 off → 直连上游透传（demo:false）；不可达时**不降级**、返回统一错误
- /gw/upstream/health 区分 PROXY_UNREACHABLE 与 UPSTREAM_ERROR
- 号池无可用账号 → POOL_UNAVAILABLE
"""
from __future__ import annotations

import base64
import io

import httpx
import pytest
from PIL import Image

from app.state import runtime_config


@pytest.fixture
def restore_runtime():
    """在每个用例前后保存/恢复运行时配置，避免相互污染。"""
    saved = (
        runtime_config.demo_mode,
        runtime_config.sub2api_base_url,
        runtime_config.chatgpt2api_base_url,
    )
    yield
    runtime_config.demo_mode, runtime_config.sub2api_base_url, runtime_config.chatgpt2api_base_url = saved


def _png_b64() -> str:
    """小 PNG 的 base64。"""
    buf = io.BytesIO()
    Image.new("RGB", (12, 12), color=(90, 90, 200)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


# --------------------------------------------------------------------------
# 内网令牌鉴权
# --------------------------------------------------------------------------
async def test_qa_gw_all_routes_require_internal_token(client):
    """所有 /gw/* 路由缺令牌 → 401 UNAUTHORIZED。"""
    checks = [
        ("GET", "/gw/health"),
        ("GET", "/gw/upstream/health"),
        ("POST", "/gw/images/generations"),
        ("POST", "/gw/chat/completions"),
        ("GET", "/gw/pool/accounts"),
        ("POST", "/gw/config/test"),
    ]
    for method, path in checks:
        resp = await client.request(method, path, json={})
        assert resp.status_code == 401, f"{method} {path} 应 401"
        assert resp.json()["code"] == "UNAUTHORIZED"


async def test_qa_gw_wrong_token_401(client):
    """错误令牌 → 401。"""
    resp = await client.get("/gw/health", headers={"X-Internal-Token": "wrong"})
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"


async def test_qa_gw_correct_token_ok(client, headers):
    """正确令牌 → 200 且 envelope.code == OK。"""
    resp = await client.get("/gw/health", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["code"] == "OK"


# --------------------------------------------------------------------------
# Demo 模式
# --------------------------------------------------------------------------
async def test_qa_demo_on_chat_nonstream(client, headers, restore_runtime):
    """demo=on 非流式对话返回模拟回复 + demo:true。"""
    runtime_config.demo_mode = "on"
    resp = await client.post(
        "/gw/chat/completions",
        headers=headers,
        json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "你好"}]},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["demo"] is True
    assert "choices" in data


async def test_qa_demo_off_passthrough_marked_not_demo(client, headers, mock_upstream, restore_runtime):
    """demo=off 透传上游成功结果，标记 demo:false。"""
    runtime_config.demo_mode = "off"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"created": 1, "data": [{"b64_json": _png_b64()}]})

    mock_upstream(handler)
    resp = await client.post(
        "/gw/images/generations",
        headers=headers,
        json={"prompt": "透传", "size": "64x64", "n": 1},
    )
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["demo"] is False
    assert data["data"][0]["b64_json"]


async def test_qa_demo_off_unreachable_no_fallback(client, headers, mock_upstream, restore_runtime):
    """demo=off 且上游不可达 → 不降级，返回统一错误（P0-36）。"""
    runtime_config.demo_mode = "off"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connect failed")

    mock_upstream(handler)
    resp = await client.post(
        "/gw/images/generations",
        headers=headers,
        json={"prompt": "不可达", "size": "64x64", "n": 1},
    )
    assert resp.status_code == 503
    assert resp.json()["code"] in {"PROXY_UNREACHABLE", "UPSTREAM_ERROR", "POOL_UNAVAILABLE"}
    # 不返回占位图
    assert resp.json()["data"] is None


async def test_qa_demo_auto_fallback_on_unreachable(client, headers, mock_upstream, restore_runtime):
    """demo=auto 且上游不可达 → 自动降级占位图 demo:true。"""
    runtime_config.demo_mode = "auto"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connect failed")

    mock_upstream(handler)
    resp = await client.post(
        "/gw/images/generations",
        headers=headers,
        json={"prompt": "自动降级", "size": "64x64", "n": 1},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["demo"] is True


# --------------------------------------------------------------------------
# 上游健康探测：PROXY_UNREACHABLE vs UPSTREAM_ERROR
# --------------------------------------------------------------------------
async def test_qa_upstream_health_proxy_unreachable(client, headers, monkeypatch, restore_runtime):
    """上游地址不可达（连接异常）→ 两个上游均报 PROXY_UNREACHABLE，整体 ok=false。"""

    def fake_make_client(base_url: str, *, read_timeout: float | None = None):
        def _raise(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused")

        transport = httpx.MockTransport(_raise)
        return httpx.AsyncClient(transport=transport, base_url=base_url, trust_env=False)

    monkeypatch.setattr("app.upstream.make_client", fake_make_client)
    resp = await client.get("/gw/upstream/health", headers=headers)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["ok"] is False
    assert data["sub2api"]["error_code"] == "PROXY_UNREACHABLE"
    assert data["chatgpt2api"]["error_code"] == "PROXY_UNREACHABLE"


async def test_qa_upstream_health_upstream_error(client, headers, monkeypatch, restore_runtime):
    """上游返回 5xx → UPSTREAM_ERROR（区别于代理不可达）。"""

    def fake_make_client(base_url: str, *, read_timeout: float | None = None):
        transport = httpx.MockTransport(lambda request: httpx.Response(500, json={"err": "x"}))
        return httpx.AsyncClient(transport=transport, base_url=base_url, trust_env=False)

    monkeypatch.setattr("app.upstream.make_client", fake_make_client)
    resp = await client.get("/gw/upstream/health", headers=headers)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["ok"] is False
    assert data["sub2api"]["error_code"] == "UPSTREAM_ERROR"
    assert data["chatgpt2api"]["error_code"] == "UPSTREAM_ERROR"


# --------------------------------------------------------------------------
# 号池无可用账号 → POOL_UNAVAILABLE
# --------------------------------------------------------------------------
async def test_qa_pool_unavailable_mapping(client, headers, mock_upstream, restore_runtime):
    """上游提示无可用账号 → POOL_UNAVAILABLE(503)。"""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, text="no available account in pool")

    mock_upstream(handler)
    resp = await client.get("/gw/pool/accounts", headers=headers)
    assert resp.status_code == 503
    assert resp.json()["code"] == "POOL_UNAVAILABLE"


# --------------------------------------------------------------------------
# 运行时配置推送即时生效
# --------------------------------------------------------------------------
async def test_qa_config_push_takes_effect(client, headers, restore_runtime):
    """POST /gw/config 推送 demo_mode 后，/gw/health 立即反映（不重启）。"""
    resp = await client.post("/gw/config", headers=headers, json={"demo_mode": "on"})
    assert resp.status_code == 200
    assert resp.json()["data"]["config"]["demo_mode"] == "on"

    health = await client.get("/gw/health", headers=headers)
    assert health.json()["data"]["demo_mode"] == "on"

    # 快照不泄露密钥明文
    snapshot = resp.json()["data"]["config"]
    assert "api_key" not in snapshot
    assert "admin_key" not in snapshot
