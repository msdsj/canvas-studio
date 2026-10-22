"""团队服务：创建 / 成员 / 邀请 / 权限 / 用量 / 模型配置。

三条不变量（改这里之前先读一遍）
--------------------------------
1. **一个团队必须且只能有一个 owner**。转让是「先把新人升为 owner，再把老人降为
   admin」在同一事务里完成；owner 不能被直接删除或降级，只能先转让。
2. **席位 = 活跃成员 + 待接受邀请**。只看活跃成员的话，管理员可以无限发邀请，
   接受时才发现超员，用户体验极差；把待接受也算进去，邀请时就能拦住。
3. **模型配置只有 owner 能写**。`/api/teams/{id}/model-config` 的写操作必须走
   `require_owner()`；成员读接口只返回脱敏状态（是否有配置、模型名、来源）。
"""
from __future__ import annotations

import re
import secrets
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ai_provider import AIProvider
from app.models.generation import GenerationTask
from app.models.quota import QuotaTransaction
from app.models.team import (
    DEFAULT_PERMISSIONS,
    MEMBER_ACTIVE,
    MEMBER_DISABLED,
    MEMBER_INVITED,
    PERMISSION_KEYS,
    TEAM_ROLE_ADMIN,
    TEAM_ROLE_MEMBER,
    TEAM_ROLE_OWNER,
    TEAM_ROLES,
    Team,
    TeamInvitation,
    TeamMember,
)
from app.models.user import User
from app.services import access, audit_service, email_service, quota_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.team_service")

#: 邀请有效期（天）
INVITE_TTL_DAYS = 7
#: 席位上限的硬性护栏，避免误操作把 seat_limit 设成天文数字
MAX_SEAT_LIMIT = 500
#: 团队共享池默认赠送额度（开启共享池时给一笔启动额度，避免「刚开就不可用」）
TEAM_INITIAL_GRANT = 2000


def slugify(name: str) -> str:
    """把团队名转成可用的 slug 基座。"""
    base = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")
    if not base:
        # 纯中文名转出来是空的：用随机后缀兜底，slug 只用于展示与链接，不承载语义
        base = f"team-{secrets.token_hex(3)}"
    return base[:48]


async def _unique_slug(db: AsyncSession, name: str) -> str:
    """生成不冲突的 slug（冲突时追加 4 位随机后缀）。"""
    base = slugify(name)
    exists = (
        await db.execute(select(Team.id).where(Team.slug == base))
    ).scalar_one_or_none()
    if exists is None:
        return base
    for _ in range(8):
        candidate = f"{base}-{secrets.token_hex(2)}"
        if (
            await db.execute(select(Team.id).where(Team.slug == candidate))
        ).scalar_one_or_none() is None:
            return candidate
    return f"team-{secrets.token_hex(6)}"


# --------------------------------------------------------------------------- #
# 创建 / 读取 / 切换
# --------------------------------------------------------------------------- #
async def create_team(
    db: AsyncSession,
    owner: User,
    name: str,
    *,
    seat_limit: int = 5,
    shared_quota: bool = False,
) -> Team:
    """创建团队：创建者即超级管理员（owner），并自动切到该团队。"""
    clean = (name or "").strip()
    if len(clean) < 2:
        raise AppError(ErrorCode.VALIDATION_ERROR, "团队名称至少 2 个字")
    if len(clean) > 60:
        raise AppError(ErrorCode.VALIDATION_ERROR, "团队名称最多 60 个字")
    if owner.active_team_id and await access.get_membership(db, owner.id, owner.active_team_id):
        # 已经在一个团队里还继续建团：允许（一个人可能管多个团队），但提示当前团队会被切换
        logger.info("用户 %s 在当前团队中继续创建新团队", owner.id)

    team = Team(
        id=new_id(),
        name=clean,
        slug=await _unique_slug(db, clean),
        owner_user_id=owner.id,
        seat_limit=max(1, min(int(seat_limit), MAX_SEAT_LIMIT)),
        status="active",
        settings={"shared_quota": bool(shared_quota), "allow_personal_provider": False},
        balance=0,
    )
    db.add(team)
    await db.flush()

    db.add(
        TeamMember(
            id=new_id(),
            team_id=team.id,
            user_id=owner.id,
            role=TEAM_ROLE_OWNER,
            status=MEMBER_ACTIVE,
            permissions={},
        )
    )
    await db.flush()

    if shared_quota:
        await quota_service.grant(
            db,
            owner.id,
            TEAM_INITIAL_GRANT,
            note="团队创建赠送",
            tx_type="team_grant",
            team=team,
        )

    owner.active_team_id = team.id
    await db.flush()
    await audit_service.log(
        db,
        action="team.create",
        actor=owner,
        team_id=team.id,
        target_type="team",
        target_id=team.id,
        detail={"name": team.name, "seat_limit": team.seat_limit},
    )
    return team


