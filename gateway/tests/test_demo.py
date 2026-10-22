"""Demo 对话与真实图片 provider 路由测试。"""
from __future__ import annotations

import base64
import io

import httpx
from PIL import Image

from app.state import runtime_config


def _restore(demo_mode: str, sub2api: str, cg2: str) -> None:
    """恢复运行时配置。"""
    runtime_config.demo_mode = demo_mode
    runtime_config.text_base_url = sub2api
    runtime_config.image_base_url = cg2


async def test_demo_mode_on_image_still_calls_provider(client, headers, mock_upstream):
    """图像任务始终请求真实 provider，即使文本 Demo 模式打开。"""
    saved = (
        runtime_config.demo_mode,
        runtime_config.text_base_url,
        runtime_config.image_base_url,
    )
    runtime_config.demo_mode = "on"
    image = Image.new("RGB", (12, 12), color=(90, 90, 200))
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    expected = base64.b64encode(buf.getvalue()).decode()
    requests = []

    def handler(request):
        requests.append(request.url.path)
        return httpx.Response(
            200, json={"created": 1, "data": [{"b64_json": expected}]}
        )

    mock_upstream(handler)
    try:
        resp = await client.post(
            "/gw/images/generations",
            headers=headers,
            json={"prompt": "一只赛博朋克猫", "size": "256x256", "n": 1},
        )
        assert resp.status_code == 200
        data = resp.json()["data"]
        assert data["demo"] is False
        raw = base64.b64decode(data["data"][0]["b64_json"])
        with Image.open(io.BytesIO(raw)) as img:
            assert img.size == (12, 12)
        assert requests == ["/images/generations"]
    finally:
        _restore(*saved)


async def test_demo_mode_on_image_edit_still_calls_provider(client, headers, mock_upstream):
    """Image edits use the configured provider while Demo mode is enabled."""
    saved = (
        runtime_config.demo_mode,
        runtime_config.text_base_url,
        runtime_config.image_base_url,
    )
    runtime_config.demo_mode = "on"
    expected = base64.b64encode(b"provider-result").decode()
    requests = []

    def handler(request):
        requests.append(request.url.path)
        assert request.headers.get("content-type", "").startswith("multipart/form-data")
        return httpx.Response(
            200, json={"created": 1, "data": [{"b64_json": expected}]}
        )

    mock_upstream(handler)
    try:
        resp = await client.post(
            "/gw/images/edits",
            headers=headers,
            data={"prompt": "remove the background", "background": "transparent"},
            files={"image": ("base.png", b"source", "image/png")},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["demo"] is False
        assert resp.json()["data"]["data"][0]["b64_json"] == expected
        assert requests == ["/images/edits"]
    finally:
        _restore(*saved)


async def test_demo_mode_on_chat(client, headers):
    """demo=on 时对话返回模拟回复（SSE 含 demo 标记）。"""
    saved = (
        runtime_config.demo_mode,
        runtime_config.text_base_url,
        runtime_config.image_base_url,
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


async def test_demo_auto_does_not_fallback_to_placeholder_when_image_provider_unreachable(client, headers):
    """图像 provider 不可达时失败，不得生成本地占位图。"""
    saved = (
        runtime_config.demo_mode,
        runtime_config.text_base_url,
        runtime_config.image_base_url,
    )
    runtime_config.demo_mode = "auto"
    runtime_config.image_base_url = "http://127.0.0.1:9"
    try:
        resp = await client.post(
            "/gw/images/generations",
            headers=headers,
            json={"prompt": "降级测试", "size": "128x128", "n": 1},
        )
        assert resp.status_code >= 400
        assert resp.json()["data"] is None
    finally:
        _restore(*saved)


async def test_gw_health(client, headers):
    """网关存活返回 demo_mode。"""
    resp = await client.get("/gw/health", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["data"]["demo_mode"] in {"auto", "on", "off"}
