"""对话转发：SSE 透传 + 归一 + Demo 降级判定。

韧性：非流式走 `resilience.run_with_fallback`（重试 → 换备用模型 → 如实报错）；
流式在「尚未向客户端吐出任何内容」前同样重试与换模型，吐了内容就不能重放，
否则前端会看到重复文本。
"""
from __future__ import annotations

import asyncio
import logging

from app.config import settings
from app.services import demo_service
from app.services.error_mapper import classify_exception, classify_status
from app.services.resilience import run_with_fallback
from app.state import runtime_config
from app.upstream import llm_client, llm_headers, provider_client, provider_headers
from app.utils.errors import ErrorCode, GatewayError
from app.utils.streaming import sse_line
from app.utils.upstream_json import check_stream_prefix, parse_json_body

logger = logging.getLogger(__name__)

#: 允许降级为演示回复的错误（仅「上游根本连不上」）。格式异常 / 鉴权失败等必须如实报错。
_FALLBACK_CODES = {
    ErrorCode.PROXY_UNREACHABLE,
}


async def _stream_once(payload: dict, model: str):
    """单次流式请求：产出原始字节块；失败时抛归一后的 GatewayError。"""
    body = {**payload, "stream": True}
    if model:
        body["model"] = model
    client = provider_client("text")
    try:
        async with client.stream(
            "POST", "/chat/completions", headers=provider_headers("text"), json=body
        ) as resp:
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", "ignore")
                raise classify_status(resp.status_code, text)
            first = True
            yielded = False
            async for chunk in resp.aiter_bytes():
                if not chunk:
                    continue
                if first:
                    first = False
                    # 先验开头：上游把网页按 200 推下来时，不拦就会被原样当成 SSE 吐给浏览器
                    check_stream_prefix(chunk)
                yielded = True
                yield chunk
            if not yielded:
                raise GatewayError(
                    ErrorCode.UPSTREAM_ERROR,
                    "上游返回了空响应，已自动重试",
                    retryable=True,
                    switch_model=True,
                )
    finally:
        await client.aclose()


async def stream_chat(payload: dict):
    """流式对话：SSE 逐块透传；auto/on 时按需降级为模拟回复。"""
    messages = payload.get("messages") or []
    mode = runtime_config.demo_mode
    if mode == "on":
        async for chunk in demo_service.demo_chat_stream(messages):
            yield chunk
        return

    chain = runtime_config.model_chain("text") or [runtime_config.text_model]
    retries = settings.max_retries
    failure: GatewayError | None = None
    produced = False

    for index, model in enumerate(chain):
        next_model = chain[index + 1] if index + 1 < len(chain) else None
        for attempt_no in range(retries + 1):
            produced = False
            failure = None
            try:
                async for chunk in _stream_once(payload, model):
                    if chunk:
                        produced = True
                        yield chunk
                return
            except Exception as exc:  # noqa: BLE001 - 归一后决定重试 / 换模型
                failure = exc if isinstance(exc, GatewayError) else classify_exception(exc)

            if produced:
                # 已经吐出内容，中途断了不能重放：前端会看到重复文本
                break
            if not failure.retryable:
                break
            if attempt_no < retries:
                delay = 0.4 * (2**attempt_no)
                logger.warning(
                    "对话流失败（%s），%.1fs 后重试模型 %s：%s",
                    failure.code.value,
                    delay,
                    model or "(默认)",
                    failure.message,
                )
                await asyncio.sleep(delay)
                continue
            break
        if produced or failure is None or not failure.switch_model or next_model is None:
            break
        logger.warning(
            "对话流换备用模型：%s → %s（%s）", model or "(默认)", next_model, failure.code.value
        )

    if produced:
        # 半截内容已经发出去了，只能补一条收尾错误
        error = failure or GatewayError(ErrorCode.UPSTREAM_ERROR, "这次没能回复出来，请再试一次")
        yield sse_line({"error_code": error.code.value, "message": error.message, "done": True})
        yield b"data: [DONE]\n\n"
        return

    if mode == "auto" and failure is not None and failure.code in _FALLBACK_CODES:
        async for chunk in demo_service.demo_chat_stream(messages):
            yield chunk
        return

    error = failure or GatewayError(ErrorCode.UPSTREAM_ERROR, "这次没能回复出来，请再试一次")
    yield sse_line({"error_code": error.code.value, "message": error.message, "done": True})
    yield b"data: [DONE]\n\n"