async def list_my_teams(db: AsyncSession, user_id: str) -> list[dict[str, Any]]:
    """我加入的团队（含角色与成员数）。"""
    rows = (
        await db.execute(
            select(TeamMember, Team)
            .join(Team, Team.id == TeamMember.team_id)
            .where(
                TeamMember.user_id == user_id,
                TeamMember.status == MEMBER_ACTIVE,
                Team.deleted_at.is_(None),
            )
            .order_by(Team.created_at.asc())
        )
    ).all()
    result: list[dict[str, Any]] = []
    for member, team in rows:
        count = int(
            (
                await db.execute(
                    select(func.count()).where(
                        TeamMember.team_id == team.id,
                        TeamMember.status == MEMBER_ACTIVE,
                    )
                )
            ).scalar()
            or 0
        )
        result.append(
            {
                "id": team.id,
                "name": team.name,
                "slug": team.slug,
                "role": member.role,
                "seat_limit": team.seat_limit,
                "member_count": count,
                "plan": team.plan,
                "shared_quota": team.shared_quota(),
                "is_owner": member.role == TEAM_ROLE_OWNER,
            }
        )
    return result


async def get_context(
    db: AsyncSession, user: User, team_id: str
) -> access.TeamContext:
    """取团队上下文（非成员按 404 处理，不泄漏团队是否存在）。"""
    return await access.resolve_context(db, user, team_id=team_id, explicit=True)


async def get_team_detail(db: AsyncSession, ctx: access.TeamContext) -> dict[str, Any]:
    """团队详情（成员可见）。"""
    team = ctx.team
    assert team is not None
    active = int(
        (
            await db.execute(
                select(func.count()).where(
                    TeamMember.team_id == team.id, TeamMember.status == MEMBER_ACTIVE
                )
            )
        ).scalar()
        or 0
    )
    pending = int(
        (
            await db.execute(
                select(func.count()).where(
                    TeamInvitation.team_id == team.id, TeamInvitation.status == "pending"
                )
            )
        ).scalar()
        or 0
    )
    return {
        "id": team.id,
        "name": team.name,
        "slug": team.slug,
        "role": ctx.member.role if ctx.member else None,
        "status": team.status,
        "plan": team.plan,
        "seat_limit": team.seat_limit,
        "seat_used": active + pending,
        "member_count": active,
        "pending_invites": pending,
        "shared_quota": team.shared_quota(),
        "allow_personal_provider": team.allow_personal_provider(),
        "balance": team.balance,
        "permissions": ctx.permissions,
        "owner_user_id": team.owner_user_id,
        "created_at": team.created_at,
    }


async def update_team(
    db: AsyncSession,
    ctx: access.TeamContext,
    user: User,
    *,
    name: str | None = None,
    seat_limit: int | None = None,
    shared_quota: bool | None = None,
) -> Team:
    """修改团队设置（仅 owner）。"""
    access.require_owner(ctx)
    team = ctx.team
    assert team is not None
    if name is not None:
        clean = name.strip()
        if len(clean) < 2:
            raise AppError(ErrorCode.VALIDATION_ERROR, "团队名称至少 2 个字")
        team.name = clean[:60]
    if seat_limit is not None:
        used = await seat_usage(db, team.id)
        if seat_limit < used:
            raise AppError(
                ErrorCode.VALIDATION_ERROR,
                f"当前已占用 {used} 个席位，不能小于这个数",
            )
        team.seat_limit = max(1, min(int(seat_limit), MAX_SEAT_LIMIT))
    settings = team.settings_dict()
    if shared_quota is not None:
        if shared_quota and not team.shared_quota():
            # 首次开启共享池：给一笔启动额度，否则成员一进来就「额度不足」
            await quota_service.grant(
                db,
                user.id,
                TEAM_INITIAL_GRANT,
                note="开启团队共享额度",
                tx_type="team_grant",
                team=team,
            )
        settings["shared_quota"] = bool(shared_quota)
    team.settings = settings
    team.updated_at = utcnow()
    await db.flush()
    await audit_service.log(
        db,
        action="team.update",
        actor=user,
        team_id=team.id,
        target_type="team",
        target_id=team.id,
        detail={"name": team.name, "seat_limit": team.seat_limit, "settings": settings},
    )
    return team


