"""Demo 降级服务：Pillow 占位图 + 模拟对话。"""
from __future__ import annotations

import base64
import io
from collections.abc import AsyncIterator
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from app.utils.streaming import openai_chunk, sse_line

# 各平台常见的中文字体，按优先级尝试。
# Pillow 的默认位图字体只有 ASCII，直接画中文会得到一排「豆腐块」（▯▯▯）。
_FONT_CANDIDATES = (
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Linux
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    # Windows
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
)


@lru_cache(maxsize=8)
def _load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """加载支持中文的系统字体；都找不到时退回默认字体（英文仍可读）。"""
    for candidate in _FONT_CANDIDATES:
        try:
            if Path(candidate).exists():
                return ImageFont.truetype(candidate, size)
        except Exception:  # noqa: BLE001 - 字体损坏时继续尝试下一个
            continue
    return ImageFont.load_default()


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

    # 字号随画布尺寸缩放，小图上也不会挤成一团
    title_font = _load_font(max(18, width // 42))
    body_font = _load_font(max(14, width // 62))
    watermark_font = _load_font(max(12, width // 76))

    # 边框
    draw.rectangle([8, 8, width - 8, height - 8], outline=(120, 130, 145), width=3)
    # 标题
    draw.text((24, 18), "CANVAS STUDIO · DEMO", fill=(200, 60, 60), font=title_font)

    # prompt 文字：按实际字宽换行（中英文混排也准确）
    body = prompt or "（无提示词）"
    line_height = int(getattr(body_font, "size", 16) * 1.5)
    max_width = width - 48
    lines: list[str] = []
    current = ""
    for char in body:
        if char == "\n":
            lines.append(current)
            current = ""
            continue
        trial = current + char
        try:
            too_wide = draw.textlength(trial, font=body_font) > max_width
        except Exception:  # noqa: BLE001 - 极老版本 Pillow 无 textlength
            too_wide = len(trial) > max(20, width // 12)
        if too_wide and current:
            lines.append(current)
            current = char
        else:
            current = trial
    if current:
        lines.append(current)

    y = 60
    for line in lines[:24]:
        if y > height - 70:
            break
        draw.text((24, y), line, fill=(30, 34, 40), font=body_font)
        y += line_height

    # 水印
    draw.text(
        (24, height - 46),
        "DEMO PLACEHOLDER",
        fill=(180, 190, 200),
        font=watermark_font,
    )
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
