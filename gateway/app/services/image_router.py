"""生图 / 编辑转发（含 b64↔文件、多图）与 Demo 降级。

韧性：响应体格式异常（网页 / 空体 / 截断 / 非对象）先原地重试，再逐级切备用模型，
由 `resilience.run_with_fallback` 统一编排；全部失败就如实报错。
"""
from __future__ import annotations

import base64
import logging

import httpx

from app.services import demo_service
from app.services.account_pool import account_pool
from app.services.error_mapper import classify_exception, classify_status
from app.services.resilience import run_with_fallback
from app.state import runtime_config
from app.upstream import provider_client, provider_headers
from app.utils.errors import ErrorCode, GatewayError
from app.utils.upstream_json import parse_json_body

logger = logging.getLogger(__name__)

#: 只有「上游根本连不上」才降级成演示占位图。格式异常 / 号池无额度 / 鉴权失败 / 限流
#: 必须如实失败——把「没画出来」伪装成「画好了」，用户会以为产品在乱画，还白扣一次额度。
_DEMO_FALLBACK_CODES = {ErrorCode.PROXY_UNREACHABLE}


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


async def _generations_once(payload: dict, model: str, *, prompt: str, size: str, n: int) -> dict:
    """单次生图调用（一个模型 + 一个号池账号）。"""
    body = {
        "prompt": prompt,
        "model": model,
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
            data = parse_json_body(resp)
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
    except Exception as exc:  # noqa: BLE001 - 归一后交给上层决定重试 / 换模型
        error = exc if isinstance(exc, GatewayError) else classify_exception(exc)
        if account:
            await account_pool.mark_failure(
                account["id"],
                error.message,
                retryable=error.code != ErrorCode.POOL_UNAVAILABLE,
            )
        raise error
    finally:
        if account:
            await account_pool.release(account["id"])


async def image_generations(payload: dict) -> dict:
    """调用配置的生图 provider；模型链失败后才考虑演示降级。"""
    prompt = str(payload.get("prompt") or "")
    size = str(payload.get("size") or "1024x1024")
    n = int(payload.get("n") or 1)
    mode = runtime_config.demo_mode

    if mode == "on":
        return demo_service.demo_image_result(prompt, size, n)

    chain = runtime_config.model_chain("image") or [
        runtime_config.image_model or str(payload.get("model") or "gpt-image-2")
    ]
    try:
        return await run_with_fallback(
            chain,
            lambda model: _generations_once(payload, model, prompt=prompt, size=size, n=n),
        )
    except GatewayError as exc:
        logger.warning("生图上游失败: %s %s", exc.code, exc)
        if mode == "auto" and exc.code in _DEMO_FALLBACK_CODES:
            return demo_service.demo_image_result(prompt, size, n)
        raise


async def _edits_once(
    files: list[tuple[str, tuple[str, bytes, str]]], form: dict, model: str, *, prompt: str, size: str
) -> dict:
    """单次图生图 / 编辑调用（一个模型 + 一个号池账号）。"""
    data = {
        "prompt": prompt,
        "model": model,
        "size": size,
        "quality": form.get("quality", "standard"),
        "n": max(1, min(int(form.get("n") or 1), 4)),
        "response_format": form.get("response_format", "b64_json"),
    }

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
            result = parse_json_body(resp)
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
    except Exception as exc:  # noqa: BLE001 - 归一后交给上层决定重试 / 换模型
        error = exc if isinstance(exc, GatewayError) else classify_exception(exc)
        if account:
            await account_pool.mark_failure(
                account["id"],
                error.message,
                retryable=error.code != ErrorCode.POOL_UNAVAILABLE,
            )
        raise error
    finally:
        if account:
            await account_pool.release(account["id"])


async def image_edits(
    files: list[tuple[str, tuple[str, bytes, str]]], form: dict
) -> dict:
    """图生图 / 编辑转发；模型链失败后才考虑演示降级。"""
    prompt = str(form.get("prompt") or "")
    size = str(form.get("size") or "1024x1024")
    mode = runtime_config.demo_mode

    if mode == "on":
        return demo_service.demo_image_result(prompt, size, 1)

    # 日志：记录实际转发的文件清单（调试多图转发问题）。放在这里而不是单次调用里，
    # 免得重试时把同一份文件清单重复打 N 遍。
    file_summary = [
        f"{field_name}={filename}({len(content)} bytes, {mime})"
        for field_name, (filename, content, mime) in files
    ]
    logger.info("图片编辑转发: %d 个文件 [%s]", len(files), ", ".join(file_summary))

    chain = runtime_config.model_chain("image") or [
        runtime_config.image_model or str(form.get("model") or "gpt-image-2")
    ]
    try:
        return await run_with_fallback(
            chain,
            lambda model: _edits_once(files, form, model, prompt=prompt, size=size),
        )
    except GatewayError as exc:
        logger.warning("图片编辑上游失败: %s %s", exc.code, exc)
        # 同生图：只有连不上上游才降级，业务错误（含格式异常）如实失败
        if mode == "auto" and exc.code in _DEMO_FALLBACK_CODES:
            return demo_service.demo_image_result(prompt, size, 1)
        raise
