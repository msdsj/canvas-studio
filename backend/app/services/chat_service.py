"""对话服务：会话/消息 CRUD + SSE 流式回复（经网关）。

文本对话按 `QUOTA_PRICE_CHAT` 计费：发送前预扣、成功确认、失败回滚。
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.chat import ChatMessage, ChatSession
from app.services import config_service, quota_service
from app.services.gateway_client import gateway_client
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.chat_service")


async def list_sessions(
    db: AsyncSession, user_id: str, canvas_id: str | None = None
) -> list[ChatSession]:
    """列出用户会话。"""
    conditions = [ChatSession.user_id == user_id, ChatSession.deleted_at.is_(None)]
    if canvas_id:
        conditions.append(ChatSession.canvas_id == canvas_id)
    result = await db.execute(
        select(ChatSession).where(*conditions).order_by(ChatSession.updated_at.desc())
    )
    return list(result.scalars().all())


async def create_session(
    db: AsyncSession, user_id: str, canvas_id: str | None, title: str | None
) -> ChatSession:
    """新建会话。"""
    session = ChatSession(
        id=new_id(), user_id=user_id, canvas_id=canvas_id, title=title or "新对话"
    )
    db.add(session)
    await db.flush()
    return session


async def get_session(db: AsyncSession, user_id: str, session_id: str) -> ChatSession:
    """获取会话并校验归属。"""
    result = await db.execute(
        select(ChatSession).where(ChatSession.id == session_id, ChatSession.deleted_at.is_(None))
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise AppError(ErrorCode.NOT_FOUND, "会话不存在")
    if session.user_id != user_id:
        raise AppError(ErrorCode.FORBIDDEN, "无权访问该会话")
    return session


async def update_session(
    db: AsyncSession, user_id: str, session_id: str, title: str | None
) -> ChatSession:
    """重命名会话。"""
    session = await get_session(db, user_id, session_id)
    if title is not None:
        session.title = title
    session.updated_at = utcnow()
    await db.flush()
    return session


async def delete_session(db: AsyncSession, user_id: str, session_id: str) -> None:
    """删除会话（软删）。"""
    session = await get_session(db, user_id, session_id)
    session.deleted_at = utcnow()
    await db.flush()


async def list_messages(
    db: AsyncSession, user_id: str, session_id: str, page: int, size: int
) -> tuple[list[ChatMessage], int]:
    """分页查询会话消息（时间正序）。"""
    await get_session(db, user_id, session_id)
    base = select(ChatMessage).where(ChatMessage.session_id == session_id)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(ChatMessage.created_at.asc()).offset((page - 1) * size).limit(size)
    )
    return list(result.scalars().all()), total


async def append_message(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    role: str,
    content: str,
    attachments: list[Any] | None = None,
    generation_task_id: str | None = None,
) -> ChatMessage:
    """追加一条消息。"""
    message = ChatMessage(
        id=new_id(),
        session_id=session_id,
        user_id=user_id,
        role=role,
        content=content,
        attachments=attachments or [],
        generation_task_id=generation_task_id,
    )
    db.add(message)
    await db.flush()
    return message


async def prepare_turn(
    db: AsyncSession,
    user_id: str,
    session: ChatSession,
    content: str,
    image_refs: list[str] | None = None,
) -> tuple[ChatMessage, str, int]:
    """保存用户消息并预扣对话额度，返回 (user_msg, ref_id, cost)。"""
    user_msg = await append_message(
        db, session.id, user_id, "user", content, attachments=image_refs or []
    )
    prices = await config_service.prices(db)
    cost = int(prices.get("chat", 0))
    if cost > 0:
        await quota_service.pre_deduct(
            db, user_id, "consume_chat", cost, ref_id=user_msg.id, note="chat"
        )
    session.updated_at = utcnow()
    await db.commit()
    await db.refresh(user_msg)
    return user_msg, user_msg.id, cost


async def build_payload(db: AsyncSession, session_id: str, content: str) -> dict[str, Any]:
    """构造网关对话请求体（含历史上下文）。"""
    result = await db.execute(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id)
        .order_by(ChatMessage.created_at.asc())
    )
    history = list(result.scalars().all())
    messages = [{"role": m.role, "content": m.content} for m in history if m.content]
    if not messages or messages[-1]["content"] != content:
        messages.append({"role": "user", "content": content})
    return {"model": "gpt-4o-mini", "messages": messages, "stream": True}


def sse_chunk(payload: dict[str, Any]) -> str:
    """把数据块编码为 SSE 行。"""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def stream_and_finalize(
    session_id: str,
    user_id: str,
    ref_id: str,
    cost: int,
    payload: dict[str, Any],
) -> AsyncIterator[str]:
    """流式转发网关回复，结束后落库助手消息并确认/回滚额度。"""
    collected: list[str] = []
    demo = False
    error_code: str | None = None
    async with AsyncSessionLocal() as db:
        try:
            async for raw in gateway_client.chat_completions_stream(payload):
                for line in raw.decode("utf-8", "ignore").splitlines():
                    line = line.strip()
                    if not line.startswith("data:"):
                        continue
                    data_str = line[5:].strip()
                    if data_str == "[DONE]":
                        continue
                    try:
                        obj = json.loads(data_str)
                    except json.JSONDecodeError:
                        continue
                    if obj.get("demo") is True:
                        demo = True
                    delta = _extract_delta(obj)
                    if delta:
                        collected.append(delta)
                        yield sse_chunk({"delta": delta, "done": False, "demo": demo})
        except AppError as exc:
            error_code = exc.code.value
            logger.warning("对话流失败: %s", exc.message)
        except Exception as exc:  # noqa: BLE001
            error_code = ErrorCode.UPSTREAM_ERROR.value
            logger.exception("对话流异常: %s", exc)

        full_text = "".join(collected)
        if error_code is None:
            if full_text:
                await append_message(db, session_id, user_id, "assistant", full_text)
            if cost > 0:
                await quota_service.confirm(db, ref_id)
            await db.commit()
            yield sse_chunk({"delta": "", "done": True, "demo": demo})
        else:
            if cost > 0:
                await quota_service.refund(db, ref_id)
            await db.commit()
            yield sse_chunk({"delta": "", "done": True, "error_code": error_code})


def _extract_delta(obj: dict[str, Any]) -> str:
    """从 OpenAI 风格块中提取增量文本。"""
    try:
        choices = obj.get("choices") or []
        if choices:
            delta = choices[0].get("delta") or {}
            content = delta.get("content")
            if content:
                return str(content)
            message = choices[0].get("message") or {}
            if message.get("content"):
                return str(message["content"])
    except (AttributeError, KeyError, TypeError):
        return ""
    return ""
