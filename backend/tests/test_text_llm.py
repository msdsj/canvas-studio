"""统一文本入口：中转站优先、网关兜底的优先级不能反。

这条规则是「中转站明明连接正常，AI 分析却说不可用」的修复核心。
用 monkeypatch 把两条链路都替成假的，只验证**选择逻辑**，不打真实网络。
"""
from __future__ import annotations

import pytest

from app.services import text_llm
from app.utils.errors import AppError, ErrorCode


class _Target:
    model = "fake-relay-model"


@pytest.fixture
def fake_relay(monkeypatch):
    calls: dict[str, int] = {"relay": 0, "gateway": 0}

    async def resolve(db, user_id):
        return _Target()

    async def chat(db, user_id, messages, **kwargs):
        calls["relay"] += 1
        return {"content": '{"reply":"ok"}', "model": "fake-relay-model"}

    async def gateway(payload):
        calls["gateway"] += 1
        return {"choices": [{"message": {"content": '{"reply":"gateway"}'}}]}

    monkeypatch.setattr(text_llm.relay_service, "resolve", resolve)
    monkeypatch.setattr(text_llm.relay_service, "chat", chat)
    monkeypatch.setattr(text_llm.gateway_client, "llm_completions", gateway)
    return calls


async def test_relay_is_preferred_when_available(fake_relay):
    result = await text_llm.complete(None, "user-1", [{"role": "user", "content": "hi"}])
    assert result.source == "relay"
    assert result.content == '{"reply":"ok"}'
    assert fake_relay == {"relay": 1, "gateway": 0}


async def test_gateway_fallback_when_relay_fails(monkeypatch, fake_relay):
    async def broken_chat(*args, **kwargs):
        raise AppError(ErrorCode.UPSTREAM_ERROR, "relay down")

    monkeypatch.setattr(text_llm.relay_service, "chat", broken_chat)
    result = await text_llm.complete(None, "user-1", [{"role": "user", "content": "hi"}])
    assert result.source == "gateway"
    assert result.content == '{"reply":"gateway"}'


async def test_gateway_when_no_user_context(monkeypatch, fake_relay):
    async def resolve_none(db, user_id):
        return None

    monkeypatch.setattr(text_llm.relay_service, "resolve", resolve_none)
    result = await text_llm.complete(None, None, [{"role": "user", "content": "hi"}])
    assert result.source == "gateway"
    assert fake_relay["gateway"] == 1


async def test_error_hint_is_used_when_both_fail(monkeypatch):
    async def resolve_none(db, user_id):
        return None

    async def broken_gateway(payload):
        raise AppError(ErrorCode.UPSTREAM_ERROR, "raw upstream detail")

    monkeypatch.setattr(text_llm.relay_service, "resolve", resolve_none)
    monkeypatch.setattr(text_llm.gateway_client, "llm_completions", broken_gateway)

    with pytest.raises(AppError) as info:
        await text_llm.complete(
            None, None, [{"role": "user", "content": "hi"}], error_hint="去看中转站配置"
        )
    assert info.value.message == "去看中转站配置"
