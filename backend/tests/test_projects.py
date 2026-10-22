"""项目 / 画布 / 资产单测。"""
from __future__ import annotations

import io

from tests.conftest import register_and_activate


async def test_project_create_default_canvas(client, auth_headers_factory):
    """新建项目自动创建默认画布。"""
    token = await register_and_activate(client, "p1@example.com")
    headers = auth_headers_factory(token)

    resp = await client.post("/api/projects", json={"name": "我的项目"}, headers=headers)
    assert resp.status_code == 200
    project = resp.json()["data"]

    detail = await client.get(f"/api/projects/{project['id']}", headers=headers)
    assert detail.status_code == 200
    canvases = detail.json()["data"]["canvases"]
    assert len(canvases) == 1

    listing = await client.get("/api/projects", headers=headers)
    assert listing.json()["data"]["total"] == 1


async def test_project_cross_user_forbidden(client, auth_headers_factory):
    """越权访问他人项目 403。"""
    owner = await register_and_activate(client, "p2@example.com")
    other = await register_and_activate(client, "p3@example.com")
    resp = await client.post(
        "/api/projects", json={"name": "私有"}, headers=auth_headers_factory(owner)
    )
    pid = resp.json()["data"]["id"]

    forbidden = await client.get(f"/api/projects/{pid}", headers=auth_headers_factory(other))
    assert forbidden.status_code == 403


async def test_canvas_autosave_and_share(client, auth_headers_factory):
    """画布自动保存、分享 token 与只读访问。"""
    token = await register_and_activate(client, "p4@example.com")
    headers = auth_headers_factory(token)
    resp = await client.post("/api/projects", json={"name": "画布项目"}, headers=headers)
    pid = resp.json()["data"]["id"]
    detail = await client.get(f"/api/projects/{pid}", headers=headers)
    canvas_id = detail.json()["data"]["canvases"][0]["id"]

    state = {"elements": [{"id": "e1", "type": "rectangle"}], "appState": {}, "files": {}}
    save = await client.patch(
        f"/api/canvases/{canvas_id}", json={"state": state}, headers=headers
    )
    assert save.status_code == 200
    assert save.json()["data"]["updated_at"]

    share = await client.post(f"/api/canvases/{canvas_id}/share", headers=headers)
    assert share.status_code == 200
    share_token = share.json()["data"]["share_token"]

    public = await client.get(f"/api/share/{share_token}")
    assert public.status_code == 200
    assert public.json()["data"]["id"] == canvas_id


async def test_canvas_export_json(client, auth_headers_factory):
    """导出 json。"""
    token = await register_and_activate(client, "p5@example.com")
    headers = auth_headers_factory(token)
    resp = await client.post("/api/projects", json={"name": "导出"}, headers=headers)
    pid = resp.json()["data"]["id"]
    detail = await client.get(f"/api/projects/{pid}", headers=headers)
    canvas_id = detail.json()["data"]["canvases"][0]["id"]

    exp = await client.get(f"/api/canvases/{canvas_id}/export?format=json", headers=headers)
    assert exp.status_code == 200
    assert "application/json" in exp.headers["content-type"]


async def test_canvas_png_export_does_not_return_generated_placeholder(client, auth_headers_factory):
    """没有已保存缩略图时，不得伪造本地 PNG 导出结果。"""
    token = await register_and_activate(client, "p5-png@example.com")
    headers = auth_headers_factory(token)
    resp = await client.post("/api/projects", json={"name": "PNG 导出"}, headers=headers)
    pid = resp.json()["data"]["id"]
    detail = await client.get(f"/api/projects/{pid}", headers=headers)
    canvas_id = detail.json()["data"]["canvases"][0]["id"]

    exp = await client.get(f"/api/canvases/{canvas_id}/export?format=png", headers=headers)
    assert exp.status_code == 422
    assert "暂无可导出的图片预览" in exp.json()["message"]


async def test_asset_upload_and_list(client, auth_headers_factory):
    """上传图片入资产库并可查询。"""
    token = await register_and_activate(client, "p6@example.com")
    headers = auth_headers_factory(token)

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (32, 32), color=(255, 0, 0)).save(buf, format="PNG")
    files = {"file": ("test.png", buf.getvalue(), "image/png")}
    up = await client.post("/api/assets/upload", files=files, headers=headers)
    assert up.status_code == 200, up.text
    asset = up.json()["data"]
    assert asset["kind"] == "uploaded"

    listing = await client.get("/api/assets", headers=headers)
    assert listing.json()["data"]["total"] == 1
