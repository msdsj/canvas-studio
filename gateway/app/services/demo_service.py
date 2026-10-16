"""Demo 降级服务：Pillow 占位图 + 模拟对话。"""
from __future__ import annotations

import base64
import io
import textwrap
from collections.abc import AsyncIterator
from typing import Any

from PIL import Image, ImageDraw

from app.utils.streaming import openai_chunk, sse_line


def parse_size(size: str, default: tuple[int, int] = (1024, 1024)) -> tuple[int, int]:
    """解析 "1024x1024" 尺寸。"""
    try:
        w, h = str(size).lower().replace(" ", "").split("x")
        return max(64, int(w)), max(64, int(h))
    except (ValueError, AttributeError):
        return default


def placeholder_png(prompt: str, size: str = "1024x1024") -> bytes:
    """用 Pillow 生成带 prompt 文字与 DEMO 水印的占位 PNG。"""
    width, height = parse_size(size)
    img = Image.new("RGB", (width, height), color=(245, 247, 250))
    draw = ImageDraw.Draw(img)
    # 边框
    draw.rectangle([8, 8, width - 8, height - 8], outline=(120, 130, 145), width=3)
    # 标题
    draw.text((24, 20), "CANVAS STUDIO · DEMO", fill=(200, 60, 60))
    # prompt 文字（自动换行）
    wrapped = textwrap.wrap(prompt or "（无提示词）", width=max(20, width // 12))
    y = 60
    for line in wrapped[:20]:
        draw.text((24, y), line, fill=(30, 34, 40))
        y += 22
    # 大水印
    draw.text((24, height - 40), "DEMO PLACEHOLDER", fill=(180, 190, 200))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def placeholder_b64(prompt: str, size: str = "1024x1024") -> str:
    """占位图 base64。"""
    return base64.b64encode(placeholder_png(prompt, size)).decode()


def demo_image_result(prompt: str, size: str, n: int = 1) -> dict[str, Any]:
    """构造 Demo 生图响应（OpenAI 风格 + demo 标记）。"""
    return {
        "created": 0,
        "demo": True,
        "data": [{"b64_json": placeholder_b64(prompt, size)} for _ in range(max(1, n))],
    }


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