async def set_active_team(db: AsyncSession, user: User, team_id: str | None) -> None:
    """切换当前团队（None = 个人空间）。"""
    if team_id is None:
        user.active_team_id = None
        await db.flush()
        return
    team = await access.load_team(db, team_id)
    if team is None or await access.get_membership(db, user.id, team_id) is None:
        raise AppError(ErrorCode.NOT_FOUND, "团队不存在")
    user.active_team_id = team.id
    await db.flush()


async def seat_usage(db: AsyncSession, team_id: str) -> int:
    """已占用席位 = 活跃成员 + 待接受邀请。"""
    active = int(
        (
            await db.execute(
                select(func.count()).where(
                    TeamMember.team_id == team_id, TeamMember.status == MEMBER_ACTIVE
                )
            )
        ).scalar()
        or 0
    )
    pending = int(
        (
            await db.execute(
                select(func.count()).where(
                    TeamInvitation.team_id == team_id, TeamInvitation.status == "pending"
                )
            )
        ).scalar()
        or 0
    )
    return active + pending


# --------------------------------------------------------------------------- #
# 成员
# --------------------------------------------------------------------------- #
async def list_members(db: AsyncSession, ctx: access.TeamContext) -> list[dict[str, Any]]:
    """成员列表（含邮箱、角色、状态、最后活跃）。"""
    team = ctx.team
    assert team is not None
    rows = (
        await db.execute(
            select(TeamMember, User)
            .join(User, User.id == TeamMember.user_id)
            .where(TeamMember.team_id == team.id)
            .order_by(TeamMember.created_at.asc())
        )
    ).all()
    return [
        {
            "id": member.id,
            "user_id": member.user_id,
            "email": user.email,
            "display_name": user.display_name or user.email.split("@")[0],
            "role": member.role,
            "status": member.status,
            "permissions": member.effective_permissions(),
            "is_owner": member.role == TEAM_ROLE_OWNER,
            "joined_at": member.joined_at,
            "last_login_at": user.last_login_at,
        }
        for member, user in rows
    ]


async def _get_member(db: AsyncSession, team_id: str, member_id: str) -> TeamMember:
    """按 id 取成员（必须属于该团队）。"""
    result = await db.execute(
        select(TeamMember).where(
            TeamMember.id == member_id, TeamMember.team_id == team_id
        )
    )
    member = result.scalar_one_or_none()
    if member is None:
        raise AppError(ErrorCode.NOT_FOUND, "这位成员不在团队里")
    return member


def _validate_role(role: str) -> str:
    if role not in TEAM_ROLES:
        raise AppError(ErrorCode.VALIDATION_ERROR, "角色只能是 owner / admin / member")
    return role


def _clean_permissions(raw: dict[str, Any] | None) -> dict[str, bool]:
    """只保留已知权限键的布尔值，防止脏数据放大权限。"""
    if not raw:
        return {}
    return {
        key: bool(value)
        for key, value in raw.items()
        if key in DEFAULT_PERMISSIONS and isinstance(value, bool)
    }


