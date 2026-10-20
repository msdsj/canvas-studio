"""Independent intent-provider SSE routing, authentication and honest failures."""
from __future__ import annotations

import json

import httpx
import pytest

from app.state import runtime_config


@pytest.fixture(autouse=True)
def intent_config(monkeypatch):
    for key, value in {
        "demo_mode": "off", "llm_base_url": "https://intent.test/v1",
        "llm_api_key": "test-intent-key", "llm_model": "intent-primary", "llm_model_fallbacks": [],
        "text_base_url": "https://text.test/v1", "text_api_key": "test-text-key",
        "text_model": "text-primary", "text_model_fallbacks": [],
    }.items():
        monkeypatch.setattr(runtime_config, key, value)


def _install(monkeypatch, handler):
    def factory(base_url, **kwargs):
        return httpx.AsyncClient(base_url=base_url, transport=httpx.MockTransport(handler), trust_env=False)

    monkeypatch.setattr("app.upstream.make_client", factory)


def _stream(content="已核对原图与需求"):
    body = json.dumps({"choices": [{"delta": {"content": content}}]}, ensure_ascii=False)
    return httpx.Response(200, text=f"data: {body}\n\ndata: [DONE]\n\n", headers={"content-type": "text/event-stream"})


async def test_llm_stream_uses_independent_url_key_and_model(client, headers, monkeypatch):
    seen = []

    def handler(request):
        seen.append(request)
        return _stream()

    _install(monkeypatch, handler)
    response = await client.post(
        "/gw/chat/llm-completions", headers=headers,
        json={"messages": [{"role": "user", "content": "帮我分析需求"}], "stream": True, "model": "client-default"},
    )
    assert response.status_code == 200
    assert "已核对原图与需求" in response.text
    assert len(seen) == 1
    request = seen[0]
    assert str(request.url) == "https://intent.test/v1/chat/completions"
    assert request.headers["Authorization"] == "Bearer test-intent-key"
    assert json.loads(request.content)["model"] == "intent-primary"
    assert json.loads(request.content)["stream"] is True


async def test_llm_stream_falls_back_to_text_role_when_independent_config_is_empty(client, headers, monkeypatch):
    for key in ("llm_base_url", "llm_api_key", "llm_model"):
        monkeypatch.setattr(runtime_config, key, "")
    seen = []

    def handler(request):
        seen.append(request)
        return _stream()

    _install(monkeypatch, handler)
    response = await client.post("/gw/chat/llm-completions", headers=headers, json={"stream": True})
    assert "已核对原图与需求" in response.text
    assert seen[0].url.host == "text.test"
    assert seen[0].headers["Authorization"] == "Bearer test-text-key"
    assert json.loads(seen[0].content)["model"] == "text-primary"


async def test_llm_stream_rejects_html_before_any_plan_output_and_uses_fallback(client, headers, monkeypatch):
    monkeypatch.setattr(runtime_config, "llm_model_fallbacks", ["intent-backup"])
    seen = []

    def handler(request):
        model = json.loads(request.content)["model"]
        seen.append(model)
        if model == "intent-primary":
            return httpx.Response(200, text="<html>upstream unavailable</html>")
        return _stream("备用模型已解析需求")

    _install(monkeypatch, handler)
    response = await client.post("/gw/chat/llm-completions", headers=headers, json={"stream": True})
    assert "备用模型已解析需求" in response.text
    assert "<html>" not in response.text
    assert seen == ["intent-primary", "intent-backup"]


async def test_demo_mode_cannot_manufacture_a_successful_intent_plan(client, headers, monkeypatch):
    monkeypatch.setattr(runtime_config, "demo_mode", "on")
    calls = []
    _install(monkeypatch, lambda request: calls.append(request))
    response = await client.post("/gw/chat/llm-completions", headers=headers, json={"stream": True})
    assert response.status_code == 200
    assert '"error_code":' in response.text
    assert "choices" not in response.text
    assert calls == []
