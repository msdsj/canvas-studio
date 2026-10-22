"""团队路由 `/api/teams/*`。

权限约定
--------
- 所有 `/api/teams/{team_id}/**` 先过 `_ctx()`：非成员一律 404（不泄漏存在性）；
- 写操作在 service 层用 `access.require_permission` / `require_owner` 收口，
  路由层只做「参数 → service」的转译，避免权限判断出现两份实现；
- 模型配置的**写**只允许 owner，成员读到的是一份不含密钥的状态视图。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user, require_admin
from app.models.user import User
from app.services import access, team_service
from app.utils.errors import AppError, ErrorCode, envelope

router = APIRouter(prefix="/api/teams", tags=["teams"])


async def _ctx(db: AsyncSession, user: User, team_id: str) -> access.TeamContext:
    return await team_service.get_context(db, user, team_id)


# --------------------------------------------------------------------------- #
# 请求体
# --------------------------------------------------------------------------- #
class TeamCreateRequest(BaseModel):
    """创建团队。"""

    name: str = Field(min_length=2, max_length=60)
    seat_limit: int = Field(default=5, ge=1, le=500)
    shared_quota: bool = False


class TeamUpdateRequest(BaseModel):
    """修改团队设置（全部可选，只改传了的）。"""

    name: str | None = None
    seat_limit: int | None = Field(default=None, ge=1, le=500)
    shared_quota: bool | None = None


class ActiveTeamRequest(BaseModel):
    """切换当前团队；null = 个人空间。"""

    team_id: str | None = None


class InviteRequest(BaseModel):
    """发出邀请。"""

    email: str = ""
    role: str = "member"
    note: str = ""


class MemberUpdateRequest(BaseModel):
    """改成员角色 / 状态 / 权限覆盖。"""

    role: str | None = None
    status: str | None = None
    permissions: dict[str, Any] | None = None


class TopupRequest(BaseModel):
    """团队额度调整。"""

    amount: int
    note: str = ""


class TeamModelRequest(BaseModel):
    """团队对话模型配置（仅 owner 可写）。"""

    name: str = ""
    kind: str = "compatible"
    base_url: str
    api_key: str = ""
    model: str
    fallback_models: list[str] | None = None
    supports_vision: bool = False
    temperature: float | None = None
    max_tokens: int | None = None


# --------------------------------------------------------------------------- #
# 团队本体
# --------------------------------------------------------------------------- #
@router.get("")
async def list_teams(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """我加入的团队（含当前生效的团队 id）。"""
    teams = await team_service.list_my_teams(db, user.id)
    return envelope({"items": teams, "active_team_id": user.active_team_id})


@router.post("")
async def create_team(
    payload: TeamCreateRequest,
    user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """仅平台超级管理员可以创建企业空间。"""
    team = await team_service.create_team(
        db,
        user,
        payload.name,
        seat_limit=payload.seat_limit,
        shared_quota=payload.shared_quota,
    )
    await db.commit()
    ctx = await team_service.get_context(db, user, team.id)
    return envelope(await team_service.get_team_detail(db, ctx))


@router.post("/active")
async def set_active_team(
    payload: ActiveTeamRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """切换当前团队（个人空间 ⇄ 团队空间）。"""
    await team_service.set_active_team(db, user, payload.team_id)
    await db.commit()
    return envelope({"active_team_id": user.active_team_id})


# --------------------------------------------------------------------------- #
# 邀请（不依赖具体团队的落地动作，必须放在 `/{team_id}` 之前）
# --------------------------------------------------------------------------- #
@router.get("/invitations/{token}")
async def preview_invitation(token: str, db: AsyncSession = Depends(get_db)) -> dict:
    """邀请落地页预览（无需登录）。"""
    return envelope(await team_service.invitation_preview(db, token))


@router.post("/invitations/{token}/accept")
async def accept_invitation(
    token: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """接受邀请并加入团队（令牌与登录邮箱绑定）。"""
    team = await team_service.accept_invitation(db, user, token)
    await db.commit()
    return envelope({"team_id": team.id, "team_name": team.name})


# --------------------------------------------------------------------------- #
# 团队详情 / 设置
# --------------------------------------------------------------------------- #
@router.get("/{team_id}")
async def get_team(
    team_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """团队详情（成员可见）。"""
    ctx = await _ctx(db, user, team_id)
    return envelope(await team_service.get_team_detail(db, ctx))


@router.patch("/{team_id}")
async def update_team(
    team_id: str,
    payload: TeamUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """修改团队设置（仅超级管理员）。"""
    ctx = await _ctx(db, user, team_id)
    await team_service.update_team(
        db,
        ctx,
        user,
        name=payload.name,
        seat_limit=payload.seat_limit,
        shared_quota=payload.shared_quota,
    )
    await db.commit()
    return envelope(await team_service.get_team_detail(db, ctx))


@router.delete("/{team_id}")
async def delete_team(
    team_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """归档团队（仅超级管理员）。"""
    ctx = await _ctx(db, user, team_id)
    await team_service.delete_team(db, ctx, user)
    if user.active_team_id == team_id:
        user.active_team_id = None
    await db.commit()
    return envelope({"deleted": team_id})


# --------------------------------------------------------------------------- #
# 成员
# --------------------------------------------------------------------------- #
@router.get("/{team_id}/members")
async def list_members(
    team_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """成员列表。"""
    ctx = await _ctx(db, user, team_id)
    return envelope(await team_service.list_members(db, ctx))


@router.patch("/{team_id}/members/{member_id}")
async def update_member(
    team_id: str,
    member_id: str,
    payload: MemberUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """改成员角色 / 状态 / 权限。"""
    ctx = await _ctx(db, user, team_id)
    await team_service.update_member(
        db,
        ctx,
        user,
        member_id,
        role=payload.role,
        status=payload.status,
        permissions=payload.permissions,
    )
    await db.commit()
    return envelope(await team_service.list_members(db, ctx))


@router.delete("/{team_id}/members/{member_id}")
async def remove_member(
    team_id: str,
    member_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """移除成员（或自己退出）。"""
    ctx = await _ctx(db, user, team_id)
    self_leave = ctx.member is not None and ctx.member.id == member_id
    await team_service.remove_member(db, ctx, user, member_id, self_leave=self_leave)
    if self_leave and user.active_team_id == team_id:
        user.active_team_id = None
    await db.commit()
    return envelope({"removed": member_id})


@router.post("/{team_id}/members/{member_id}/transfer")
async def transfer_owner(
    team_id: str,
    member_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """转让超级管理员。"""
    ctx = await _ctx(db, user, team_id)
    await team_service.transfer_owner(db, ctx, user, member_id)
    await db.commit()
    ctx = await _ctx(db, user, team_id)
    return envelope(await team_service.get_team_detail(db, ctx))


# --------------------------------------------------------------------------- #
# 邀请管理
# --------------------------------------------------------------------------- #
@router.get("/{team_id}/invitations")
async def list_invitations(
    team_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """待处理邀请列表。"""
    ctx = await _ctx(db, user, team_id)
    return envelope(await team_service.list_invitations(db, ctx))


@router.post("/{team_id}/invitations")
async def create_invitation(
    team_id: str,
    payload: InviteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """生成可复制的加入链接。"""
    ctx = await _ctx(db, user, team_id)
    invitation = await team_service.create_invitation(
        db, ctx, user, payload.email, payload.role, payload.note
    )
    await db.commit()
    team = ctx.team
    assert team is not None
    return envelope(
        {
            "id": invitation.id,
            "email": invitation.email,
            "role": invitation.role,
            "token": invitation.token,
            "team_id": team.id,
            "expires_at": invitation.expires_at,
        }
    )


@router.delete("/{team_id}/invitations/{invitation_id}")
async def revoke_invitation(
    team_id: str,
    invitation_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """撤销邀请。"""
    ctx = await _ctx(db, user, team_id)
    await team_service.revoke_invitation(db, ctx, user, invitation_id)
    await db.commit()
    return envelope({"revoked": invitation_id})


# --------------------------------------------------------------------------- #
# 用量 / 额度
# --------------------------------------------------------------------------- #
@router.get("/{team_id}/usage")
async def usage(
    team_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """团队用量概览（需要 billing.view）。"""
    ctx = await _ctx(db, user, team_id)
    return envelope(await team_service.usage_summary(db, ctx))


@router.post("/{team_id}/quota")
async def topup(
    team_id: str,
    payload: TopupRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """给团队共享池充值 / 扣减。"""
    ctx = await _ctx(db, user, team_id)
    balance = await team_service.topup(db, ctx, user, payload.amount, payload.note)
    await db.commit()
    return envelope({"balance": balance})


# --------------------------------------------------------------------------- #
# 模型配置（仅超级管理员可写）
# --------------------------------------------------------------------------- #
@router.get("/{team_id}/model-config")
async def get_model_config(
    team_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """团队模型配置状态（成员只读，不含密钥）。"""
    ctx = await _ctx(db, user, team_id)
    view = await team_service.model_config_view(db, ctx)
    if ctx.is_owner:
        view["providers"] = await team_service.list_team_providers(db, ctx)
    return envelope(view)


@router.put("/{team_id}/model-config")
async def put_model_config(
    team_id: str,
    payload: TeamModelRequest,
    user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """旧团队模型入口已停用；对话模型只由平台配置。"""
    raise AppError(ErrorCode.MODEL_CONFIG_FORBIDDEN, "企业对话模型由平台超级管理员统一配置")


@router.get("/{team_id}/audit")
async def team_audit(
    team_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
) -> dict:
    """团队审计日志（成员管理权限可见）。"""
    from sqlalchemy import func, select

    from app.models.audit import AuditLog
    from app.utils.pagination import paginated

    ctx = await _ctx(db, user, team_id)
    access.require_permission(ctx, "member.manage")
    base = select(AuditLog).where(AuditLog.team_id == team_id)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    rows = (
        await db.execute(
            base.order_by(AuditLog.created_at.desc()).offset((page - 1) * size).limit(size)
        )
    ).scalars().all()
    return envelope(
        paginated(
            [
                {
                    "id": row.id,
                    "actor_email": row.actor_email,
                    "action": row.action,
                    "target_type": row.target_type,
                    "target_id": row.target_id,
                    "detail": row.detail,
                    "created_at": row.created_at,
                }
                for row in rows
            ],
            total,
            page,
            size,
        )
    )
