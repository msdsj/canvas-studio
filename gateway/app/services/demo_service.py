"""Demo 降级服务：模拟对话。"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

from app.utils.streaming import openai_chunk, sse_line

def demo_chat_reply(messages: list[dict[str, Any]]) -> str:
    """根据最后一条用户消息构造模拟回复。"""
    last_user = ""
    for message in reversed(messages):
        if message.get("role") == "user":
            last_user = str(message.get("content") or "")
            break
    return (
        f"【演示模式】已收到你的消息：“{last_user}”。\n"
        "当前上游不可达，网关已自动降级为本地模拟回复。"
        "连接真实上游后即可获得真实模型回答。"
    )


async def demo_chat_stream(messages: list[dict[str, Any]]) -> AsyncIterator[bytes]:
    """产出模拟对话的 SSE 数据流（OpenAI 风格块 + demo:true）。"""
    reply = demo_chat_reply(messages)
    for chunk in _split(reply, 8):
        yield openai_chunk(chunk, demo=True)
    yield openai_chunk("", demo=True, finish=True)
    yield sse_line({"demo": True, "done": True})
    yield b"data: [DONE]\n\n"


def demo_chat_completion(messages: list[dict[str, Any]]) -> dict[str, Any]:
    """非流式模拟回复。"""
    return {
        "demo": True,
        "object": "chat.completion",
        "choices": [
            {"index": 0, "message": {"role": "assistant", "content": demo_chat_reply(messages)}}
        ],
    }


def _split(text: str, size: int) -> list[str]:
    """把文本切分为若干片段（模拟逐字输出）。"""
    return [text[i : i + size] for i in range(0, len(text), size)] or [text]
