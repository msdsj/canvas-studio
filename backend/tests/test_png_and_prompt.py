"""回归测试：模型输出校验 + 上传内置提示词配置。"""
from __future__ import annotations

import io

import pytest
from PIL import Image

from app.services.generate_service import _model_image_details
from tests.conftest import register_and_activate


def _jpeg_bytes(size=(48, 32), color=(200, 40, 40)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="JPEG", quality=90)
    return buf.getvalue()


def _png_bytes(size=(24, 24), color=(10, 120, 220)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


class TestModelImageDetails:
    """验证模型图片格式而不重编码模型像素。"""

    def test_jpeg_keeps_its_original_format(self):
        raw = _jpeg_bytes()
        assert _model_image_details(raw) == ("jpg", "image/jpeg")
        with Image.open(io.BytesIO(raw)) as img:
            assert img.format == "JPEG"
            assert img.size == (48, 32)

    def test_png_is_supported_without_reencoding(self):
        raw = _png_bytes()
        assert _model_image_details(raw) == ("png", "image/png")

    def test_invalid_bytes_are_rejected(self):
        raw = b"not-an-image"
        assert _model_image_details(raw) is None

    def test_transparent_png_is_supported(self):
        buf = io.BytesIO()
        Image.new("RGBA", (16, 16), (0, 0, 0, 0)).save(buf, format="PNG")
        assert _model_image_details(buf.getvalue()) == ("png", "image/png")
        with Image.open(io.BytesIO(buf.getvalue())) as img:
            assert img.mode == "RGBA"


@pytest.mark.asyncio
class TestPromptPresets:
    """上传/编辑流程的内置提示词配置接口。"""

    async def test_requires_auth(self, client):
        resp = await client.get("/api/assets/prompt-presets")
        assert resp.status_code == 401

    async def test_returns_template_and_presets(self, client):
        token = await register_and_activate(client, "preset@example.com")
        resp = await client.get(
            "/api/assets/prompt-presets", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()["data"]
        assert isinstance(data["template"], str) and data["template"]
        assert isinstance(data["presets"], list) and len(data["presets"]) >= 3
        first = data["presets"][0]
        assert {"id", "label", "prompt"} <= set(first)

    async def test_route_not_shadowed_by_asset_id(self, client):
        """`/prompt-presets` 不能被 `/{asset_id}` 吞掉（应返回预设而非 404）。"""
        token = await register_and_activate(client, "preset2@example.com")
        resp = await client.get(
            "/api/assets/prompt-presets", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status_code == 200
        assert "presets" in resp.json()["data"]


@pytest.mark.asyncio
class TestUploadWithPrompt:
    """上传流程内置提示词随资产保存。"""

    async def test_upload_stores_prompt(self, client):
        token = await register_and_activate(client, "upload@example.com")
        headers = {"Authorization": f"Bearer {token}"}
        files = {"file": ("photo.jpg", _jpeg_bytes(), "image/jpeg")}
        resp = await client.post(
            "/api/assets/upload",
            headers=headers,
            files=files,
            data={"prompt": "把背景换成纯白色"},
        )
        assert resp.status_code == 200, resp.text
        asset = resp.json()["data"]
        assert asset["kind"] == "uploaded"
        assert asset["source_prompt"] == "把背景换成纯白色"

    async def test_upload_without_prompt(self, client):
        token = await register_and_activate(client, "upload2@example.com")
        headers = {"Authorization": f"Bearer {token}"}
        files = {"file": ("photo.png", _png_bytes(), "image/png")}
        resp = await client.post("/api/assets/upload", headers=headers, files=files)
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["source_prompt"] == ""

    async def test_upload_rejects_non_image(self, client):
        token = await register_and_activate(client, "upload3@example.com")
        headers = {"Authorization": f"Bearer {token}"}
        files = {"file": ("note.txt", b"hello", "text/plain")}
        resp = await client.post("/api/assets/upload", headers=headers, files=files)
        # 平台 VALIDATION_ERROR 统一映射 422
        assert resp.status_code == 422
        assert resp.json()["code"] == "VALIDATION_ERROR"
