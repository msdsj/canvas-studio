"""项目服务：CRUD（自动创建默认画布）。"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.canvas import Canvas
from app.models.project import CanvasProject
from app.services import canvas_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.project_service")


async def list_projects(
    db: AsyncSession, owner_id: str, page: int, size: int, q: str | None = None
) -> tuple[list[dict], int]:
    """分页查询项目（附默认画布缩略图）。"""
    conditions = [CanvasProject.owner_id == owner_id, CanvasProject.deleted_at.is_(None)]
    if q:
        conditions.append(CanvasProject.name.like(f"%{q}%"))
    base = select(CanvasProject).where(*conditions)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(CanvasProject.updated_at.desc()).offset((page - 1) * size).limit(size)
    )
    projects = list(result.scalars().all())

    items: list[dict] = []
    for project in projects:
        thumb = await _project_thumbnail(db, project.id)
        items.append(
            {
                "id": project.id,
                "owner_id": project.owner_id,
                "name": project.name,
                "description": project.description,
                "thumbnail_url": thumb,
                "created_at": project.created_at,
                "updated_at": project.updated_at,
            }
        )
    return items, total


async def _project_thumbnail(db: AsyncSession, project_id: str) -> str | None:
    """取项目首个画布缩略图。"""
    result = await db.execute(
        select(Canvas.thumbnail_url)
        .where(Canvas.project_id == project_id)
        .order_by(Canvas.created_at.asc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def create_project(
    db: AsyncSession,
    owner_id: str,
    name: str,
    description: str = "",
    *,
    with_default_canvas: bool = True,
) -> CanvasProject:
    """新建项目；默认顺带建一块默认画布。

    画布是 Pro 能力：普通用户不给建默认画布，免得留下一堆打不开的孤儿画布。
    """
    project = CanvasProject(
        id=new_id(), owner_id=owner_id, name=name, description=description or ""
    )
    db.add(project)
    await db.flush()
    if with_default_canvas:
        await canvas_service.create_canvas(db, owner_id, project.id, name=f"{name} · 默认画布")
    return project


async def get_project(db: AsyncSession, owner_id: str, project_id: str) -> CanvasProject:
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


async def update_project(
    db: AsyncSession, owner_id: str, project_id: str, name: str | None
) -> CanvasProject:
    """更新项目名称。"""
    project = await get_project(db, owner_id, project_id)
    if name is not None:
        project.name = name
    project.updated_at = utcnow()
    await db.flush()
    return project


async def delete_project(db: AsyncSession, owner_id: str, project_id: str) -> None:
    """软删除项目（连带其画布）。"""
    project = await get_project(db, owner_id, project_id)
    project.deleted_at = utcnow()
    canvases = await db.execute(select(Canvas).where(Canvas.project_id == project_id))
    for canvas in canvases.scalars().all():
        canvas.is_public = False
        canvas.share_token = None
    await db.flush()
