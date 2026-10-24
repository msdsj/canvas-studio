"""项目服务：CRUD（自动创建默认画布）。

归属校验走 `app.services.access`：团队项目对成员可见，个人项目仍然只有属主可见。
"""
from __future__ import annotations

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.canvas import Canvas
from app.models.project import CanvasProject
from app.models.user import User
from app.services import access, canvas_service, project_stats_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.project_service")


async def list_projects(
    db: AsyncSession, user: User, page: int, size: int, q: str | None = None
) -> tuple[list[dict], int]:
    """分页查询项目（附封面图 / 元素数 / 默认画布缩略图）。

    可见范围 = 本人 ∪ 当前团队共享项目。

    封面与元素数由 `project_stats_service.project_cards` 用 3 条 SQL 批量算完
    （原先对每个项目单独查一次缩略图，是典型 N+1）。
    """
    ctx = await access.current_context(db, user)
    conditions = [
        access.project_scope_clause(user, ctx),
        CanvasProject.deleted_at.is_(None),
    ]
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
    cards = await project_stats_service.project_cards(db, [project.id for project in projects])

    items: list[dict] = []
    for project in projects:
        card = cards.get(project.id, {})
        items.append(
            {
                "id": project.id,
                "owner_id": project.owner_id,
                "team_id": project.team_id,
                "visibility": project.visibility,
                "can_edit": project.owner_id == user.id
                or (project.team_id == ctx.team_id and ctx.has("canvas.edit.any")),
                "name": project.name,
                "description": project.description,
                "thumbnail_url": card.get("thumbnail_url"),
                # 封面 = 最新画布里最新的图片元素（资产缩略图 / 平台静态图）
                "cover_url": card.get("cover_url"),
                # 项目内元素数（不含已删除元素）
                "item_count": int(card.get("item_count") or 0),
                "created_at": project.created_at,
                "updated_at": project.updated_at,
            }
        )
    return items, total


async def project_card(db: AsyncSession, project_id: str) -> dict:
    """单个项目的卡片数据（封面 / 元素数 / 缩略图）。

    与列表页共用 `project_stats_service.project_cards`，详情页和列表页不会出现
    「同一个项目两处封面不一样」的问题。
    """
    cards = await project_stats_service.project_cards(db, [project_id])
    return cards.get(
        project_id, {"cover_url": None, "item_count": 0, "thumbnail_url": None}
    )


async def create_project(
    db: AsyncSession,
    user: User,
    name: str,
    description: str = "",
    *,
    with_default_canvas: bool = True,
    share_with_team: bool = False,
) -> CanvasProject:
    """新建项目；默认顺带建一块默认画布。

    - 画布是 Pro 能力：普通用户不给建默认画布，免得留下一堆打不开的孤儿画布；
    - `share_with_team=True` 且当前在团队里时，项目对团队可见（画布继承）。
    """
    ctx = await access.current_context(db, user)
    project = CanvasProject(
        id=new_id(), owner_id=user.id, name=name, description=description or ""
    )
    access.stamp_team(project, ctx, share=share_with_team)
    db.add(project)
    await db.flush()
    if with_default_canvas:
        await canvas_service.create_canvas(db, user, project.id, name=f"{name} · 默认画布")
    return project


async def get_project(
    db: AsyncSession, user: User, project_id: str, permission: str = "read"
) -> CanvasProject:
    """获取项目并校验访问权限。"""
    return await access.get_project_for(db, user, project_id, permission)  # type: ignore[arg-type]


async def update_project(
    db: AsyncSession, user: User, project_id: str, name: str | None
) -> CanvasProject:
    """更新项目名称。"""
    project = await get_project(db, user, project_id, "write")
    if name is not None:
        project.name = name
    project.updated_at = utcnow()
    await db.flush()
    return project


async def delete_project(db: AsyncSession, user: User, project_id: str) -> None:
    """软删除项目（连带关闭其画布的公开分享）。"""
    project = await get_project(db, user, project_id, "write")
    if project.owner_id != user.id:
        ctx = await access.current_context(db, user)
        if not ctx.has("canvas.edit.any"):
            raise AppError(ErrorCode.FORBIDDEN, "无权删除该项目")
    project.deleted_at = utcnow()
    canvases = await db.execute(select(Canvas).where(Canvas.project_id == project_id))
    for canvas in canvases.scalars().all():
        canvas.is_public = False
        canvas.share_token = None
    await db.flush()
