"""Only public content deltas cross the intent gateway boundary."""
from __future__ import annotations

import json

import httpx
import pytest

from app.services.gateway_client import GatewayClient
from app.utils.errors import AppError, ErrorCode


def _client(monkeypatch, events):
    gateway = GatewayClient()
    chunks = ["data: " + json.dumps(event, ensure_ascii=False) + "\n\n" for event in events]
    body = "".join(chunks) + "data: [DONE]\n\n"
    transport = httpx.MockTransport(lambda request: httpx.Response(200, text=body, headers={"content-type": "text/event-stream"}))
    monkeypatch.setattr(gateway, "_client", lambda: httpx.AsyncClient(base_url="http://gateway.test", transport=transport))
    return gateway


def _response_client(monkeypatch, response_or_handler):
    gateway = GatewayClient()
    handler = response_or_handler if callable(response_or_handler) else lambda request: response_or_handler
    transport = httpx.MockTransport(handler)
    monkeypatch.setattr(gateway, "_client", lambda: httpx.AsyncClient(base_url="http://gateway.test", transport=transport))
    return gateway


async def test_private_reasoning_fields_do_not_enter_public_analysis_stream(monkeypatch):
    gateway = _client(monkeypatch, [
        {"choices": [{"delta": {"reasoning_content": "private reasoning", "thinking": "private draft"}}]},
        {"choices": [{"delta": {"content": "已识别两项产出。", "reasoning_content": "private chain"}}]},
        {"choices": [{"delta": {"content": "下面分别执行。"}, "finish_reason": "stop"}]},
    ])
    pieces = [part async for part in gateway.llm_text_stream({"messages": []})]
    assert pieces == ["已识别两项产出。", "下面分别执行。"]
    assert "private" not in "".join(pieces)


async def test_truncated_plan_stream_raises_instead_of_becoming_a_dispatchable_plan(monkeypatch):
    gateway = _client(monkeypatch, [
        {"choices": [{"delta": {"content": "partial plan"}, "finish_reason": "length"}]},
    ])
    with pytest.raises(AppError) as info:
        _ = [part async for part in gateway.llm_text_stream({"messages": []})]
    assert info.value.code == ErrorCode.UPSTREAM_FORMAT_ERROR


async def test_gateway_error_event_is_reported_without_forwarding_provider_details(monkeypatch):
    gateway = _client(monkeypatch, [{"error_code": "UPSTREAM_ERROR", "message": "internal provider details"}])
    with pytest.raises(AppError) as info:
        _ = [part async for part in gateway.llm_text_stream({"messages": []})]
    assert info.value.code == ErrorCode.UPSTREAM_ERROR
    assert "internal provider details" not in info.value.message


@pytest.mark.parametrize("content_type", ["application/json; charset=utf-8", "text/event-stream"])
async def test_nonstreaming_provider_json_returns_only_public_message_content(monkeypatch, content_type):
    public = "公开需求解析与执行计划。" * 15
    body = {"choices": [{"message": {"content": public, "reasoning_content": "private draft"}, "finish_reason": "stop"}]}
    gateway = _response_client(monkeypatch, httpx.Response(
        200, text=json.dumps(body, indent=2, ensure_ascii=False), headers={"content-type": content_type},
    ))
    pieces = [piece async for piece in gateway.llm_text_stream({})]
    assert "".join(pieces) == public
    assert len(pieces) > 1 and max(map(len, pieces)) <= 80
    assert "private" not in "".join(pieces)


async def test_older_gateway_json_envelope_is_unwrapped(monkeypatch):
    gateway = _response_client(monkeypatch, httpx.Response(200, json={
        "code": "OK", "data": {"choices": [{"message": {"content": "公开分析"}}]},
    }))
    assert [piece async for piece in gateway.llm_text_stream({})] == ["公开分析"]


@pytest.mark.parametrize("body, code", [
    ({"demo": True, "choices": [{"message": {"content": "fake plan"}}]}, ErrorCode.UPSTREAM_ERROR),
    ({"error": {"message": "provider details"}}, ErrorCode.UPSTREAM_ERROR),
    ({"choices": [{"message": {"content": "partial"}, "finish_reason": "length"}]}, ErrorCode.UPSTREAM_FORMAT_ERROR),
    ({"choices": [{"message": {"reasoning_content": "private only"}}]}, ErrorCode.UPSTREAM_FORMAT_ERROR),
    ([{"message": "unexpected structure"}], ErrorCode.UPSTREAM_FORMAT_ERROR),
])
async def test_nonstreaming_invalid_or_private_only_response_cannot_become_a_plan(monkeypatch, body, code):
    gateway = _response_client(monkeypatch, httpx.Response(200, json=body))
    with pytest.raises(AppError) as info:
        _ = [piece async for piece in gateway.llm_text_stream({})]
    assert info.value.code == code


@pytest.mark.parametrize("error, code", [
    (httpx.ConnectError("private endpoint/key"), ErrorCode.PROXY_UNREACHABLE),
    (httpx.ReadTimeout("private endpoint/key"), ErrorCode.UPSTREAM_ERROR),
    (httpx.RemoteProtocolError("private endpoint/key"), ErrorCode.UPSTREAM_ERROR),
])
async def test_transport_errors_are_normalized_without_provider_details(monkeypatch, error, code):
    def handler(request):
        raise error

    gateway = _response_client(monkeypatch, handler)
    with pytest.raises(AppError) as info:
        _ = [piece async for piece in gateway.llm_text_stream({})]
    assert info.value.code == code
    assert "private" not in info.value.message
