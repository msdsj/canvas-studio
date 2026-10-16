"""对话转发：SSE 透传 + 归一 + Demo 降级判定。"""
from __future__ import annotations

from app.services import demo_service
from app.services.error_mapper import classify_exception, classify_status
from app.state import runtime_config
from app.upstream import sub2api_client, sub2api_headers
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
    client = sub2api_client()
    produced = False
    try:
        async with client.stream(
            "POST", "/v1/chat/completions", headers=sub2api_headers(), json=body
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
    """非流式对话。"""
    messages = payload.get("messages") or []
    mode = runtime_config.demo_mode
    if mode == "on":
        return demo_service.demo_chat_completion(messages)
    try:
        async with sub2api_client() as client:
            resp = await client.post(
                "/v1/chat/completions", headers=sub2api_headers(), json=payload
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