async def update_member(
    db: AsyncSession,
    ctx: access.TeamContext,
    actor: User,
    member_id: str,
    *,
    role: str | None = None,
    status: str | None = None,
    permissions: dict[str, Any] | None = None,
) -> TeamMember:
    """改成员角色 / 状态 / 权限覆盖。"""
    access.require_permission(ctx, "member.manage")
    team = ctx.team
    assert team is not None
    member = await _get_member(db, team.id, member_id)

    if member.role == TEAM_ROLE_OWNER:
        # owner 只能通过「转让」变更，避免出现零 owner 或权限被自己锁死
        raise AppError(ErrorCode.VALIDATION_ERROR, "超级管理员只能通过转让来变更")
    if member.user_id == actor.id and role is not None and role != member.role:
        raise AppError(ErrorCode.VALIDATION_ERROR, "不能修改自己的角色")
    # 只有 owner 能任命 admin：否则 admin 可以无限扩大自己的阵营
    if role == TEAM_ROLE_ADMIN and not ctx.is_owner:
        raise AppError(ErrorCode.FORBIDDEN, "只有超级管理员可以任命团队管理员")
    if role == TEAM_ROLE_OWNER:
        raise AppError(ErrorCode.VALIDATION_ERROR, "超级管理员只能通过转让来变更")

    if role is not None:
        member.role = _validate_role(role)
    if status is not None:
        if status not in (MEMBER_ACTIVE, MEMBER_DISABLED, MEMBER_INVITED):
            raise AppError(ErrorCode.VALIDATION_ERROR, "成员状态不合法")
        if status == MEMBER_ACTIVE and member.status != MEMBER_ACTIVE:
            if await seat_usage(db, team.id) > team.seat_limit:
                raise AppError(ErrorCode.SEAT_LIMIT_EXCEEDED)
        member.status = status
    if permissions is not None:
        # owner 的权限是恒真的，不接受覆盖；非 owner 也不能把 model.configure 授出去
        cleaned = _clean_permissions(permissions)
        if not ctx.is_owner:
            cleaned.pop("model.configure", None)
            cleaned.pop("team.manage", None)
            cleaned.pop("quota.adjust", None)
        member.permissions = cleaned
    member.updated_at = utcnow()
    await db.flush()
    await audit_service.log(
        db,
        action="team.member.update",
        actor=actor,
        team_id=team.id,
        target_type="team_member",
        target_id=member.id,
        detail={"role": member.role, "status": member.status, "permissions": member.permissions},
    )
    return member


async def remove_member(
    db: AsyncSession,
    ctx: access.TeamContext,
    actor: User,
    member_id: str,
    *,
    self_leave: bool = False,
) -> None:
    """移除成员（或成员自己退出）。

    退出的成员如果 `active_team_id` 正指向该团队，需要清空，否则他会卡在一个
    打不开的团队上下文里（`resolve_context` 虽有兜底，但主动清理更干净）。
    """
    team = ctx.team
    assert team is not None
    member = await _get_member(db, team.id, member_id)
    if member.role == TEAM_ROLE_OWNER:
        raise AppError(ErrorCode.VALIDATION_ERROR, "超级管理员不能退出团队，请先转让")
    if not self_leave:
        access.require_permission(ctx, "member.manage")
        if member.user_id == actor.id:
            raise AppError(ErrorCode.VALIDATION_ERROR, "退出团队请使用退出接口")

    await db.delete(member)
    if not self_leave:
        # 被移除的成员若正处于该团队，帮他切回个人空间
        target = await db.get(User, member.user_id)
        if target is not None and target.active_team_id == team.id:
            target.active_team_id = None
    await db.flush()
    await audit_service.log(
        db,
        action="team.member.remove",
        actor=actor,
        team_id=team.id,
        target_type="team_member",
        target_id=member.user_id,
        detail={"self_leave": self_leave},
    )


async def transfer_owner(
    db: AsyncSession, ctx: access.TeamContext, actor: User, member_id: str
) -> None:
    """转让超级管理员。

    顺序很重要：先降级旧 owner 再升级新 owner，中间任何一步失败都会留下
    「零 owner」团队；因此这里先提升新人、再降级老人。
    """
    access.require_owner(ctx)
    team = ctx.team
    assert team is not None
    target = await _get_member(db, team.id, member_id)
    if target.status != MEMBER_ACTIVE:
        raise AppError(ErrorCode.VALIDATION_ERROR, "只能转让给在团队中的成员")
    if target.role == TEAM_ROLE_OWNER:
        return
    current = await access.get_membership(db, actor.id, team.id)
    if current is None:
        raise AppError(ErrorCode.FORBIDDEN)
    target.role = TEAM_ROLE_OWNER
    target.permissions = {}
    current.role = TEAM_ROLE_ADMIN
    team.owner_user_id = target.user_id
    await db.flush()
    await audit_service.log(
        db,
        action="team.transfer_owner",
        actor=actor,
        team_id=team.id,
        target_type="team_member",
        target_id=target.user_id,
        detail={"from": actor.id, "to": target.user_id},
    )


