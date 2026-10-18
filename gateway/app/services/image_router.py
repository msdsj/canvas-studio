"""生图 / 编辑转发（含 b64↔文件、多图）与 Demo 降级。"""
from __future__ import annotations

import base64
import httpx

from app.services import demo_service
from app.services.error_mapper import classify_exception, classify_status
from app.state import runtime_config
from app.services.account_pool import account_pool
from app.upstream import provider_client, provider_headers
from app.utils.errors import ErrorCode, GatewayError

import logging

logger = logging.getLogger(__name__)


async def _to_b64(client: httpx.AsyncClient, item: dict) -> str | None:
    """把上游返回项归一为 b64_json。"""
    if not isinstance(item, dict):
        return None
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
    """Call the configured image provider, optionally using a local pool key."""
    prompt = str(payload.get("prompt") or "")
    size = str(payload.get("size") or "1024x1024")
    n = int(payload.get("n") or 1)
    mode = runtime_config.demo_mode

    if mode == "on":
        return demo_service.demo_image_result(prompt, size, n)

    body = {
        "prompt": prompt,
        "model": runtime_config.image_model or payload.get("model") or "gpt-image-2",
        "n": n,
        "size": size,
        "quality": payload.get("quality", "standard"),
    }
    account = await account_pool.select(kind="image")
    base_url = (account or {}).get("base_url") or None
    api_key = (account or {}).get("access_token") or None
    try:
        async with provider_client("image", base_url=base_url) as client:
            resp = await client.post(
                "/images/generations", headers=provider_headers("image", api_key), json=body
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
        if account:
            await account_pool.mark_success(account["id"])
        return _normalize(data, images)
    except GatewayError as exc:
        if account:
            await account_pool.mark_failure(account["id"], exc.message, retryable=exc.code != ErrorCode.POOL_UNAVAILABLE)
        logger.warning("生图上游失败: %s %s", exc.code, exc)
        # 只有「上游根本连不上」才降级成演示占位图。
        # 号池无额度 / 鉴权失败 / 限流 / 5xx 必须如实失败：
        # 把「没额度」伪装成「画好了」，用户会以为产品在乱画，且白扣一次额度。
        if mode == "auto" and exc.code == ErrorCode.PROXY_UNREACHABLE:
            return demo_service.demo_image_result(prompt, size, n)
        raise
    except Exception as exc:  # noqa: BLE001
        mapped = classify_exception(exc)
        if account:
            await account_pool.mark_failure(account["id"], mapped.message, retryable=True)
        logger.warning("生图上游异常: %s -> %s", exc, mapped.code)
        if mode == "auto" and mapped.code == ErrorCode.PROXY_UNREACHABLE:
            return demo_service.demo_image_result(prompt, size, n)
        raise mapped
    finally:
        if account:
            await account_pool.release(account["id"])


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
        "model": runtime_config.image_model or form.get("model") or "gpt-image-2",
        "size": size,
        "quality": form.get("quality", "standard"),
        "n": max(1, min(int(form.get("n") or 1), 4)),
        "response_format": form.get("response_format", "b64_json"),
    }

    # 日志：记录实际转发的文件清单（调试多图转发问题）
    file_summary = []
    for field_name, (filename, content, mime) in files:
        file_summary.append(f"{field_name}={filename}({len(content)} bytes, {mime})")
    logger.info("图片编辑转发: %d 个文件 [%s]", len(files), ", ".join(file_summary))

    account = await account_pool.select(kind="image")
    base_url = (account or {}).get("base_url") or None
    api_key = (account or {}).get("access_token") or None
    try:
        async with provider_client("image", base_url=base_url) as client:
            resp = await client.post(
                "/images/edits",
                headers=provider_headers("image", api_key),
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
        if account:
            await account_pool.mark_success(account["id"])
        return _normalize(result, images)
    except GatewayError as exc:
        if account:
            await account_pool.mark_failure(account["id"], exc.message, retryable=exc.code != ErrorCode.POOL_UNAVAILABLE)
        logger.warning("图片编辑上游失败: %s %s", exc.code, exc)
        # 同生图：只有连不上上游才降级，业务错误如实失败
        if mode == "auto" and exc.code == ErrorCode.PROXY_UNREACHABLE:
            return demo_service.demo_image_result(prompt, size, 1)
        raise
    except Exception as exc:  # noqa: BLE001
        mapped = classify_exception(exc)
        if account:
            await account_pool.mark_failure(account["id"], mapped.message, retryable=True)
        logger.warning("图片编辑上游异常: %s -> %s", exc, mapped.code)
        if mode == "auto" and mapped.code == ErrorCode.PROXY_UNREACHABLE:
            return demo_service.demo_image_result(prompt, size, 1)
        raise mapped
    finally:
        if account:
            await account_pool.release(account["id"])
