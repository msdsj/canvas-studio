"""SSE / 流式工具。"""
from __future__ import annotations

import json
from typing import Any


def sse_line(payload: dict[str, Any]) -> bytes:
    """把数据块编码为 SSE 行（bytes）。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def sse_text(text: str) -> bytes:
    """原样编码 SSE 文本块。"""
    return text.encode("utf-8")


def openai_chunk(content: str, *, demo: bool = False, finish: bool = False) -> bytes:
    """构造 OpenAI 兼容的流式数据块。"""
    payload: dict[str, Any] = {
        "object": "chat.completion.chunk",
        "choices": [
            {
                "index": 0,
                "delta": {} if finish else {"content": content},
                "finish_reason": "stop" if finish else None,
            }
        ],
    }
    if demo:
        payload["demo"] = True
    return sse_line(payload)