# --------------------------------------------------------------------------- #
# 邀请
# --------------------------------------------------------------------------- #
async def create_invitation(
    db: AsyncSession,
    ctx: access.TeamContext,
    actor: User,
    email: str,
    role: str = TEAM_ROLE_MEMBER,
    note: str = "",
) -> TeamInvitation:
    """发出邀请。

    - 席位已满（活跃 + 待接受）直接拒绝，不留「接受时才失败」的坑；
    - 已是成员：明确告知，不重复发；
    - 同一邮箱已有未过期邀请：复用并刷新有效期；无邮箱邀请每次创建独立链接。
    """
    access.require_permission(ctx, "member.manage")
    team = ctx.team
    assert team is not None
    clean = (email or "").strip().lower()
    if clean and ("@" not in clean or "." not in clean.split("@")[-1]):
        raise AppError(ErrorCode.VALIDATION_ERROR, "邮箱格式不对")
    if role == TEAM_ROLE_OWNER:
        raise AppError(ErrorCode.VALIDATION_ERROR, "邀请只能是 admin 或 member")
    if role == TEAM_ROLE_ADMIN and not ctx.is_owner:
        raise AppError(ErrorCode.FORBIDDEN, "只有超级管理员可以邀请团队管理员")
    _validate_role(role)

    # 已是成员
    existing_user = None
    if clean:
        existing_user = (
            await db.execute(select(User).where(User.email == clean))
        ).scalar_one_or_none()
    if existing_user is not None:
        member = await access.get_membership(db, existing_user.id, team.id)
        if member is not None:
            raise AppError(ErrorCode.VALIDATION_ERROR, "这个人已经是团队成员了")

    if await seat_usage(db, team.id) >= team.seat_limit:
        raise AppError(ErrorCode.SEAT_LIMIT_EXCEEDED)

    pending = None
    if clean:
        pending = (
            await db.execute(
                select(TeamInvitation).where(
                    TeamInvitation.team_id == team.id,
                    TeamInvitation.email == clean,
                    TeamInvitation.status == "pending",
                )
            )
        ).scalar_one_or_none()
    expires = utcnow() + timedelta(days=INVITE_TTL_DAYS)
    if pending is not None and pending.expires_at > utcnow():
        pending.role = role
        pending.note = note or pending.note
        pending.expires_at = expires
        invitation = pending
    else:
        if pending is not None:
            pending.status = "expired"
        invitation = TeamInvitation(
            id=new_id(),
            team_id=team.id,
            email=clean,
            role=role,
            token=secrets.token_urlsafe(24),
            status="pending",
            note=note or "",
            invited_by=actor.id,
            expires_at=expires,
        )
        db.add(invitation)
    await db.flush()
    await audit_service.log(
        db,
        action="team.invite",
        actor=actor,
        team_id=team.id,
        target_type="team_invitation",
        target_id=invitation.id,
        detail={"email": clean, "role": role},
    )
    return invitation


async def list_invitations(
    db: AsyncSession, ctx: access.TeamContext
) -> list[dict[str, Any]]:
    """待处理邀请列表。"""
    access.require_permission(ctx, "member.manage")
    team = ctx.team
    assert team is not None
    rows = (
        await db.execute(
            select(TeamInvitation)
            .where(TeamInvitation.team_id == team.id, TeamInvitation.status == "pending")
            .order_by(TeamInvitation.created_at.desc())
        )
    ).scalars().all()
    now = utcnow()
    return [
        {
            "id": row.id,
            "email": row.email,
            "token": row.token,
            "role": row.role,
            "status": "expired" if row.expires_at <= now else row.status,
            "note": row.note,
            "expires_at": row.expires_at,
            "created_at": row.created_at,
        }
        for row in rows
    ]


