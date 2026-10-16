"""QA 独立测试 · 边界与异常路径（HTTP API 契约层）。

覆盖：
- 未登录访问受保护接口 → 401
- 越权访问他人画布/任务/资产 → 403
- 不存在的资源 → 404
- 参数校验：无效邮箱登录 / 上传非法类型 / 空文件 / 超大文件 → 422
- 任务进度 SSE（刷新续接的进度来源）
"""
from __future__ import annotations

import base64
import io

from PIL import Image

from app.config import settings
from tests.conftest import register_and_activate


def _png_bytes(size: int = 16) -> bytes:
    """生成 PNG 字节。"""
    buf = io.BytesIO()
    Image.new("RGB", (size, size), color=(30, 200, 120)).save(buf, format="PNG")
    return buf.getvalue()


async def _headers(client, email: str) -> dict[str, str]:
    """注册并激活，返回鉴权头。"""
    token = await register_and_activate(client, email)
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------------------
# 鉴权：未登录
# --------------------------------------------------------------------------
async def test_qa_protected_endpoints_require_auth(client):
    """未携带 token 访问受保护接口 → 401 UNAUTHORIZED。"""
    for path in ("/api/me", "/api/me/quota", "/api/tasks/active", "/api/projects"):
        resp = await client.get(path)
        assert resp.status_code == 401, f"{path} 应 401，实际 {resp.status_code}"
        assert resp.json()["code"] == "UNAUTHORIZED"


# --------------------------------------------------------------------------
# 越权访问
# --------------------------------------------------------------------------
async def test_qa_cross_user_canvas_forbidden(client):
    """用户 B 访问用户 A 的画布 → 403（§5.3）。"""
    headers_a = await _headers(client, "qa-owner@example.com")
    headers_b = await _headers(client, "qa-intruder@example.com")

    proj = await client.post("/api/projects", json={"name": "A 的项目"}, headers=headers_a)
    pid = proj.json()["data"]["id"]
    detail = await client.get(f"/api/projects/{pid}", headers=headers_a)
    canvas_id = detail.json()["data"]["canvases"][0]["id"]

    read = await client.get(f"/api/canvases/{canvas_id}", headers=headers_b)
    assert read.status_code == 403
    assert read.json()["code"] == "FORBIDDEN"

    write = await client.patch(
        f"/api/canvases/{canvas_id}", json={"name": "篡改"}, headers=headers_b
    )
    assert write.status_code == 403


async def test_qa_cross_user_task_forbidden(client, monkeypatch):
    """用户 B 访问用户 A 的任务 → 403。"""

    async def _noop(task_id: str) -> None:  # noqa: ARG001
        return None

    monkeypatch.setattr("app.services.generate_service.run_task", _noop)

    headers_a = await _headers(client, "qa-task-owner@example.com")
    headers_b = await _headers(client, "qa-task-intruder@example.com")
    created = await client.post(
        "/api/generate/image", json={"prompt": "私有任务"}, headers=headers_a
    )
    tid = created.json()["data"]["id"]

    resp = await client.get(f"/api/generate/tasks/{tid}", headers=headers_b)
    assert resp.status_code == 403
    assert resp.json()["code"] == "FORBIDDEN"


async def test_qa_cross_user_asset_forbidden(client):
    """用户 B 访问用户 A 的资产 → 403。"""
    headers_a = await _headers(client, "qa-asset-owner@example.com")
    headers_b = await _headers(client, "qa-asset-intruder@example.com")

    files = {"file": ("a.png", _png_bytes(), "image/png")}
    up = await client.post("/api/assets/upload", files=files, headers=headers_a)
    asset_id = up.json()["data"]["id"]

    resp = await client.get(f"/api/assets/{asset_id}", headers=headers_b)
    assert resp.status_code == 403


# --------------------------------------------------------------------------
# 不存在资源
# --------------------------------------------------------------------------
async def test_qa_task_not_found_404(client):
    """不存在的任务 → 404 TASK_NOT_FOUND。"""
    headers = await _headers(client, "qa-404@example.com")
    resp = await client.get("/api/generate/tasks/does-not-exist", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["code"] == "TASK_NOT_FOUND"


async def test_qa_project_not_found_404(client):
    """不存在的项目 → 404。"""
    headers = await _headers(client, "qa-proj-404@example.com")
    resp = await client.get("/api/projects/nope-nope", headers=headers)
    assert resp.status_code == 404
    assert resp.json()["code"] == "NOT_FOUND"


# --------------------------------------------------------------------------
# 参数校验
# --------------------------------------------------------------------------
async def test_qa_login_invalid_email_format_422(client):
    """登录传入非法邮箱格式 → 422 VALIDATION_ERROR。"""
    resp = await client.post("/api/auth/login", json={"email": "bad", "password": "x12345678"})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_qa_upload_invalid_mime_422(client):
    """上传非图片类型 → 422（§5.5）。"""
    headers = await _headers(client, "qa-mime@example.com")
    files = {"file": ("evil.txt", b"not an image", "text/plain")}
    resp = await client.post("/api/assets/upload", files=files, headers=headers)
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_qa_upload_empty_file_422(client):
    """上传空文件 → 422。"""
    headers = await _headers(client, "qa-empty@example.com")
    files = {"file": ("empty.png", b"", "image/png")}
    resp = await client.post("/api/assets/upload", files=files, headers=headers)
    assert resp.status_code == 422


async def test_qa_upload_oversize_422(client, monkeypatch):
    """超过大小上限 → 422（§5.5，临时把上限压到 1MB 验证）。"""
    monkeypatch.setattr(settings, "max_upload_mb", 1)
    headers = await _headers(client, "qa-oversize@example.com")
    big = _png_bytes(16) + b"\x00" * (1024 * 1024 + 1024)  # ≈1MB+
    files = {"file": ("big.png", big, "image/png")}
    resp = await client.post("/api/assets/upload", files=files, headers=headers)
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


# --------------------------------------------------------------------------
# 进度 SSE（刷新续接进度来源）
# --------------------------------------------------------------------------
async def test_qa_task_stream_terminal_done(client, monkeypatch):
    """终态任务的 SSE 立即返回 done 帧（P0-30 进度来源）。"""

    async def fake_generations(payload):
        buf = io.BytesIO()
        Image.new("RGB", (8, 8), color=(1, 2, 3)).save(buf, format="PNG")
        return {"data": [{"b64_json": base64.b64encode(buf.getvalue()).decode()}], "demo": False}

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.image_generations", fake_generations
    )
    headers = await _headers(client, "qa-stream@example.com")
    created = await client.post("/api/generate/image", json={"prompt": "sse"}, headers=headers)
    tid = created.json()["data"]["id"]

    async with client.stream("GET", f"/api/generate/tasks/{tid}/stream", headers=headers) as resp:
        assert resp.status_code == 200
        body = ""
        async for text in resp.aiter_text():
            body += text
    assert "succeeded" in body
    assert '"done": true' in body or '"done":true' in body
