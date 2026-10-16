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
