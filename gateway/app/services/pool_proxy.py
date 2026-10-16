"""号池管理接口代理（chatgpt2api `/api/accounts*`）+ 进度透传。"""
from __future__ import annotations

from typing import Any

import httpx

from app.services.error_mapper import classify_exception, classify_status
from app.upstream import chatgpt2api_client, chatgpt2api_headers


async def _json_request(method: str, path: str, json_body: dict | None = None) -> Any:
    """执行 JSON 请求并归一错误。"""
    client = chatgpt2api_client()
    try:
        resp = await client.request(
            method, path, headers=chatgpt2api_headers(), json=json_body
        )
    except httpx.HTTPError as exc:
        raise classify_exception(exc) from exc
    finally:
        await client.aclose()
    if resp.status_code >= 400:
        raise classify_status(resp.status_code, resp.text)
    try:
        return resp.json()
    except ValueError:
        return {}


async def list_accounts() -> dict[str, Any]:
    """列出账号。"""
    return await _json_request("GET", "/api/accounts")


async def import_accounts(tokens: list[str], accounts: list[dict]) -> dict[str, Any]:
    """导入账号。"""
    return await _json_request(
        "POST", "/api/accounts", {"tokens": tokens, "accounts": accounts}
    )


async def delete_accounts(tokens: list[str]) -> dict[str, Any]:
    """删除账号。"""
    return await _json_request("DELETE", "/api/accounts", {"tokens": tokens})


async def refresh(tokens: list[str]) -> dict[str, Any]:
    """刷新额度 → 归一为 {job_id}。"""
    data = await _json_request(
        "POST", "/api/accounts/refresh", {"access_tokens": tokens}
    )
    return {"job_id": data.get("progress_id") or data.get("job_id")}


async def refresh_progress(job_id: str) -> dict[str, Any]:
    """刷新进度。"""
    return await _json_request("GET", f"/api/accounts/refresh/progress/{job_id}")


async def relogin(tokens: list[str]) -> dict[str, Any]:
    """重新登录 → 归一为 {job_id}。"""
    data = await _json_request(
        "POST", "/api/accounts/re-login", {"access_tokens": tokens}
    )
    return {"job_id": data.get("progress_id") or data.get("job_id")}


async def relogin_progress(job_id: str) -> dict[str, Any]:
    """重登进度。"""
    return await _json_request("GET", f"/api/accounts/re-login/progress/{job_id}")


async def update_account(payload: dict) -> dict[str, Any]:
    """更新账号。"""
    return await _json_request("POST", "/api/accounts/update", payload)


async def export_accounts(tokens: list[str], fmt: str) -> tuple[bytes, str, str]:
    """导出账号，返回 (content, media_type, content_disposition)。"""
    client = chatgpt2api_client()
    try:
        resp = await client.post(
            "/api/accounts/export",
            headers=chatgpt2api_headers(),
            json={"access_tokens": tokens, "format": fmt},
        )
    except httpx.HTTPError as exc:
        raise classify_exception(exc) from exc
    finally:
        await client.aclose()
    if resp.status_code >= 400:
        raise classify_status(resp.status_code, resp.text)
    return (
        resp.content,
        resp.headers.get("content-type", "application/json"),
        resp.headers.get("content-disposition", "attachment"),
    )


async def oauth_start(email_hint: str) -> dict[str, Any]:
    """OAuth 起始。"""
    return await _json_request(
        "POST", "/api/accounts/oauth/start", {"email_hint": email_hint}
    )


async def oauth_finish(session_id: str, callback: str) -> dict[str, Any]:
    """OAuth 完成。"""
    return await _json_request(
        "POST", "/api/accounts/oauth/finish", {"session_id": session_id, "callback": callback}
    )
