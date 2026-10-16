"""对话路由 `/api/chat/*`（含 SSE 消息流）。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.schemas.chat import (
    ChatMessageCreateRequest,
    ChatMessageOut,
    ChatSessionCreateRequest,
    ChatSessionOut,
    ChatSessionUpdateRequest,
)
from app.services import chat_service
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/chat", tags=["chat"])


@router.get("/sessions")
async def list_sessions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    canvas_id: str | None = Query(default=None),
) -> dict:
    """列出会话。"""
    sessions = await chat_service.list_sessions(db, user.id, canvas_id)
    return envelope([ChatSessionOut.model_validate(s).model_dump() for s in sessions])


@router.post("/sessions")
async def create_session(
    payload: ChatSessionCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """新建会话。"""
    session = await chat_service.create_session(db, user.id, payload.canvas_id, payload.title)
    await db.commit()
    return envelope(ChatSessionOut.model_validate(session).model_dump())


@router.patch("/sessions/{session_id}")
async def update_session(
    session_id: str,
    payload: ChatSessionUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """重命名会话。"""
    session = await chat_service.update_session(db, user.id, session_id, payload.title)
    await db.commit()
    return envelope(ChatSessionOut.model_validate(session).model_dump())


@router.delete("/sessions/{session_id}")
async def delete_session(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除会话。"""
    await chat_service.delete_session(db, user.id, session_id)
    await db.commit()
    return envelope({})


@router.get("/sessions/{session_id}/messages")
async def list_messages(
    session_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=50, ge=1, le=100),
) -> dict:
    """分页查询会话消息。"""
    page, size = normalize_page(page, size)
    rows, total = await chat_service.list_messages(db, user.id, session_id, page, size)
    items = [ChatMessageOut.model_validate(r).model_dump() for r in rows]
    return envelope(paginated(items, total, page, size))


@router.post("/messages")
async def send_message(
    payload: ChatMessageCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """发送消息 → SSE 流式回复（经网关；demo 时模拟）。"""
    session = await chat_service.get_session(db, user.id, payload.session_id)
    _, ref_id, cost = await chat_service.prepare_turn(
        db, user.id, session, payload.content, payload.image_refs
    )
    gateway_payload = await chat_service.build_payload(db, session.id, payload.content)
    return StreamingResponse(
        chat_service.stream_and_finalize(session.id, user.id, ref_id, cost, gateway_payload),
        media_type="text/event-stream",
    )
