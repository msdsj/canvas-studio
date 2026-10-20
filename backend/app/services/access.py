"""统一访问控制：团队上下文、成员权限、资源可见性。

为什么要有这一层
----------------
团队版之前，「能不能看 / 能不能改」散落在 6 个 service 里，全是
`if canvas.owner_id != user.id: raise FORBIDDEN`。加入团队后，同一个资源可能有
三类合法访问者（属主 / 团队成员 / 显式协作者），如果继续在每处手写判断，
必然出现「某个接口忘了改」的越权漏洞。

因此这里提供**唯一入口**：
- `TeamContext`：一次请求内的团队上下文（当前团队 + 成员 + 有效权限）；
- `require_*` 系列：读/写画布、项目、资产、对话；
- 判定顺序固定为「属主 → 团队 → 协作者 → 公开分享」，任何人不必再自己推。

错误语义
--------
- **资源存在但你没权限** → 403 `FORBIDDEN`：这是团队版之前就有的契约，前端已按它
  渲染「这部分内容你没有权限」，改成 404 会让老用户看到「画布不存在」而困惑；
- **资源不存在 / 你不在这个团队** → 404 `NOT_FOUND`：团队 id 是可枚举的短标识，
  对非成员必须表现得像「没有这个团队」，否则能被用来探测企业是否在用本平台。

资源 id 是 UUIDv4，靠 403/404 差异探测存在性在实践中不可行，所以这里优先保住
既有契约的一致性，而不是追求理论上的零信息泄漏。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.asset import Asset
from app.models.canvas import Canvas
from app.models.chat import ChatSession
from app.models.collaboration import COLLAB_EDITOR, CanvasCollaborator
from app.models.project import CanvasProject
from app.models.team import (
    MEMBER_ACTIVE,
    TEAM_ROLE_OWNER,
    Team,
    TeamMember,
)
from app.models.user import User
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.access")

Access = Literal["read", "write", "manage"]


@dataclass(slots=True)
class TeamContext:
    """一次请求内的团队上下文。

    `team` 为 None 表示个人空间：此时所有判定退化为「属主即唯一合法访问者」，
    与团队版之前的行为完全一致（这是兼容性的关键）。
    """

    team: Team | None = None
    member: TeamMember | None = None
    permissions: dict[str, bool] = field(default_factory=dict)

    @property
    def team_id(self) -> str | None:
        return self.team.id if self.team is not None else None

    @property
    def is_owner(self) -> bool:
        return bool(self.member and self.member.role == TEAM_ROLE_OWNER)

    def has(self, permission: str) -> bool:
        return bool(self.permissions.get(permission, False))


async def get_membership(db: AsyncSession, user_id: str, team_id: str) -> TeamMember | None:
    """取某人在某团队中的**有效**成员记录（停用/邀请中不算）。"""
    result = await db.execute(
        select(TeamMember).where(
            TeamMember.team_id == team_id,
            TeamMember.user_id == user_id,
            TeamMember.status == MEMBER_ACTIVE,
        )
    )
    return result.scalar_one_or_none()


async def load_team(db: AsyncSession, team_id: str | None) -> Team | None:
    """按 id 取未删除的团队。"""
    if not team_id:
        return None
    result = await db.execute(
        select(Team).where(Team.id == team_id, Team.deleted_at.is_(None))
    )
    return result.scalar_one_or_none()


async def resolve_context(
    db: AsyncSession,
    user: User,
    *,
    team_id: str | None = None,
    explicit: bool = False,
) -> TeamContext:
    """解析团队上下文。

    - `explicit=True`：调用方显式指定了 team_id（如 `/api/teams/{id}/...`），
      此时不回落个人空间——不是成员就直接 404，避免「传了 id 却悄悄按个人处理」。
    - `explicit=False`：使用 `users.active_team_id`；如果用户已被移出该团队，
      静默回落个人空间并清空 active_team_id（否则用户会卡在一个打不开的团队里）。
    """
    target = team_id if explicit else user.active_team_id
    if not target:
        return TeamContext()
    team = await load_team(db, target)
    if team is None:
        if explicit:
            raise AppError(ErrorCode.NOT_FOUND, "团队不存在")
        user.active_team_id = None
        await db.flush()
        return TeamContext()
    member = await get_membership(db, user.id, team.id)
    if member is None:
        if explicit:
            raise AppError(ErrorCode.NOT_FOUND, "团队不存在")
        user.active_team_id = None
        await db.flush()
        return TeamContext()
    return TeamContext(team=team, member=member, permissions=member.effective_permissions())


async def current_context(db: AsyncSession, user: User) -> TeamContext:
    """当前生效的团队上下文（最常用入口）。"""
    return await resolve_context(db, user)


async def has_active_team(db: AsyncSession, user: User) -> bool:
    """用户是否在某个有效团队里（用于「团队成员自动解锁 Pro 能力」判定）。

    只查 `team_members`，不看 `users.active_team_id`：只要他属于任何一个团队，
    就算此刻切到了个人空间，也应保留已购买的能力——否则「切回个人空间就掉权限」
    会让人以为账号出问题。
    """
    result = await db.execute(
        select(TeamMember.id)
        .join(Team, Team.id == TeamMember.team_id)
        .where(
            TeamMember.user_id == user.id,
            TeamMember.status == MEMBER_ACTIVE,
            Team.deleted_at.is_(None),
        )
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


def require_permission(ctx: TeamContext, permission: str) -> None:
    """要求上下文具备某权限，否则 403。"""
    if not ctx.has(permission):
        raise AppError(ErrorCode.FORBIDDEN, "你在当前团队没有这项权限")


def require_owner(ctx: TeamContext) -> None:
    """要求团队超级管理员（owner）。"""
    if not ctx.is_owner:
        raise AppError(ErrorCode.MODEL_CONFIG_FORBIDDEN)


# --------------------------------------------------------------------------- #
# 资源可见性
# --------------------------------------------------------------------------- #
async def _collaborator_role(
    db: AsyncSession, canvas_id: str, user_id: str
) -> str | None:
    """画布显式授权角色。"""
    result = await db.execute(
        select(CanvasCollaborator.role).where(
            CanvasCollaborator.canvas_id == canvas_id,
            CanvasCollaborator.user_id == user_id,
        )
    )
    return result.scalar_one_or_none()


def _team_shared(resource: object, ctx: TeamContext) -> bool:
    """资源是否属于当前团队且对团队可见。"""
    if ctx.team is None:
        return False
    if getattr(resource, "team_id", None) != ctx.team.id:
        return False
    return getattr(resource, "visibility", "private") == "team"


async def can_access_canvas(
    db: AsyncSession, user: User, canvas: Canvas, access: Access, ctx: TeamContext
) -> bool:
    """画布访问判定。

    规则（自上而下命中即返回）：
    1. 属主：读写都行（删不删由 `manage` 决定，属主永远可以）；
    2. 团队成员 + 团队可见：
       - read：所有成员；
       - write：`canvas.edit.any`，或本人是显式协作者 editor；
       - manage：owner/admin 或属主；
    3. 显式协作者：editor 可写，viewer 只读；
    4. 公开分享（仅 read）。
    """
    if canvas.owner_id == user.id:
        return True
    if _team_shared(canvas, ctx):
        if access == "read":
            return ctx.has("team.resource.view")
        if access == "write":
            if ctx.has("canvas.edit.any"):
                return True
            return await _collaborator_role(db, canvas.id, user.id) == COLLAB_EDITOR
        return ctx.has("canvas.edit.any") and ctx.member is not None and ctx.member.role in (
            TEAM_ROLE_OWNER,
            "admin",
        )
    role = await _collaborator_role(db, canvas.id, user.id)
    if role == COLLAB_EDITOR:
        return access in ("read", "write")
    if role is not None:
        return access == "read"
    if access == "read":
        return bool(canvas.is_public and canvas.share_token)
    return False


async def get_canvas_for(
    db: AsyncSession, user: User, canvas_id: str, access: Access = "read"
) -> Canvas:
    """取画布并按访问级别校验。"""
    result = await db.execute(select(Canvas).where(Canvas.id == canvas_id))
    canvas = result.scalar_one_or_none()
    if canvas is None:
        raise AppError(ErrorCode.NOT_FOUND, "画布不存在")
    ctx = await current_context(db, user)
    if not await can_access_canvas(db, user, canvas, access, ctx):
        raise AppError(ErrorCode.FORBIDDEN, "无权访问该画布")
    return canvas


def canvas_writable(canvas: Canvas, user: User, ctx: TeamContext) -> bool:
    """同步快速判定（不含协作者查询）：用于列表接口给每行标注 can_edit。"""
    if canvas.owner_id == user.id:
        return True
    if _team_shared(canvas, ctx):
        return ctx.has("canvas.edit.any")
    return False


async def get_project_for(
    db: AsyncSession, user: User, project_id: str, access: Access = "read"
) -> CanvasProject:
    """取项目并校验访问。"""
    result = await db.execute(
        select(CanvasProject).where(
            CanvasProject.id == project_id, CanvasProject.deleted_at.is_(None)
        )
    )
    project = result.scalar_one_or_none()
    if project is None:
        raise AppError(ErrorCode.NOT_FOUND, "项目不存在")
    ctx = await current_context(db, user)
    if project.owner_id == user.id:
        return project
    if _team_shared(project, ctx):
        if access == "read":
            return project
        if access == "write" and ctx.has("canvas.edit.any"):
            return project
        raise AppError(ErrorCode.FORBIDDEN, "你在当前团队没有编辑该项目的权限")
    raise AppError(ErrorCode.FORBIDDEN, "无权访问该项目")


async def get_asset_for(
    db: AsyncSession, user: User, asset_id: str, access: Access = "read"
) -> Asset:
    """取资产并校验访问（团队素材：团队成员可读，`asset.manage` 可删）。"""
    result = await db.execute(
        select(Asset).where(Asset.id == asset_id, Asset.deleted_at.is_(None))
    )
    asset = result.scalar_one_or_none()
    if asset is None:
        raise AppError(ErrorCode.NOT_FOUND, "资产不存在")
    if asset.owner_id == user.id:
        return asset
    ctx = await current_context(db, user)
    if _team_shared(asset, ctx):
        if access == "read":
            return asset
        if ctx.has("asset.manage"):
            return asset
        raise AppError(ErrorCode.FORBIDDEN, "你在当前团队没有管理素材的权限")
    raise AppError(ErrorCode.FORBIDDEN, "无权访问该资产")


async def get_session_for(
    db: AsyncSession, user: User, session_id: str, access: Access = "read"
) -> ChatSession:
    """取对话会话并校验访问。"""
    result = await db.execute(
        select(ChatSession).where(
            ChatSession.id == session_id, ChatSession.deleted_at.is_(None)
        )
    )
    session = result.scalar_one_or_none()
    if session is None:
        raise AppError(ErrorCode.NOT_FOUND, "对话不存在")
    if session.user_id == user.id:
        return session
    ctx = await current_context(db, user)
    if _team_shared(session, ctx) and access == "read":
        return session
    raise AppError(ErrorCode.FORBIDDEN, "无权访问该会话")


# --------------------------------------------------------------------------- #
# 列表过滤条件（供各 service 的 select 直接拼接）
# --------------------------------------------------------------------------- #
def canvas_scope_clause(user: User, ctx: TeamContext):
    """画布列表的可见范围：本人 ∪ 当前团队可见（团队上下文为空时退化为本人）。"""
    from sqlalchemy import or_

    clauses = [Canvas.owner_id == user.id]
    if ctx.team is not None and ctx.has("team.resource.view"):
        clauses.append((Canvas.team_id == ctx.team.id) & (Canvas.visibility == "team"))
    return or_(*clauses)


def asset_scope_clause(user: User, ctx: TeamContext):
    """资产列表的可见范围。"""
    from sqlalchemy import or_

    clauses = [Asset.owner_id == user.id]
    if ctx.team is not None and ctx.has("team.resource.view"):
        clauses.append((Asset.team_id == ctx.team.id) & (Asset.visibility == "team"))
    return or_(*clauses)


def project_scope_clause(user: User, ctx: TeamContext):
    """项目列表的可见范围。"""
    from sqlalchemy import or_

    from app.models.project import CanvasProject

    clauses = [CanvasProject.owner_id == user.id]
    if ctx.team is not None and ctx.has("team.resource.view"):
        clauses.append(
            (CanvasProject.team_id == ctx.team.id) & (CanvasProject.visibility == "team")
        )
    return or_(*clauses)


def session_scope_clause(user: User, ctx: TeamContext):
    """对话列表的可见范围。"""
    from sqlalchemy import or_

    clauses = [ChatSession.user_id == user.id]
    if ctx.team is not None and ctx.has("team.resource.view"):
        clauses.append(
            (ChatSession.team_id == ctx.team.id) & (ChatSession.visibility == "team")
        )
    return or_(*clauses)


def stamp_team(resource: object, ctx: TeamContext, *, share: bool) -> None:
    """新建资源时打上团队标记。

    `share=True` 表示「团队内共享」（visibility='team'）；否则保持私有，
    但**仍然记录 team_id**——这样团队用量统计与资源归属能对上，
    而是否共享由用户后续显式决定（默认私有，不会把个人草稿突然公开给同事）。
    """
    if ctx.team is None:
        return
    if getattr(resource, "team_id", None):
        return
    resource.team_id = ctx.team.id
    if share and hasattr(resource, "visibility"):
        resource.visibility = "team"


def team_today_bounds() -> tuple[datetime, datetime]:
    """团队用量统计用的今日区间（UTC）。"""
    from app.utils.ids import utcnow

    now = utcnow()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    return start, now
