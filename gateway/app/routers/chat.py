"""对话转发路由 /gw/chat/completions。"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from app.schemas.chat import ChatCompletionRequest
from app.schemas.common import ok
from app.services import chat_router

router = APIRouter(prefix="/gw/chat", tags=["gateway-chat"])


@router.post("/completions")
async def chat_completions(payload: ChatCompletionRequest):
    """转发 sub2api；SSE 透传；demo 时模拟回复。"""
    body = payload.model_dump()
    if payload.stream:
        return StreamingResponse(chat_router.stream_chat(body), media_type="text/event-stream")
    return ok(await chat_router.complete_chat(body))
