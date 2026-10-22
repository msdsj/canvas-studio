"""画布服务：CRUD、自动保存、分享、导出。

归属校验统一走 `app.services.access`：团队版之后「是不是属主」不再是唯一判断
依据（团队成员、显式协作者、公开分享都能读），所以这里只负责业务动作，
不再自己写 `owner_id != user.id`。
"""
from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.canvas import Canvas
from app.models.chat import ChatMessage, ChatSession
from app.models.user import User
from app.security import generate_token
from app.services import access
from app.utils import offload
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow

EMPTY_STATE: dict[str, Any] = {"elements": [], "appState": {}, "files": {}}


async def create_canvas(
    db: AsyncSession, user: User, project_id: str, name: str = "未命名画布"
) -> Canvas:
    """在项目下新建画布。

    画布继承项目的团队归属与可见性：项目是团队共享的、画布却私有，同事点进去
    只会看到「无权访问」，这在协作场景里非常反直觉。
    """
    project = await access.get_project_for(db, user, project_id, "write")
    canvas = Canvas(
        id=new_id(),
        project_id=project_id,
        owner_id=user.id,
        team_id=project.team_id,
        visibility=project.visibility,
        name=name,
        state=dict(EMPTY_STATE),
    )
    db.add(canvas)
    await db.flush()
    return canvas


async def list_by_project(db: AsyncSession, user: User, project_id: str) -> list[Canvas]:
    """列出项目下所有画布（只看得到自己有读权限的）。"""
    await access.get_project_for(db, user, project_id, "read")
    ctx = await access.current_context(db, user)
    result = await db.execute(
        select(Canvas)
        .where(Canvas.project_id == project_id, access.canvas_scope_clause(user, ctx))
        .order_by(Canvas.created_at.asc())
    )
    return list(result.scalars().all())


async def get_canvas(
    db: AsyncSession, user: User, canvas_id: str, permission: str = "read"
) -> Canvas:
    """获取画布并按访问级别校验（不可访问抛 404，不泄漏存在性）。"""
    return await access.get_canvas_for(db, user, canvas_id, permission)  # type: ignore[arg-type]


async def update_canvas(
    db: AsyncSession,
    user: User,
    canvas_id: str,
    name: str | None = None,
    state: dict[str, Any] | None = None,
    thumbnail: str | None = None,
) -> Canvas:
    """自动保存画布（名称 / 场景 / 缩略图）。

    整场景覆盖写只允许属主：协作时整份覆盖会互相抹掉对方的改动，
    共享画布必须走 `collab_service` 的增量 patch 通道。
    """
    canvas = await get_canvas(db, user, canvas_id, "write")
    if canvas.owner_id != user.id:
        raise AppError(
            ErrorCode.FORBIDDEN, "这块画布由其他人创建，请通过协作通道同步修改"
        )
    if name is not None:
        canvas.name = name
    if state is not None:
        canvas.state = state
        canvas.version = int(canvas.version or 0) + 1
    if thumbnail is not None:
        canvas.thumbnail_url = thumbnail
    canvas.updated_by = user.id
    canvas.updated_at = utcnow()
    await db.flush()
    return canvas


async def delete_canvas(db: AsyncSession, user: User, canvas_id: str) -> None:
    """删除画布（属主或团队管理角色）。"""
    canvas = await get_canvas(db, user, canvas_id, "manage")
    await db.delete(canvas)
    await db.flush()


async def share_canvas(db: AsyncSession, user: User, canvas_id: str) -> tuple[str, str]:
    """开启分享，返回 (share_token, url)。"""
    canvas = await get_canvas(db, user, canvas_id, "manage")
    if not canvas.share_token:
        canvas.share_token = generate_token(16)
    canvas.is_public = True
    await db.flush()
    url = f"{settings.frontend_base_url.rstrip('/')}/share/{canvas.share_token}"
    return canvas.share_token, url


async def unshare_canvas(db: AsyncSession, user: User, canvas_id: str) -> None:
    """关闭分享。"""
    canvas = await get_canvas(db, user, canvas_id, "manage")
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


async def share_session(db: AsyncSession, user: User, session_id: str) -> tuple[str, str]:
    """开启「整段对话」分享，返回 (token, url)。

    分享出去的是**对话只读视图**：消息、提示词、生成结果链接、关联画布快照。
    访问者可以看、可以「基于它继续创作」——继续创作会复制一份到自己的账号下，
    不会污染原作者的对话（见 `fork_shared_session`）。
    """
    session = await access.get_session_for(db, user, session_id, "read")
    if session.user_id != user.id:
        raise AppError(ErrorCode.FORBIDDEN, "只能分享自己创建的对话")
    if not session.share_token:
        session.share_token = generate_token(16)
    session.is_public = True
    await db.flush()
    url = f"{settings.frontend_base_url.rstrip('/')}/share/chat/{session.share_token}"
    return session.share_token, url


async def unshare_session(db: AsyncSession, user: User, session_id: str) -> None:
    """关闭对话分享（旧链接立即失效，重开会签发新 token）。"""
    session = await access.get_session_for(db, user, session_id, "read")
    if session.user_id != user.id:
        raise AppError(ErrorCode.FORBIDDEN, "只能关闭自己创建的对话分享")
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
    db: AsyncSession, viewer: User, token: str
) -> ChatSession:
    """「基于这段对话继续创作」：把共享对话复制一份到访问者账号下。

    只复制**可复现的内容**（文字 + 提示词 + 参考图附件），不复制他人的画布与任务所有权；
    新会话会新建一块空白画布，访问者从零开始画，不会改到原作者的任何数据。
    """
    source, messages = await get_shared_session(db, token)
    # 复用会话建画布的逻辑（在访问者自己的项目下开一张空画布）
    from app.services import chat_service

    canvas_id = await chat_service._create_conversation_canvas(
        db, viewer, f"{source.title or '对话'}（来自分享）"
    )
    clone = ChatSession(
        id=new_id(),
        user_id=viewer.id,
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
                user_id=viewer.id,
                role=message.role,
                content=message.content,
                attachments=attachments,
            )
        )
    await db.flush()
    return clone


async def export_canvas(
    db: AsyncSession, user: User, canvas_id: str, fmt: str
) -> tuple[bytes, str, str]:
    """导出画布：返回 (content, media_type, filename)。"""
    canvas = await get_canvas(db, user, canvas_id, "read")
    if fmt == "json":
        content = json.dumps(
            {"id": canvas.id, "name": canvas.name, "state": canvas.state}, ensure_ascii=False
        ).encode("utf-8")
        return content, "application/json", f"canvas-{canvas.id}.json"
    # png
    content = None
    if canvas.thumbnail_url:
        from app.services.asset_service import local_path_from_url
        from app.services.storage_service import storage_root

        rel = local_path_from_url(canvas.thumbnail_url)
        if rel:
            candidate = storage_root() / rel
            if candidate.exists():
                # 画布缩略图可能较大，磁盘读取放到线程池，避免阻塞事件循环。
                content = await offload.run_sync(candidate.read_bytes)
    if content is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "画布暂无可导出的图片预览，请先保存画布")
    return content, "image/png", f"canvas-{canvas.id}.png"
