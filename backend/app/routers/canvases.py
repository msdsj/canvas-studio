"""画布路由 `/api/canvases/*` 与 `/api/share/*`。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from fastapi.responses import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_pro
from app.models.canvas import Canvas
from app.models.chat import ChatMessage, ChatSession
from app.models.generation import GenerationTask
from app.models.user import User
from app.schemas.canvas import CanvasOut, CanvasUpdateRequest
from app.services import canvas_service
from app.config import settings
from app.utils.errors import AppError, ErrorCode, envelope

router = APIRouter(prefix="/api", tags=["canvases"])


@router.get("/canvases/{canvas_id}")
async def get_canvas(
    canvas_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """获取画布（含 state）。"""
    canvas = await canvas_service.get_canvas(db, user, canvas_id)
    return envelope(CanvasOut.model_validate(canvas).model_dump())


@router.patch("/canvases/{canvas_id}")
async def update_canvas(
    canvas_id: str,
    payload: CanvasUpdateRequest,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """自动保存画布。"""
    canvas = await canvas_service.update_canvas(
        db, user, canvas_id, payload.name, payload.state, payload.thumbnail
    )
    await db.commit()
    return envelope({"updated_at": canvas.updated_at})


@router.delete("/canvases/{canvas_id}")
async def delete_canvas(
    canvas_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除画布。"""
    await canvas_service.delete_canvas(db, user, canvas_id)
    await db.commit()
    return envelope({})


@router.post("/canvases/{canvas_id}/share")
async def share_canvas(
    canvas_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """开启只读分享。"""
    token, url = await canvas_service.share_canvas(db, user, canvas_id)
    await db.commit()
    return envelope({"share_token": token, "url": url})


@router.delete("/canvases/{canvas_id}/share")
async def unshare_canvas(
    canvas_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """关闭分享。"""
    await canvas_service.unshare_canvas(db, user, canvas_id)
    await db.commit()
    return envelope({})


@router.get("/canvases/{canvas_id}/export")
async def export_canvas(
    canvas_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
    format: str = Query(default="json"),
) -> Response:
    """导出画布（png | json）。"""
    fmt = "png" if format == "png" else "json"
    content, media_type, filename = await canvas_service.export_canvas(db, user, canvas_id, fmt)
    return Response(
        content=content,
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/share/{token}")
async def get_shared_canvas(token: str, db: AsyncSession = Depends(get_db)) -> dict:
    """公开只读分享页（脱敏）。"""
    canvas = await canvas_service.get_shared(db, token)
    return envelope(
        {
            "id": canvas.id,
            "name": canvas.name,
            "state": canvas.state,
            "thumbnail_url": canvas.thumbnail_url,
            "updated_at": canvas.updated_at,
        }
    )


# ---------------------------------------------------------------------------
# 对话分享：把「一段对话」整份分享出去（消息 + 提示词 + 关联画布快照）
# ---------------------------------------------------------------------------
@router.post("/chat/sessions/{session_id}/share")
async def share_chat_session(
    session_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """开启对话分享，返回 {share_token, url}。"""
    token, url = await canvas_service.share_session(db, user, session_id)
    await db.commit()
    return envelope({"share_token": token, "url": url})


@router.get("/chat/sessions/{session_id}/share")
async def get_chat_session_share(
    session_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """当前会话的分享状态（刷新后仍能显示链接 / 关闭按钮）。"""
    session = (
        await db.execute(select(ChatSession).where(ChatSession.id == session_id))
    ).scalar_one_or_none()
    if session is None or session.user_id != user.id:
        raise AppError(ErrorCode.NOT_FOUND, "这段对话不存在")
    shared = bool(session.is_public and session.share_token)
    url = (
        f"{settings.frontend_base_url.rstrip('/')}/share/chat/{session.share_token}"
        if shared
        else ""
    )
    return envelope({"shared": shared, "url": url})


@router.delete("/chat/sessions/{session_id}/share")
async def unshare_chat_session(
    session_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """关闭对话分享。"""
    await canvas_service.unshare_session(db, user, session_id)
    await db.commit()
    return envelope({})


def _public_message(
    message: ChatMessage, results: dict[str, list[str]] | None = None
) -> dict:
    """分享出去的消息只保留可展示内容，丢掉执行态与内部 id。

    生成图必须留：这段对话"画出了什么"就靠它。图片存在任务表里，所以这里只把
    `prompt` 与结果图带到前台，思考链路、模型 id、额度消耗一律不进公开载荷。
    """
    attachments = []
    prompt = ""
    for item in message.attachments or []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("type") or "")
        if kind in {"compose_run", "skill_run"}:
            if kind == "compose_run" and not prompt:
                prompt = str(item.get("final_prompt") or "")
            continue
        attachments.append(item)
    return {
        "id": message.id,
        "role": message.role,
        "content": message.content,
        "attachments": attachments,
        "created_at": message.created_at,
        "prompt": prompt,
        "images": (results or {}).get(message.id, []),
    }


async def _collect_result_images(
    db: AsyncSession, messages: list[ChatMessage]
) -> dict[str, list[str]]:
    """按消息汇总「这一轮画出来的图」。

    消息 → compose_run 附件 → task_ids → 任务表 result_urls。
    只取成功任务的结果，失败/取消的任务不往公开页面上带。
    """
    wanted: dict[str, list[str]] = {}
    for message in messages:
        for item in message.attachments or []:
            if not isinstance(item, dict) or str(item.get("type")) != "compose_run":
                continue
            ids = [str(value) for value in (item.get("task_ids") or []) if value]
            if ids:
                wanted[message.id] = ids
    task_ids = sorted({task_id for ids in wanted.values() for task_id in ids})
    if not task_ids:
        return {}
    rows = (
        await db.execute(
            select(GenerationTask.id, GenerationTask.result_urls).where(
                GenerationTask.id.in_(task_ids),
                GenerationTask.status == "succeeded",
            )
        )
    ).all()
    urls_by_task = {
        str(row.id): [str(url) for url in (row.result_urls or []) if url] for row in rows
    }
    return {
        message_id: [url for task_id in ids for url in urls_by_task.get(task_id, [])]
        for message_id, ids in wanted.items()
    }


@router.get("/share/chat/{token}")
async def get_shared_chat(token: str, db: AsyncSession = Depends(get_db)) -> dict:
    """公开只读：对话详情（含消息、提示词与画布快照）。"""
    session, messages = await canvas_service.get_shared_session(db, token)
    results = await _collect_result_images(db, messages)
    canvas = None
    if session.canvas_id:
        row = (
            await db.execute(select(Canvas).where(Canvas.id == session.canvas_id))
        ).scalar_one_or_none()
        if row is not None:
            canvas = {
                "id": row.id,
                "name": row.name,
                "state": row.state,
                "thumbnail_url": row.thumbnail_url,
                "updated_at": row.updated_at,
            }
    return envelope(
        {
            "session_id": session.id,
            "title": session.title,
            "updated_at": session.updated_at,
            "messages": [_public_message(item, results) for item in messages],
            "canvas": canvas,
        }
    )


@router.post("/share/chat/{token}/fork")
async def fork_shared_chat(
    token: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """「基于这段对话继续创作」：复制一份到自己的账号下。"""
    clone = await canvas_service.fork_shared_session(db, user, token)
    await db.commit()
    return envelope({"session_id": clone.id, "canvas_id": clone.canvas_id})