async def revoke_invitation(
    db: AsyncSession, ctx: access.TeamContext, actor: User, invitation_id: str
) -> None:
    """撤销邀请（释放席位）。"""
    access.require_permission(ctx, "member.manage")
    team = ctx.team
    assert team is not None
    row = (
        await db.execute(
            select(TeamInvitation).where(
                TeamInvitation.id == invitation_id, TeamInvitation.team_id == team.id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "这条邀请不存在")
    row.status = "revoked"
    await db.flush()
    await audit_service.log(
        db,
        action="team.invite.revoke",
        actor=actor,
        team_id=team.id,
        target_type="team_invitation",
        target_id=row.id,
        detail={"email": row.email},
    )


async def accept_invitation(db: AsyncSession, user: User, token: str) -> Team:
    """接受邀请加入团队。

    令牌与邮箱绑定：登录邮箱与邀请邮箱不一致时拒绝，防止链接被转发后
    「谁点谁进」。已注册用户直接加入；团队已满则明确报席位不足。
    """
    clean = (token or "").strip()
    if not clean:
        raise AppError(ErrorCode.VALIDATION_ERROR, "邀请链接不完整")
    row = (
        await db.execute(select(TeamInvitation).where(TeamInvitation.token == clean))
    ).scalar_one_or_none()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "邀请链接无效或已失效")
    if row.status != "pending":
        raise AppError(ErrorCode.VALIDATION_ERROR, "这条邀请已经处理过了")
    if row.expires_at <= utcnow():
        row.status = "expired"
        await db.flush()
        raise AppError(ErrorCode.VALIDATION_ERROR, "邀请已过期，请让管理员重新邀请")
    if row.email and (user.email or "").lower() != row.email.lower():
        raise AppError(ErrorCode.FORBIDDEN, "这条邀请是发给另一个邮箱的")

    team = await access.load_team(db, row.team_id)
    if team is None:
        raise AppError(ErrorCode.NOT_FOUND, "团队已不存在")
    member = await access.get_membership(db, user.id, team.id)
    if member is None:
        if await seat_usage(db, team.id) >= team.seat_limit:
            raise AppError(ErrorCode.SEAT_LIMIT_EXCEEDED)
        db.add(
            TeamMember(
                id=new_id(),
                team_id=team.id,
                user_id=user.id,
                role=row.role,
                status=MEMBER_ACTIVE,
                permissions={},
                invited_by=row.invited_by,
            )
        )
    else:
        member.role = row.role
        member.status = MEMBER_ACTIVE
    row.status = "accepted"
    row.accepted_at = utcnow()
    row.accepted_by = user.id
    user.active_team_id = team.id
    await db.flush()
    await audit_service.log(
        db,
        action="team.invite.accept",
        actor=user,
        team_id=team.id,
        target_type="team",
        target_id=team.id,
        detail={"role": row.role},
    )
    return team


async def invitation_preview(db: AsyncSession, token: str) -> dict[str, Any]:
    """邀请落地页预览（不要求登录：先让人看到「谁邀请你加入哪个团队」）。"""
    row = (
        await db.execute(
            select(TeamInvitation).where(TeamInvitation.token == (token or "").strip())
        )
    ).scalar_one_or_none()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "邀请链接无效或已失效")
    team = await access.load_team(db, row.team_id)
    inviter = await db.get(User, row.invited_by) if row.invited_by else None
    return {
        "team_name": team.name if team else "",
        "email": row.email or None,
        "role": row.role,
        "inviter": (inviter.display_name or inviter.email) if inviter else "团队管理员",
        "status": row.status,
        "expired": row.expires_at <= utcnow(),
        "expires_at": row.expires_at,
    }


