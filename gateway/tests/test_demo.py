"""Demo 降级单测：占位图 + 模拟对话 + auto 降级。"""
from __future__ import annotations

import base64
import io

from PIL import Image

from app.state import runtime_config


def _restore(demo_mode: str, sub2api: str, cg2: str) -> None:
    """恢复运行时配置。"""
    runtime_config.demo_mode = demo_mode
    runtime_config.sub2api_base_url = sub2api
    runtime_config.chatgpt2api_base_url = cg2


async def test_demo_mode_on_image(client, headers):
    """demo=on 时返回占位图（b64 为合法 PNG）。"""
    saved = (
        runtime_config.demo_mode,
        runtime_config.sub2api_base_url,
        runtime_config.chatgpt2api_base_url,
    )
    runtime_config.demo_mode = "on"
    try:
        resp = await client.post(
            "/gw/images/generations",
            headers=headers,
            json={"prompt": "一只赛博朋克猫", "size": "256x256", "n": 1},
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["demo"] is True
        raw = base64.b64decode(data["data"][0]["b64_json"])
        with Image.open(io.BytesIO(raw)) as img:
            assert img.size == (256, 256)
    finally:
        _restore(*saved)


async def test_demo_mode_on_chat(client, headers):
    """demo=on 时对话返回模拟回复（SSE 含 demo 标记）。"""
    saved = (
        runtime_config.demo_mode,
        runtime_config.sub2api_base_url,
        runtime_config.chatgpt2api_base_url,
    )
    runtime_config.demo_mode = "on"
    try:
        resp = await client.post(
            "/gw/chat/completions",
            headers=headers,
            json={"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "你好"}], "stream": True},
        )
        assert resp.status_code == 200
        body = resp.text
        assert "demo" in body
        assert "演示模式" in body
    finally:
        _restore(*saved)


async def test_demo_auto_fallback_when_unreachable(client, headers):
    """demo=auto 且上游不可达时自动降级为占位图。"""
    saved = (
        runtime_config.demo_mode,
        runtime_config.sub2api_base_url,
        runtime_config.chatgpt2api_base_url,
    )
    runtime_config.demo_mode = "auto"
    runtime_config.chatgpt2api_base_url = "http://127.0.0.1:9"
    try:
        resp = await client.post(
            "/gw/images/generations",
            headers=headers,
            json={"prompt": "降级测试", "size": "128x128", "n": 1},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["demo"] is True
    finally:
        _restore(*saved)


async def test_gw_health(client, headers):
    """网关存活返回 demo_mode。"""
    resp = await client.get("/gw/health", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["data"]["demo_mode"] in {"auto", "on", "off"}
