"""生图 / 编辑转发（含 b64↔文件、多图）与 Demo 降级。"""
from __future__ import annotations

import base64
import httpx

from app.services import demo_service
from app.services.error_mapper import classify_exception, classify_status
from app.state import runtime_config
from app.upstream import chatgpt2api_client, chatgpt2api_headers
from app.utils.errors import ErrorCode, GatewayError

import logging

logger = logging.getLogger(__name__)

_FALLBACK_CODES = {
    ErrorCode.PROXY_UNREACHABLE,
    ErrorCode.UPSTREAM_ERROR,
    ErrorCode.POOL_UNAVAILABLE,
}


async def _to_b64(client: httpx.AsyncClient, item: dict) -> str | None:
    """把上游返回项归一为 b64_json。"""
    if item.get("b64_json"):
        return item["b64_json"]
    url = item.get("url")
    if url:
        try:
            resp = await client.get(url)
            if resp.status_code < 400:
                return base64.b64encode(resp.content).decode()
        except httpx.HTTPError:
            return None
    return None


def _normalize(data: dict, images: list[str]) -> dict:
    """构造网关统一生图结果。"""
    return {
        "created": data.get("created", 0),
        "demo": False,
        "data": [{"b64_json": b64} for b64 in images if b64],
    }


async def image_generations(payload: dict) -> dict:
    """文生图转发（demo 时返回占位图）。"""
    prompt = str(payload.get("prompt") or "")
    size = str(payload.get("size") or "1024x1024")
    n = int(payload.get("n") or 1)
    mode = runtime_config.demo_mode

    if mode == "on":
        return demo_service.demo_image_result(prompt, size, n)

    body = {
        "prompt": prompt,
        "model": payload.get("model", "gpt-image-2"),
        "n": n,
        "size": size,
        "quality": payload.get("quality", "standard"),
    }
    try:
        async with chatgpt2api_client() as client:
            resp = await client.post(
                "/v1/images/generations", headers=chatgpt2api_headers(), json=body
            )
            if resp.status_code >= 400:
                raise classify_status(resp.status_code, resp.text)
            data = resp.json()
            images: list[str] = []
            for item in data.get("data", []):
                b64 = await _to_b64(client, item)
                if b64:
                    images.append(b64)
        if not images:
            raise GatewayError(ErrorCode.UPSTREAM_ERROR, "上游未返回图片")
        return _normalize(data, images)
    except GatewayError as exc:
        logger.warning("生图上游失败（demo 回退前）: %s %s", exc.code, exc)
        if mode == "auto":
            return demo_service.demo_image_result(prompt, size, n)
        raise
    except Exception as exc:  # noqa: BLE001
        mapped = classify_exception(exc)
        logger.warning("生图上游异常（demo 回退前）: %s -> %s", exc, mapped.code)
        if mode == "auto" and mapped.code in _FALLBACK_CODES:
            return demo_service.demo_image_result(prompt, size, n)
        raise mapped


async def image_edits(
    files: list[tuple[str, tuple[str, bytes, str]]], form: dict
) -> dict:
    """图生图/编辑转发（demo 时返回占位图）。"""
    prompt = str(form.get("prompt") or "")
    size = str(form.get("size") or "1024x1024")
    mode = runtime_config.demo_mode

    if mode == "on":
        return demo_service.demo_image_result(prompt, size, 1)

    data = {
        "prompt": prompt,
        "model": form.get("model", "gpt-image-2"),
        "size": size,
    }
    try:
        async with chatgpt2api_client() as client:
            resp = await client.post(
                "/v1/images/edits",
                headers=chatgpt2api_headers(),
                data=data,
                files=files,
            )
            if resp.status_code >= 400:
                raise classify_status(resp.status_code, resp.text)
            result = resp.json()
            images: list[str] = []
            for item in result.get("data", []):
                b64 = await _to_b64(client, item)
                if b64:
                    images.append(b64)
        if not images:
            raise GatewayError(ErrorCode.UPSTREAM_ERROR, "上游未返回图片")
        return _normalize(result, images)
    except GatewayError:
        if mode == "auto":
            return demo_service.demo_image_result(prompt, size, 1)
        raise
    except Exception as exc:  # noqa: BLE001
        mapped = classify_exception(exc)
        if mode == "auto" and mapped.code in _FALLBACK_CODES:
            return demo_service.demo_image_result(prompt, size, 1)
        raise mapped
