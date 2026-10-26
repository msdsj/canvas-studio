"""生图 / 编辑转发（含 b64↔文件、多图）与 Demo 降级。

韧性：响应体格式异常（网页 / 空体 / 截断 / 非对象）先原地重试，再逐级切备用模型，
由 `resilience.run_with_fallback` 统一编排；全部失败就如实报错。
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
import uuid
from contextlib import asynccontextmanager

import httpx

from app.config import settings
from app.services.account_pool import account_pool
from app.services.error_mapper import classify_exception, classify_status
from app.services.resilience import run_with_fallback
from app.state import runtime_config
from app.upstream import provider_client, provider_headers
from app.utils.errors import ErrorCode, GatewayError
from app.utils.upstream_json import parse_json_body

logger = logging.getLogger(__name__)

@asynccontextmanager
async def _image_lease(payload: dict):
    """Hold one credential for one attempt; `rotate()` swaps it after a failure."""
    batch_id = str(payload.get("pool_batch_id") or "")
    task_id = str(payload.get("pool_task_id") or "")
    strict = bool(payload.get("pool_strict"))
    try:
        batch_total = int(payload.get("pool_batch_total") or 1)
        count = int(payload.get("n") or 1)
    except (ValueError, TypeError) as exc:
        raise GatewayError(ErrorCode.VALIDATION_ERROR, "图片批次数量无效") from exc
    if batch_id and (not task_id or not 1 <= batch_total <= 32 or count != 1):
        raise GatewayError(ErrorCode.VALIDATION_ERROR, "每个图片批次任务须包含标识且只生成一张图片")
    if not batch_id and (task_id or batch_total != 1):
        raise GatewayError(ErrorCode.VALIDATION_ERROR, "缺少图片批次标识")
    state: dict = {"account": None, "released": False}
    state["account"] = await account_pool.acquire_image(
        batch_id=batch_id, task_id=task_id, batch_total=batch_total, strict=strict
    )

    async def rotate() -> dict | None:
        """失败后换一个可用账号（本地池为空时由上游号池自己取号）。"""
        account = state["account"]
        new_account = await account_pool.rotate_image(
            (account or {}).get("id"),
            batch_id=batch_id,
            task_id=task_id,
            batch_total=batch_total,
        )
        if new_account is None:
            return None
        state["account"] = new_account
        return new_account

    try:
        yield state, rotate
    finally:
        account = state["account"]
        if account:
            await account_pool.release_image(account["id"], batch_id=batch_id, task_id=task_id)
        elif batch_id:
            # 没有本地账号的批次任务也要登记完成，否则批次永远不释放、重复提交会被拒
            await account_pool.release_image("", batch_id=batch_id, task_id=task_id)


#: 换号重试上限：一次请求最多经历 3 个账号（首次 + 换 2 次）。
_MAX_ACCOUNT_ROTATIONS = 2
#: 只有「号池/账号额度」类失败才值得换号；格式异常交回模型链重试，鉴权失败换号也白搭。
_ROTATABLE_CODES = {ErrorCode.POOL_UNAVAILABLE}


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


def _provider_generation_params(payload: dict) -> dict:
    """Pass through the common diffusion controls without leaking UI-only fields."""
    params = payload.get("generation_params")
    if not isinstance(params, dict):
        return {}
    return {
        key: params[key]
        for key in ("sampler", "steps", "cfg_scale", "seed")
        if params.get(key) not in (None, "")
    }


async def _generations_via_queue(
    payload: dict, model: str, *, prompt: str, size: str, n: int, account: dict | None = None
) -> dict | None:
    """同步接口暂时没有空闲账号时，改用上游任务队列排队出图。

    上游的同步 `/images/generations` 只要「此刻没有立即可用的账号」就直接 429
    （no available image quota），但号池里其它账号稍后就会空出来。上游的任务队列
    会自己按号池轮询等待空闲账号，因此这里提交排队任务并轮询结果，
    让用户的一次请求真正用上号池其余账号的额度，而不是当场失败。

    返回 `None` 表示上游没有任务队列能力（非 chatgpt2api），调用方退回换号重试。
    """
    base_url = (account or {}).get("base_url") or runtime_config.image_base_url
    api_key = (account or {}).get("access_token") or None
    root = base_url.rstrip("/")
    if root.endswith("/v1"):
        root = root[: -len("/v1")]
    headers = provider_headers("image", api_key)
    quality = str(payload.get("quality") or "standard")

    async with provider_client("image", base_url=root) as client:
        task_ids: list[str] = []
        for _ in range(max(1, n)):
            body = {
                "client_task_id": f"cs-{uuid.uuid4().hex}",
                "prompt": prompt,
                "model": model,
                "size": size,
                "quality": quality,
                **_provider_generation_params(payload),
            }
            resp = await client.post("/api/image-tasks/generations", headers=headers, json=body)
            if resp.status_code in (404, 405):
                return None
            if resp.status_code >= 400:
                raise classify_status(resp.status_code, resp.text)
            task = parse_json_body(resp)
            task_id = str(task.get("id") or "")
            if not task_id:
                return None
            task_ids.append(task_id)

        deadline = time.monotonic() + min(settings.read_timeout, 240)
        pending = list(task_ids)
        images: list[str] = []
        while pending:
            resp = await client.get(
                "/api/image-tasks", headers=headers, params={"ids": ",".join(pending)}
            )
            if resp.status_code in (404, 405):
                return None
            if resp.status_code >= 400:
                raise classify_status(resp.status_code, resp.text)
            items = {
                str(item.get("id")): item
                for item in (parse_json_body(resp).get("items") or [])
            }
            for task_id in list(pending):
                item = items.get(task_id)
                if not item:
                    continue
                status = str(item.get("status") or "")
                if status == "success":
                    for entry in item.get("data") or []:
                        b64 = await _to_b64(client, entry)
                        if b64:
                            images.append(b64)
                    pending.remove(task_id)
                elif status in {"error", "cancelled"}:
                    raise GatewayError(
                        ErrorCode.UPSTREAM_ERROR,
                        f"上游出图失败：{item.get('error') or status}",
                    )
            if pending:
                if time.monotonic() >= deadline:
                    raise GatewayError(
                        ErrorCode.POOL_UNAVAILABLE,
                        "上游号池持续繁忙：已排队等待可用账号，请稍后再试",
                    )
                await asyncio.sleep(2)
        if not images:
            raise GatewayError(ErrorCode.UPSTREAM_ERROR, "上游未返回图片")
        return {"created": 0, "demo": False, "data": [{"b64_json": b64} for b64 in images]}


async def _generations_once(
    payload: dict, model: str, *, prompt: str, size: str, n: int, account: dict | None = None
) -> dict:
    """单次生图调用（一个模型 + 一个号池账号）。"""
    body = {
        "prompt": prompt,
        "model": model,
        "n": n,
        "size": size,
        "quality": payload.get("quality", "standard"),
        **_provider_generation_params(payload),
    }
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
        # 只有「本地不托管账号」时才转队列：本地有账号时换号更直接，
        # 队列会把请求重新交还给上游自己调度，绕开本地隔离策略。
        if error.code is ErrorCode.POOL_UNAVAILABLE and account is None:
            # 同步接口此刻没有空闲账号：交给上游任务队列按号池排队，
            # 而不是让用户的一次请求当场失败。
            logger.info("同步生图暂无空闲账号，转入上游任务队列排队")
            queued = await _generations_via_queue(
                payload, model, prompt=prompt, size=size, n=n, account=account
            )
            if queued is not None:
                if account:
                    await account_pool.mark_success(account["id"])
                return queued
        # 上游整池无可用账号与这个 Key 无关，冷却它只会让恢复后也用不了；
        # 账号级失败（限流 / 额度 / 鉴权）才记录冷却。
        if account and error.code is not ErrorCode.POOL_UNAVAILABLE:
            await account_pool.mark_failure(
                account["id"],
                error.message,
                retryable=error.retryable,
            )
        raise error


async def _run_with_account_rotation(payload: dict, chain: list[str], attempt) -> dict:
    """一次请求内先换号、再交给模型链重试。

    原来账号只在请求开始时取一次，账号没额度后所有重试仍打同一个账号，
    等于把「号池还有 4 个可用账号」白白浪费。这里在号池类失败后立刻换号重跑，
    保证重试落在另一个账号上。
    """
    rotations = 0
    async with _image_lease(payload) as (lease, rotate):
        while True:
            try:
                return await run_with_fallback(
                    chain, lambda model: attempt(model, lease["account"])
                )
            except GatewayError as error:
                if rotations >= _MAX_ACCOUNT_ROTATIONS or error.code not in _ROTATABLE_CODES:
                    raise
                if await rotate() is None:
                    raise
                rotations += 1
                logger.warning("账号失败（%s），已切换到号池中的下一个可用账号重试", error.code.value)


async def image_generations(payload: dict) -> dict:
    """调用配置的图片模型；模型失败时如实返回错误。"""
    prompt = str(payload.get("prompt") or "")
    size = str(payload.get("size") or "1024x1024")
    n = int(payload.get("n") or 1)
    chain = runtime_config.model_chain("image") or [
        runtime_config.image_model or str(payload.get("model") or "gpt-image-2")
    ]
    try:
        return await _run_with_account_rotation(
            payload,
            chain,
            lambda model, account: _generations_once(
                payload, model, prompt=prompt, size=size, n=n, account=account
            ),
        )
    except GatewayError as exc:
        logger.warning("生图上游失败: %s %s", exc.code, exc)
        raise


async def _edits_once(
    files: list[tuple[str, tuple[str, bytes, str]]], form: dict, model: str, *, prompt: str, size: str,
    account: dict | None = None,
) -> dict:
    """单次图生图 / 编辑调用（一个模型 + 一个号池账号）。"""
    data = {
        "prompt": prompt,
        "model": model,
        "size": size,
        "quality": form.get("quality", "standard"),
        "n": max(1, min(int(form.get("n") or 1), 4)),
        "response_format": form.get("response_format", "b64_json"),
        **_provider_generation_params(form),
    }
    for key in ("background", "output_format"):
        value = str(form.get(key) or "").strip()
        if value:
            data[key] = value

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
        if account and error.code is not ErrorCode.POOL_UNAVAILABLE:
            await account_pool.mark_failure(
                account["id"],
                error.message,
                retryable=error.retryable,
            )
        raise error


async def image_edits(
    files: list[tuple[str, tuple[str, bytes, str]]], form: dict
) -> dict:
    """图生图 / 编辑必须调用真实图像模型，不返回本地演示图片。"""
    prompt = str(form.get("prompt") or "")
    size = str(form.get("size") or "1024x1024")
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
        return await _run_with_account_rotation(
            form,
            chain,
            lambda model, account: _edits_once(
                files, form, model, prompt=prompt, size=size, account=account
            ),
        )
    except GatewayError as exc:
        logger.warning("图片编辑上游失败: %s %s", exc.code, exc)
        # Editing results must come from the configured image model in every mode.
        raise
