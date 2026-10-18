"""项目路由 `/api/projects/*`。"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user, is_unlocked, require_pro
from app.models.user import User
from app.schemas.canvas import CanvasOut, CanvasCreateRequest
from app.schemas.project import ProjectCreateRequest, ProjectUpdateRequest
from app.services import canvas_service, project_service
from app.utils.errors import envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/projects", tags=["projects"])


@router.get("")
async def list_projects(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
    q: str | None = Query(default=None),
) -> dict:
    """分页查询我的项目。"""
    page, size = normalize_page(page, size)
    items, total = await project_service.list_projects(db, user.id, page, size, q)
    return envelope(paginated(items, total, page, size))


@router.post("")
async def create_project(
    payload: ProjectCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """新建项目（Pro 用户顺带建默认画布）。"""
    project = await project_service.create_project(
        db,
        user.id,
        payload.name,
        payload.description or "",
        with_default_canvas=is_unlocked(user),
    )
    await db.commit()
    return envelope(
        {
            "id": project.id,
            "owner_id": project.owner_id,
            "name": project.name,
            "description": project.description,
            "thumbnail_url": None,
            "created_at": project.created_at,
            "updated_at": project.updated_at,
        }
    )


@router.get("/{project_id}")
async def get_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """获取项目详情（含画布列表）。"""
    project = await project_service.get_project(db, user.id, project_id)
    canvases = await canvas_service.list_by_project(db, user.id, project_id)
    return envelope(
        {
            "id": project.id,
            "owner_id": project.owner_id,
            "name": project.name,
            "description": project.description,
            "thumbnail_url": await project_service._project_thumbnail(db, project.id),
            "created_at": project.created_at,
            "updated_at": project.updated_at,
            "canvases": [CanvasOut.model_validate(c).model_dump() for c in canvases],
        }
    )


@router.patch("/{project_id}")
async def update_project(
    project_id: str,
    payload: ProjectUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """重命名项目。"""
    project = await project_service.update_project(db, user.id, project_id, payload.name)
    await db.commit()
    return envelope(
        {
            "id": project.id,
            "owner_id": project.owner_id,
            "name": project.name,
            "description": project.description,
            "updated_at": project.updated_at,
        }
    )


@router.delete("/{project_id}")
async def delete_project(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """软删除项目。"""
    await project_service.delete_project(db, user.id, project_id)
    await db.commit()
    return envelope({})


@router.get("/{project_id}/canvases")
async def list_canvases(
    project_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """列出项目下画布。"""
    canvases = await canvas_service.list_by_project(db, user.id, project_id)
    return envelope([CanvasOut.model_validate(c).model_dump() for c in canvases])


@router.post("/{project_id}/canvases")
async def create_canvas(
    project_id: str,
    payload: CanvasCreateRequest,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """在项目下新建画布（画布属 Pro 能力）。"""
    canvas = await canvas_service.create_canvas(db, user.id, project_id, payload.name)
    await db.commit()
    return envelope(CanvasOut.model_validate(canvas).model_dump())