async def _complete_chat_once(payload: dict, model: str) -> dict:
    """单次非流式对话调用。"""
    body = {**payload}
    if model:
        body["model"] = model
    async with provider_client("text") as client:
        resp = await client.post(
            "/chat/completions", headers=provider_headers("text"), json=body
        )
    if resp.status_code >= 400:
        raise classify_status(resp.status_code, resp.text)
    data = parse_json_body(resp)
    data.setdefault("demo", False)
    return data


async def complete_chat(payload: dict) -> dict:
    """非流式对话，直连配置的 OpenAI-compatible 文本 provider。"""
    messages = payload.get("messages") or []
    mode = runtime_config.demo_mode
    if mode == "on":
        return demo_service.demo_chat_completion(messages)
    try:
        return await run_with_fallback(
            runtime_config.model_chain("text") or [runtime_config.text_model],
            lambda model: _complete_chat_once(payload, model),
        )
    except GatewayError as exc:
        if mode == "auto" and exc.code in _FALLBACK_CODES:
            return demo_service.demo_chat_completion(messages)
        raise


async def _complete_llm_once(payload: dict, model: str) -> dict:
    """单次意图模型调用（独立 LLM 配置，未配置时复用文本 provider）。"""
    body = {**payload}
    if model:
        # 该路由的模型由独立 LLM 配置管理；ChatCompletion Schema 的默认
        # gpt-4o-mini 不能覆盖管理员在中转站设置的模型名。
        body["model"] = model
    async with llm_client() as client:
        response = await client.post("/chat/completions", headers=llm_headers(), json=body)
    if response.status_code >= 400:
        raise classify_status(response.status_code, response.text)
    data = parse_json_body(response)
    data.setdefault("demo", False)
    return data


async def complete_llm(payload: dict) -> dict:
    """调用意图模型；未配置独立 LLM 时复用文本 provider。"""
    if runtime_config.demo_mode == "on":
        return demo_service.demo_chat_completion(payload.get("messages") or [])
    try:
        return await run_with_fallback(
            runtime_config.model_chain("llm")
            or runtime_config.model_chain("text")
            or [runtime_config.text_model],
            lambda model: _complete_llm_once(payload, model),
        )
    except GatewayError as exc:
        if runtime_config.demo_mode == "auto" and exc.code in _FALLBACK_CODES:
            return demo_service.demo_chat_completion(payload.get("messages") or [])
        raise


async def stream_llm(payload: dict):
    """Stream the independent intent provider; never manufacture a demo plan."""
    if runtime_config.demo_mode == "on":
        yield sse_line({"error_code": "UPSTREAM_ERROR", "message": "需求分析需要连接真实模型"})
        return
    chain = runtime_config.model_chain("llm") or runtime_config.model_chain("text") or [runtime_config.text_model]
    produced = False
    for model in chain:
        try:
            async with llm_client() as client:
                async with client.stream(
                    "POST", "/chat/completions", headers=llm_headers(),
                    json={**payload, "model": model, "stream": True},
                ) as response:
                    if response.status_code >= 400:
                        raise classify_status(response.status_code, (await response.aread()).decode("utf-8", "ignore"))
                    async for chunk in response.aiter_bytes():
                        if chunk:
                            if not produced:
                                check_stream_prefix(chunk)
                            produced = True
                            yield chunk
                    if produced:
                        return
        except Exception as exc:
            error = exc if isinstance(exc, GatewayError) else classify_exception(exc)
            if produced or not error.switch_model:
                yield sse_line({"error_code": error.code.value, "message": error.message})
                return
    yield sse_line({"error_code": "UPSTREAM_ERROR", "message": "需求分析暂时不可用，请稍后重试"})
