"""号池代理单测（mock 上游）。"""
from __future__ import annotations

import httpx


def _pool_handler(request: httpx.Request) -> httpx.Response:
    """模拟 chatgpt2api 号池接口。"""
    path = request.url.path
    if path == "/api/accounts" and request.method == "GET":
        return httpx.Response(200, json={"items": [{"access_token": "abcdef1234567890", "status": "正常"}]})
    if path == "/api/accounts" and request.method == "POST":
        return httpx.Response(200, json={"added": 1, "skipped": 0, "refreshed": 1, "errors": []})
    if path == "/api/accounts/refresh" and request.method == "POST":
        return httpx.Response(200, json={"progress_id": "job-123"})
    if path == "/api/accounts/refresh/progress/job-123":
        return httpx.Response(200, json={"done": 2, "total": 3, "status": "running"})
    return httpx.Response(404, json={"detail": "not found"})


async def test_requires_internal_token(client):
    """无令牌访问 /gw/* → 401 UNAUTHORIZED。"""
    resp = await client.get("/gw/pool/accounts")
    assert resp.status_code == 401
    assert resp.json()["code"] == "UNAUTHORIZED"


async def test_list_accounts(client, headers, mock_upstream):
    """列出账号（代理）。"""
    mock_upstream(_pool_handler)
    resp = await client.get("/gw/pool/accounts", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["code"] == "OK"
    assert len(resp.json()["data"]["items"]) == 1


async def test_import_accounts(client, headers, mock_upstream):
    """导入回执透传。"""
    mock_upstream(_pool_handler)
    resp = await client.post(
        "/gw/pool/accounts", headers=headers, json={"tokens": ["t1"], "accounts": []}
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["added"] == 1


async def test_refresh_maps_progress_id(client, headers, mock_upstream):
    """刷新：progress_id → job_id，进度可轮询。"""
    mock_upstream(_pool_handler)
    resp = await client.post(
        "/gw/pool/accounts/refresh", headers=headers, json={"tokens": []}
    )
    assert resp.status_code == 200
    job_id = resp.json()["data"]["job_id"]
    assert job_id == "job-123"

    prog = await client.get(f"/gw/pool/accounts/refresh/{job_id}", headers=headers)
    assert prog.json()["data"]["status"] == "running"


async def test_upstream_error_mapped(client, headers, mock_upstream):
    """上游 404 → UPSTREAM_ERROR。"""
    mock_upstream(lambda request: httpx.Response(404, json={"detail": "nope"}))
    resp = await client.get("/gw/pool/accounts", headers=headers)
    assert resp.status_code == 502
    assert resp.json()["code"] == "UPSTREAM_ERROR"
