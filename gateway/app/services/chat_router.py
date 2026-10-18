"""对话转发：SSE 透传 + 归一 + Demo 降级判定。"""
from __future__ import annotations

from app.services import demo_service
from app.services.error_mapper import classify_exception, classify_status
from app.state import runtime_config
from app.upstream import llm_client, llm_headers, provider_client, provider_headers
from app.utils.errors import ErrorCode, GatewayError
from app.utils.streaming import sse_line

_FALLBACK_CODES = {
    ErrorCode.PROXY_UNREACHABLE,
    ErrorCode.UPSTREAM_ERROR,
    ErrorCode.POOL_UNAVAILABLE,
}


async def stream_chat(payload: dict):
    """流式对话：SSE 逐块透传；auto/on 时按需降级为模拟回复。"""
    messages = payload.get("messages") or []
    mode = runtime_config.demo_mode
    if mode == "on":
        async for chunk in demo_service.demo_chat_stream(messages):
            yield chunk
        return

    body = {**payload, "stream": True}
    if runtime_config.text_model:
        body["model"] = runtime_config.text_model
    client = provider_client("text")
    produced = False
    try:
        async with client.stream(
            "POST", "/chat/completions", headers=provider_headers("text"), json=body
        ) as resp:
            if resp.status_code >= 400:
                text = (await resp.aread()).decode("utf-8", "ignore")
                raise classify_status(resp.status_code, text)
            async for chunk in resp.aiter_bytes():
                if chunk:
                    produced = True
                    yield chunk
    except GatewayError as exc:
        if mode == "auto" and exc.code in _FALLBACK_CODES:
            async for chunk in demo_service.demo_chat_stream(messages):
                yield chunk
            return
        yield sse_line({"error_code": exc.code.value, "message": exc.message, "done": True})
        yield b"data: [DONE]\n\n"
    except Exception as exc:  # noqa: BLE001
        mapped = classify_exception(exc)
        if mode == "auto" and mapped.code in _FALLBACK_CODES:
            async for chunk in demo_service.demo_chat_stream(messages):
                yield chunk
            return
        yield sse_line({"error_code": mapped.code.value, "message": mapped.message, "done": True})
        yield b"data: [DONE]\n\n"
    finally:
        await client.aclose()
        _ = produced


async def complete_chat(payload: dict) -> dict:
    """非流式对话，直连配置的 OpenAI-compatible 文本 provider。"""
    messages = payload.get("messages") or []
    mode = runtime_config.demo_mode
    if mode == "on":
        return demo_service.demo_chat_completion(messages)
    try:
        body = {**payload}
        if runtime_config.text_model:
            body["model"] = runtime_config.text_model
        async with provider_client("text") as client:
            resp = await client.post(
                "/chat/completions", headers=provider_headers("text"), json=body
            )
        if resp.status_code >= 400:
            raise classify_status(resp.status_code, resp.text)
        data = resp.json()
        if isinstance(data, dict):
            data.setdefault("demo", False)
        return data
    except GatewayError:
        if mode == "auto":
            return demo_service.demo_chat_completion(messages)
        raise
    except Exception as exc:  # noqa: BLE001
        mapped = classify_exception(exc)
        if mode == "auto" and mapped.code in _FALLBACK_CODES:
            return demo_service.demo_chat_completion(messages)
        raise mapped


async def complete_llm(payload: dict) -> dict:
    """调用意图模型；未配置独立 LLM 时复用文本 provider。"""
    if runtime_config.demo_mode == "on":
        return demo_service.demo_chat_completion(payload.get("messages") or [])
    try:
        async with llm_client() as client:
            body = {**payload}
            if runtime_config.llm_model:
                # 该路由的模型由独立 LLM 配置管理；ChatCompletion Schema 的默认
                # gpt-4o-mini 不能覆盖管理员在中转站设置的模型名。
                body["model"] = runtime_config.llm_model
            response = await client.post("/chat/completions", headers=llm_headers(), json=body)
        if response.status_code >= 400:
            raise classify_status(response.status_code, response.text)
        data = response.json()
        if isinstance(data, dict):
            data.setdefault("demo", False)
        return data
    except GatewayError:
        if runtime_config.demo_mode == "auto":
            return demo_service.demo_chat_completion(payload.get("messages") or [])
        raise
    except Exception as exc:  # noqa: BLE001
        mapped = classify_exception(exc)
        if runtime_config.demo_mode == "auto" and mapped.code in _FALLBACK_CODES:
            return demo_service.demo_chat_completion(payload.get("messages") or [])
        raise mapped