# --------------------------------------------------------------------------- #
# 用量
# --------------------------------------------------------------------------- #
async def usage_summary(db: AsyncSession, ctx: access.TeamContext) -> dict[str, Any]:
    """团队用量概览（billing.view）。

    口径：任务按 `team_id` 归属；额度按流水行上的 `team_id` 归属。
    两者分开统计——任务可能因为成员用的是个人余额而「有任务没扣团队钱」，
    混在一起会算不明白。
    """
    access.require_permission(ctx, "billing.view")
    team = ctx.team
    assert team is not None
    start, now = access.team_today_bounds()

    async def _count_tasks(since=None) -> int:
        stmt = select(func.count()).where(
            GenerationTask.team_id == team.id,
            GenerationTask.status == "succeeded",
        )
        if since is not None:
            stmt = stmt.where(GenerationTask.created_at >= since)
        return int((await db.execute(stmt)).scalar() or 0)

    async def _spend(since=None) -> int:
        stmt = select(func.coalesce(func.sum(-QuotaTransaction.amount), 0)).where(
            QuotaTransaction.team_id == team.id,
            QuotaTransaction.type.in_(quota_service.CONSUME_TYPES),
        )
        if since is not None:
            stmt = stmt.where(QuotaTransaction.created_at >= since)
        return int((await db.execute(stmt)).scalar() or 0)

    per_member = (
        await db.execute(
            select(
                GenerationTask.user_id,
                func.count(GenerationTask.id),
                func.coalesce(func.sum(GenerationTask.cost), 0),
            )
            .where(GenerationTask.team_id == team.id, GenerationTask.created_at >= start)
            .group_by(GenerationTask.user_id)
        )
    ).all()
    emails = {}
    if per_member:
        ids = [row[0] for row in per_member]
        rows = (
            await db.execute(select(User.id, User.email).where(User.id.in_(ids)))
        ).all()
        emails = {row[0]: row[1] for row in rows}

    return {
        "balance": team.balance,
        "shared_quota": team.shared_quota(),
        "seat_limit": team.seat_limit,
        "seat_used": await seat_usage(db, team.id),
        "tasks_today": await _count_tasks(start),
        "tasks_total": await _count_tasks(),
        "spend_today": await _spend(start),
        "spend_total": await _spend(),
        "members_today": [
            {
                "user_id": row[0],
                "email": emails.get(row[0], ""),
                "tasks": int(row[1]),
                "cost": int(row[2] or 0),
            }
            for row in per_member
        ],
        "since": start,
        "now": now,
    }


async def topup(
    db: AsyncSession, ctx: access.TeamContext, actor: User, amount: int, note: str = ""
) -> int:
    """给团队共享池充值（quota.adjust）。"""
    access.require_permission(ctx, "quota.adjust")
    team = ctx.team
    assert team is not None
    if amount == 0:
        raise AppError(ErrorCode.VALIDATION_ERROR, "充值额度不能为 0")
    if amount < 0 and team.balance + amount < 0:
        raise AppError(ErrorCode.VALIDATION_ERROR, "扣减后团队余额不能为负")
    await quota_service.grant(
        db,
        actor.id,
        amount,
        note=note or "团队额度调整",
        tx_type="team_grant",
        team=team,
    )
    await audit_service.log(
        db,
        action="team.quota.adjust",
        actor=actor,
        team_id=team.id,
        target_type="team",
        target_id=team.id,
        detail={"amount": amount, "balance": team.balance},
    )
    return team.balance


# --------------------------------------------------------------------------- #
# 团队模型配置（超级管理员统一配置）
# --------------------------------------------------------------------------- #
async def list_team_providers(
    db: AsyncSession, ctx: access.TeamContext
) -> list[dict[str, Any]]:
    """团队级模型配置列表。成员只读，`api_key` 永远不回传明文。"""
    from app.routers.ai import _to_out  # 延迟导入：避免循环依赖

    team = ctx.team
    assert team is not None
    rows = (
        await db.execute(
            select(AIProvider)
            .where(AIProvider.scope == "team", AIProvider.team_id == team.id)
            .order_by(AIProvider.created_at.asc())
        )
    ).scalars().all()
    return [_to_out(row) for row in rows]


async def model_config_view(db: AsyncSession, ctx: access.TeamContext) -> dict[str, Any]:
    """成员视角的模型配置状态：能不能改、用的哪个模型、来自哪里。"""
    from app.services import relay_service

    team = ctx.team
    assert team is not None
    rows = (
        await db.execute(
            select(AIProvider).where(
                AIProvider.scope == "team",
                AIProvider.team_id == team.id,
                AIProvider.is_active.is_(True),
            )
        )
    ).scalars().all()
    active = rows[0] if rows else None
    return {
        "team_id": team.id,
        "editable": ctx.is_owner,
        "configured": active is not None,
        "source": "team" if active is not None else "none",
        "model": active.model if active else "",
        "provider_name": active.name if active else "",
        "base_url": active.base_url if active else "",
        "managed_by": team.owner_user_id,
        "team_name": team.name,
        "fallback_models": relay_service.safe_model_list(
            active.fallback_models if active else None
        ),
        "updated_at": active.updated_at if active else None,
    }


