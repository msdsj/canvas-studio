"""回复正文流式输出（compose_reply）：中转站流式 / 非流式 / 失败回落。

回复是「把已定的结论说成人话」，所以这里只测两件事：
1. 能把上游正文逐段吐给前端（跳过思考草稿，兼容不支持流式的中转站）；
2. 任何失败都回落到本地文案，且完整正文写进 sink，主流程不受影响。
"""
from __future__ import annotations

import json

from app.services import compose_service, relay_service
from app.services.relay_service import build_target_from_draft
from tests.mock_relay import FakeUpstream, ok, sse, status


def _deltas(chunks: list[str]) -> list[dict]:
    events = []
    for chunk in chunks:
        assert chunk.startswith("data: ")
        events.append(json.loads(chunk[6:].strip()))
    return events


async def _collect(target, *, fallback: str = "好的，开始画。") -> tuple[list[dict], str]:
    sink: list[str] = []
    chunks = [
        chunk
        async for chunk in compose_service._stream_reply(
            None,
            target,
            mode="direct",
            facts={"user_text": "海报", "title": "极简海报", "image_count": 1},
            fallback=fallback,
            sink=sink,
        )
    ]
    return _deltas(chunks), sink[0]


async def test_chat_stream_skips_reasoning_and_yields_content():
    with FakeUpstream() as upstream:
        upstream.script("m", sse("好的，", "开始画「极简海报」。"))
        target = build_target_from_draft(base_url=upstream.base_url, api_key="k", model="m")
        pieces = [piece async for piece in relay_service.chat_stream(target, [{"role": "user", "content": "x"}])]
    assert pieces == ["好的，", "开始画「极简海报」。"], "思考草稿不该出现在正文里"


async def test_chat_stream_accepts_non_streaming_relay():
    """中转站无视 stream=true、一次性回整包：照样拿到正文。"""
    with FakeUpstream() as upstream:
        upstream.script("m", ok("整包回复正文"))
        target = build_target_from_draft(base_url=upstream.base_url, api_key="k", model="m")
        pieces = [piece async for piece in relay_service.chat_stream(target, [{"role": "user", "content": "x"}])]
    assert pieces == ["整包回复正文"]


async def test_stream_reply_streams_relay_text_into_sink():
    with FakeUpstream() as upstream:
        upstream.script("m", sse("好的，开始画「极简海报」。\n\n", "- 画幅 `3:4`"))
        target = build_target_from_draft(base_url=upstream.base_url, api_key="k", model="m")
        events, text = await _collect(target)
    assert all(event["event"] == "delta" for event in events)
    assert "".join(event["text"] for event in events) == text
    assert text.startswith("好的，开始画「极简海报」") and "`3:4`" in text


async def test_stream_reply_falls_back_on_upstream_error():
    with FakeUpstream() as upstream:
        upstream.script("m", status(500))
        target = build_target_from_draft(base_url=upstream.base_url, api_key="k", model="m")
        events, text = await _collect(target, fallback="好的，按你的描述开始画。")
    assert text == "好的，按你的描述开始画。"
    assert "".join(event.get("text", "") for event in events) == text


async def test_stream_reply_without_relay_uses_typewriter_fallback():
    events, text = await _collect(None, fallback="还没连上中转站，我先停在这里。")
    assert text == "还没连上中转站，我先停在这里。"
    assert len(events) > 1, "回落文案也要分段吐出，前端才能有打字效果"
