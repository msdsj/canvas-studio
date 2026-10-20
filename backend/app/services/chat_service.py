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
from app.models.user import User
from app.services import access, config_service, quota_service
from app.services.gateway_client import gateway_client
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.chat_service")


async def list_sessions(
    db: AsyncSession, user: User, canvas_id: str | None = None
) -> list[ChatSession]:
    """列出会话：本人 ∪ 当前团队共享。"""
    ctx = await access.current_context(db, user)
    conditions = [
        access.session_scope_clause(user, ctx),
        ChatSession.deleted_at.is_(None),
    ]
    if canvas_id:
        conditions.append(ChatSession.canvas_id == canvas_id)
    result = await db.execute(
        select(ChatSession).where(*conditions).order_by(ChatSession.updated_at.desc())
    )
    return list(result.scalars().all())


async def create_session(
    db: AsyncSession,
    user: User,
    canvas_id: str | None,
    title: str | None,
    *,
    new_canvas: bool = False,
) -> ChatSession:
    """新建会话。

    ``new_canvas=True`` 时同时开一张干净画布：对话与画布是 1:1 绑定的，
    只建会话不建画布，用户点「新建对话」后画布上还留着上一轮的图，
    对话与画布的对应关系会立刻错位。
    """
    if new_canvas or not canvas_id:
        canvas_id = await _create_conversation_canvas(db, user, title)
    session = ChatSession(
        id=new_id(), user_id=user.id, canvas_id=canvas_id, title=title or "新对话"
    )
    # 会话跟随画布走：在团队画布上开的对话，团队成员也该看得到上下文
    if canvas_id:
        from app.models.canvas import Canvas

        canvas = await db.get(Canvas, canvas_id)
        if canvas is not None and canvas.team_id:
            session.team_id = canvas.team_id
            session.visibility = canvas.visibility
    db.add(session)
    await db.flush()
    return session


async def _create_conversation_canvas(
    db: AsyncSession, user: User, title: str | None
) -> str:
    """在用户的首个项目下开一张空画布（没有项目就先建一个）。"""
    from app.models.project import CanvasProject
    from app.services import canvas_service, project_service

    ctx = await access.current_context(db, user)
    project_id = (
        await db.execute(
            select(CanvasProject.id)
            .where(
                CanvasProject.owner_id == user.id,
                CanvasProject.deleted_at.is_(None),
                # 优先落在当前团队项目里：团队协作时新对话应该进公司的项目，
                # 而不是散落在个人空间里，否则「团队资源统一管理」名不副实
                CanvasProject.team_id == ctx.team_id
                if ctx.team_id
                else CanvasProject.team_id.is_(None),
            )
            .order_by(CanvasProject.updated_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if project_id is None:
        project = await project_service.create_project(
            db, user, "我的项目", share_with_team=ctx.team_id is not None
        )
        project_id = project.id
    name = (title or "新对话").strip()[:40] or "新对话"
    canvas = await canvas_service.create_canvas(
        db, user, project_id, name=f"{name} · 画布"
    )
    return canvas.id


async def get_session(
    db: AsyncSession, user: User, session_id: str, permission: str = "read"
) -> ChatSession:
    """获取会话并校验访问权限（团队共享会话可读，写仍限属主）。"""
    # 先按「读」校验存在性与可见性，再对写操作单独拦：团队成员能看到这段对话，
    # 但没有权限改它时应该收到「只能改自己的」这种明确提示，而不是「不存在」。
    session = await access.get_session_for(db, user, session_id, "read")
    if permission != "read" and session.user_id != user.id:
        raise AppError(ErrorCode.FORBIDDEN, "只能修改自己创建的对话")
    return session


async def update_session(
    db: AsyncSession,
    user: User,
    session_id: str,
    title: str | None,
    canvas_id: str | None = None,
) -> ChatSession:
    """重命名会话 / 重新绑定画布。"""
    session = await get_session(db, user, session_id, "write")
    if title is not None:
        session.title = title
    if canvas_id is not None:
        session.canvas_id = canvas_id
    session.updated_at = utcnow()
    await db.flush()
    return session


async def delete_session(db: AsyncSession, user: User, session_id: str) -> None:
    """删除会话（软删）。"""
    session = await get_session(db, user, session_id, "write")
    session.deleted_at = utcnow()
    await db.flush()


async def list_messages(
    db: AsyncSession, user: User, session_id: str, page: int, size: int
) -> tuple[list[ChatMessage], int]:
    """分页查询会话消息（时间正序）。"""
    await get_session(db, user, session_id)
    base = select(ChatMessage).where(
        ChatMessage.session_id == session_id, ChatMessage.deleted_at.is_(None)
    )
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
    user: User,
    session: ChatSession,
    content: str,
    image_refs: list[str] | None = None,
) -> tuple[ChatMessage, str, int]:
    """保存用户消息并预扣对话额度，返回 (user_msg, ref_id, cost)。

    扣费走用户所在团队的共享池（若已开启），流水仍记在发起人名下。
    """
    user_msg = await append_message(
        db, session.id, user.id, "user", content, attachments=image_refs or []
    )
    prices = await config_service.prices(db)
    cost = int(prices.get("chat", 0))
    if cost > 0:
        ctx = await access.current_context(db, user)
        await quota_service.pre_deduct(
            db,
            user.id,
            "consume_chat",
            cost,
            ref_id=user_msg.id,
            note="chat",
            team=ctx.team,
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
    finalized = False
    async with AsyncSessionLocal() as db:
        try:
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
                finalized = True
                await db.commit()
                yield sse_chunk({"delta": "", "done": True, "demo": demo})
            else:
                if cost > 0:
                    await quota_service.refund(db, ref_id)
                finalized = True
                await db.commit()
                yield sse_chunk({"delta": "", "done": True, "error_code": error_code})
        finally:
            # 用户中途关页面 / 断网：生成器被关闭，这里必须把预扣额度退回，
            # 否则会出现「额度扣了但什么都没拿到」的黑洞。
            if not finalized and cost > 0:
                try:
                    await quota_service.refund(db, ref_id)
                    await db.commit()
                    logger.info("对话流中断，已退回预扣额度 ref=%s", ref_id)
                except Exception:  # noqa: BLE001
                    logger.exception("对话流中断退款失败 ref=%s", ref_id)


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


async def delete_message(db: AsyncSession, user_id: str, message_id: str) -> None:
    """软删单条消息（仅能删自己会话里的）。"""
    row = (
        await db.execute(
            select(ChatMessage).where(
                ChatMessage.id == message_id,
                ChatMessage.user_id == user_id,
                ChatMessage.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "这条消息已经不存在了")
    row.deleted_at = utcnow()
    await db.flush()


async def delete_messages(db: AsyncSession, user_id: str, message_ids: list[str]) -> int:
    """批量软删消息（只删属于当前用户的），返回实际删除条数。"""
    ids = [item for item in dict.fromkeys(message_ids) if item]
    if not ids:
        return 0
    rows = (
        await db.execute(
            select(ChatMessage).where(
                ChatMessage.id.in_(ids),
                ChatMessage.user_id == user_id,
                ChatMessage.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    now = utcnow()
    for row in rows:
        row.deleted_at = now
    await db.flush()
    return len(rows)