async def upsert_team_provider(
    db: AsyncSession,
    ctx: access.TeamContext,
    actor: User,
    payload: dict[str, Any],
) -> AIProvider:
    """创建 / 更新团队唯一生效的模型配置（仅 owner）。

    团队只保留一条 active provider：多条的「谁生效」问题在企业场景里没有价值，
    只会让管理员困惑。历史 provider 会被置为 inactive 而不是删除（保留可追溯）。
    """
    access.require_owner(ctx)
    team = ctx.team
    assert team is not None
    base_url = str(payload.get("base_url") or "").strip()
    api_key = str(payload.get("api_key") or "").strip()
    model = str(payload.get("model") or "").strip()
    if not base_url or not model:
        raise AppError(ErrorCode.VALIDATION_ERROR, "接口地址与模型名必填")

    row = (
        await db.execute(
            select(AIProvider).where(
                AIProvider.scope == "team", AIProvider.team_id == team.id
            )
        )
    ).scalars().first()
    if row is None:
        row = AIProvider(
            id=new_id(),
            user_id=actor.id,
            scope="team",
            team_id=team.id,
            is_active=True,
        )
        db.add(row)
    row.user_id = actor.id
    row.name = str(payload.get("name") or "团队对话模型").strip()[:80]
    row.kind = str(payload.get("kind") or "compatible").strip()[:24]
    row.base_url = base_url[:500]
    # 掩码（含 *）视为「不修改」，避免把前端展示的掩码写回真实 key
    if api_key and "*" not in api_key:
        row.api_key = api_key[:500]
    row.model = model[:120]
    fallbacks = payload.get("fallback_models")
    if isinstance(fallbacks, list):
        row.fallback_models = [str(item)[:120] for item in fallbacks][:3]
    if "supports_vision" in payload:
        row.supports_vision = bool(payload["supports_vision"])
    if "temperature" in payload and payload["temperature"] is not None:
        row.temperature = float(payload["temperature"])
    if "max_tokens" in payload and payload["max_tokens"] is not None:
        row.max_tokens = int(payload["max_tokens"])
    row.is_active = True
    await db.flush()
    # 其余团队配置置为 inactive
    others = (
        await db.execute(
            select(AIProvider).where(
                AIProvider.scope == "team",
                AIProvider.team_id == team.id,
                AIProvider.id != row.id,
                AIProvider.is_active.is_(True),
            )
        )
    ).scalars().all()
    for other in others:
        other.is_active = False
    await db.flush()
    await audit_service.log(
        db,
        action="team.model.configure",
        actor=actor,
        team_id=team.id,
        target_type="ai_provider",
        target_id=row.id,
        detail={"model": row.model, "base_url": row.base_url},
    )
    return row


async def delete_team(db: AsyncSession, ctx: access.TeamContext, actor: User) -> None:
    """软删除团队（仅 owner）。成员关系保留以便审计，但团队不再可用。"""
    access.require_owner(ctx)
    team = ctx.team
    assert team is not None
    team.deleted_at = utcnow()
    team.status = "archived"
    await db.flush()
    await audit_service.log(
        db,
        action="team.delete",
        actor=actor,
        team_id=team.id,
        target_type="team",
        target_id=team.id,
        detail={"name": team.name},
    )


__all__ = [
    "accept_invitation",
    "create_invitation",
    "create_team",
    "delete_team",
    "get_context",
    "get_team_detail",
    "invitation_preview",
    "list_invitations",
    "list_members",
    "list_my_teams",
    "list_team_providers",
    "model_config_view",
    "remove_member",
    "revoke_invitation",
    "seat_usage",
    "set_active_team",
    "topup",
    "transfer_owner",
    "update_member",
    "update_team",
    "upsert_team_provider",
    "usage_summary",
    "PERMISSION_KEYS",
]
