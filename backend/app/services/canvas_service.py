"""画布服务：CRUD、自动保存、分享、导出。"""
from __future__ import annotations

import io
import json
from typing import Any

from PIL import Image, ImageDraw
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.canvas import Canvas
from app.models.chat import ChatMessage, ChatSession
from app.models.project import CanvasProject
from app.security import generate_token
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow

EMPTY_STATE: dict[str, Any] = {"elements": [], "appState": {}, "files": {}}


async def _get_project_or_403(db: AsyncSession, owner_id: str, project_id: str) -> CanvasProject:
    """获取项目并校验归属。"""
    result = await db.execute(
        select(CanvasProject).where(
            CanvasProject.id == project_id, CanvasProject.deleted_at.is_(None)
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise AppError(ErrorCode.NOT_FOUND, "项目不存在")
    if project.owner_id != owner_id:
        raise AppError(ErrorCode.FORBIDDEN, "无权访问该项目")
    return project


async def create_canvas(
    db: AsyncSession, owner_id: str, project_id: str, name: str = "未命名画布"
) -> Canvas:
    """在项目下新建画布。"""
    await _get_project_or_403(db, owner_id, project_id)
    canvas = Canvas(
        id=new_id(),
        project_id=project_id,
        owner_id=owner_id,
        name=name,
        state=dict(EMPTY_STATE),
    )
    db.add(canvas)
    await db.flush()
    return canvas


async def list_by_project(db: AsyncSession, owner_id: str, project_id: str) -> list[Canvas]:
    """列出项目下所有画布。"""
    await _get_project_or_403(db, owner_id, project_id)
    result = await db.execute(
        select(Canvas).where(Canvas.project_id == project_id).order_by(Canvas.created_at.asc())
    )
    return list(result.scalars().all())


async def get_canvas(db: AsyncSession, owner_id: str, canvas_id: str) -> Canvas:
    """获取画布并校验归属。"""
    result = await db.execute(select(Canvas).where(Canvas.id == canvas_id))
    canvas = result.scalar_one_or_none()
    if canvas is None:
        raise AppError(ErrorCode.NOT_FOUND, "画布不存在")
    if canvas.owner_id != owner_id:
        raise AppError(ErrorCode.FORBIDDEN, "无权访问该画布")
    return canvas


async def update_canvas(
    db: AsyncSession,
    owner_id: str,
    canvas_id: str,
    name: str | None = None,
    state: dict[str, Any] | None = None,
    thumbnail: str | None = None,
) -> Canvas:
    """自动保存画布（名称 / 场景 / 缩略图）。"""
    canvas = await get_canvas(db, owner_id, canvas_id)
    if name is not None:
        canvas.name = name
    if state is not None:
        canvas.state = state
    if thumbnail is not None:
        canvas.thumbnail_url = thumbnail
    canvas.updated_at = utcnow()
    await db.flush()
    return canvas


async def delete_canvas(db: AsyncSession, owner_id: str, canvas_id: str) -> None:
    """删除画布。"""
    canvas = await get_canvas(db, owner_id, canvas_id)
    await db.delete(canvas)
    await db.flush()


async def share_canvas(db: AsyncSession, owner_id: str, canvas_id: str) -> tuple[str, str]:
    """开启分享，返回 (share_token, url)。"""
    canvas = await get_canvas(db, owner_id, canvas_id)
    if not canvas.share_token:
        canvas.share_token = generate_token(16)
    canvas.is_public = True
    await db.flush()
    url = f"{settings.frontend_base_url.rstrip('/')}/share/{canvas.share_token}"
    return canvas.share_token, url


async def unshare_canvas(db: AsyncSession, owner_id: str, canvas_id: str) -> None:
    """关闭分享。"""
    canvas = await get_canvas(db, owner_id, canvas_id)
    canvas.is_public = False
    canvas.share_token = None
    await db.flush()


async def get_shared(db: AsyncSession, token: str) -> Canvas:
    """按分享 token 读取画布（只读）。"""
    result = await db.execute(
        select(Canvas).where(Canvas.share_token == token, Canvas.is_public.is_(True))
    )
    canvas = result.scalar_one_or_none()
    if canvas is None:
        raise AppError(ErrorCode.NOT_FOUND, "分享链接无效或已关闭")
    return canvas


async def share_session(db: AsyncSession, owner_id: str, session_id: str) -> tuple[str, str]:
    """开启「整段对话」分享，返回 (token, url)。

    分享出去的是**对话只读视图**：消息、提示词、生成结果链接、关联画布快照。
    访问者可以看、可以「基于它继续创作」——继续创作会复制一份到自己的账号下，
    不会污染原作者的对话（见 `fork_shared_session`）。
    """
    session = (
        await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    ).scalar_one_or_none()
    if session is None or session.user_id != owner_id or session.deleted_at is not None:
        raise AppError(ErrorCode.NOT_FOUND, "这段对话不存在")
    if not session.share_token:
        session.share_token = generate_token(16)
    session.is_public = True
    await db.flush()
    url = f"{settings.frontend_base_url.rstrip('/')}/share/chat/{session.share_token}"
    return session.share_token, url


async def unshare_session(db: AsyncSession, owner_id: str, session_id: str) -> None:
    """关闭对话分享（旧链接立即失效，重开会签发新 token）。"""
    session = (
        await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    ).scalar_one_or_none()
    if session is None or session.user_id != owner_id:
        raise AppError(ErrorCode.NOT_FOUND, "这段对话不存在")
    session.is_public = False
    session.share_token = None
    await db.flush()


async def get_shared_session(db: AsyncSession, token: str) -> tuple[ChatSession, list[ChatMessage]]:
    """按 token 读取分享的对话（公开、只读）。"""
    session = (
        await db.execute(
            select(ChatSession).where(
                ChatSession.share_token == token, ChatSession.is_public.is_(True)
            )
        )
    ).scalar_one_or_none()
    if session is None:
        raise AppError(ErrorCode.NOT_FOUND, "分享链接无效或已关闭")
    messages = (
        await db.execute(
            select(ChatMessage)
            .where(
                ChatMessage.session_id == session.id,
                ChatMessage.deleted_at.is_(None),
            )
            .order_by(ChatMessage.created_at.asc())
            .limit(300)
        )
    ).scalars().all()
    return session, list(messages)


async def fork_shared_session(
    db: AsyncSession, viewer_id: str, token: str
) -> ChatSession:
    """「基于这段对话继续创作」：把共享对话复制一份到访问者账号下。

    只复制**可复现的内容**（文字 + 提示词 + 参考图附件），不复制他人的画布与任务所有权；
    新会话会新建一块空白画布，访问者从零开始画，不会改到原作者的任何数据。
    """
    source, messages = await get_shared_session(db, token)
    # 复用会话建画布的逻辑（在访问者自己的项目下开一张空画布）
    from app.services import chat_service

    canvas_id = await chat_service._create_conversation_canvas(
        db, viewer_id, f"{source.title or '对话'}（来自分享）"
    )
    clone = ChatSession(
        id=new_id(),
        user_id=viewer_id,
        canvas_id=canvas_id,
        title=f"{source.title or '对话'}（来自分享）"[:255],
    )
    db.add(clone)
    await db.flush()
    for message in messages:
        attachments = []
        for item in message.attachments or []:
            if not isinstance(item, dict):
                continue
            kind = str(item.get("type") or "")
            # compose_run / skill_run 是执行态，复制过去会指向别人的 run，丢掉更安全
            if kind in {"compose_run", "skill_run"}:
                continue
            attachments.append(item)
        db.add(
            ChatMessage(
                id=new_id(),
                session_id=clone.id,
                user_id=viewer_id,
                role=message.role,
                content=message.content,
                attachments=attachments,
            )
        )
    await db.flush()
    return clone


def _render_placeholder_png(canvas: Canvas) -> bytes:
    """无缩略图时用 Pillow 渲染占位导出图。"""
    img = Image.new("RGB", (1024, 768), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    draw.text((40, 40), f"Canvas: {canvas.name}", fill=(30, 30, 30))
    draw.text((40, 80), "（导出占位图：请在客户端使用画布导出获取精确渲染）", fill=(120, 120, 120))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def export_canvas(
    db: AsyncSession, owner_id: str, canvas_id: str, fmt: str
) -> tuple[bytes, str, str]:
    """导出画布：返回 (content, media_type, filename)。"""
    canvas = await get_canvas(db, owner_id, canvas_id)
    if fmt == "json":
        content = json.dumps(
            {"id": canvas.id, "name": canvas.name, "state": canvas.state}, ensure_ascii=False
        ).encode("utf-8")
        return content, "application/json", f"canvas-{canvas.id}.json"
    # png
    local = None
    if canvas.thumbnail_url:
        from app.services.asset_service import local_path_from_url
        from app.services.storage_service import storage_root

        rel = local_path_from_url(canvas.thumbnail_url)
        if rel:
            candidate = storage_root() / rel
            if candidate.exists():
                local = candidate.read_bytes()
    content = local if local else _render_placeholder_png(canvas)
    return content, "image/png", f"canvas-{canvas.id}.png"
