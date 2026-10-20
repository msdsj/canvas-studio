"""团队（企业租户）模型：团队、成员、邀请。

设计要点
--------
1. **团队角色与平台角色正交**：`users.role=admin` 是平台运维（管全站配置/号池），
   企业超级管理员是 `team_members.role=owner`。把两者混成一个 `role` 字段，
   等于把平台运维权限下放给客户，是绝对不能接受的越权面。
2. **一个用户可属于多个团队**，但同一时刻只有一个 `users.active_team_id` 生效；
   团队上下文决定资源可见范围、额度来源与模型配置来源。
3. **权限 = 角色默认位 + 成员级覆盖**：`permissions` 只存「与默认不同的项」，
   读取时用 `effective_permissions()` 合并，避免每加一个权限键都要回填历史行。
"""
from __future__ import annotations

import json
from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow

# 团队角色
TEAM_ROLE_OWNER = "owner"
TEAM_ROLE_ADMIN = "admin"
TEAM_ROLE_MEMBER = "member"
TEAM_ROLES = (TEAM_ROLE_OWNER, TEAM_ROLE_ADMIN, TEAM_ROLE_MEMBER)

# 成员状态
MEMBER_ACTIVE = "active"
MEMBER_INVITED = "invited"
MEMBER_DISABLED = "disabled"
MEMBER_STATUSES = (MEMBER_ACTIVE, MEMBER_INVITED, MEMBER_DISABLED)

#: 权限键 → 角色默认位。`permissions` 里的同名键覆盖这里。
DEFAULT_PERMISSIONS: dict[str, dict[str, bool]] = {
    "team.manage": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: False, TEAM_ROLE_MEMBER: False},
    "member.manage": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: True, TEAM_ROLE_MEMBER: False},
    "model.configure": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: False, TEAM_ROLE_MEMBER: False},
    "billing.view": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: True, TEAM_ROLE_MEMBER: False},
    "quota.adjust": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: False, TEAM_ROLE_MEMBER: False},
    "asset.manage": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: True, TEAM_ROLE_MEMBER: False},
    "canvas.create": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: True, TEAM_ROLE_MEMBER: True},
    "canvas.edit.any": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: True, TEAM_ROLE_MEMBER: False},
    "canvas.share.external": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: True, TEAM_ROLE_MEMBER: False},
    "team.resource.view": {TEAM_ROLE_OWNER: True, TEAM_ROLE_ADMIN: True, TEAM_ROLE_MEMBER: True},
}

PERMISSION_KEYS = tuple(DEFAULT_PERMISSIONS)


def _as_dict(raw: Any) -> dict[str, Any]:
    """把 JSON 列收敛成 dict（兼容 None / 字符串 / 脏数据）。"""
    if isinstance(raw, dict):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}


class Team(Base):
    """企业团队（租户）。"""

    __tablename__ = "teams"
    __table_args__ = (CheckConstraint("balance >= 0", name="ck_teams_balance_non_negative"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # 人类可读的稳定标识（用于邀请链接与展示），小写字母数字与连字符
    slug: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    owner_user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    status: Mapped[str] = mapped_column(String(16), index=True, default="active")
    seat_limit: Mapped[int] = mapped_column(Integer, default=5)
    plan: Mapped[str] = mapped_column(String(24), default="team")
    # 团队设置：shared_quota / allow_personal_provider / default_skill_packs
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 共享额度池（`settings.shared_quota=true` 时才是任务扣费来源）
    balance: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)

    def settings_dict(self) -> dict[str, Any]:
        return _as_dict(self.settings)

    def shared_quota(self) -> bool:
        """是否启用团队共享额度池。默认关闭：成员用自己的余额，避免建团即不可用。"""
        return bool(self.settings_dict().get("shared_quota", False))

    def allow_personal_provider(self) -> bool:
        """团队是否允许成员自带模型配置。默认不允许——需求要求「统一配置」。"""
        return bool(self.settings_dict().get("allow_personal_provider", False))


class TeamMember(Base):
    """团队成员（含角色与权限覆盖）。"""

    __tablename__ = "team_members"
    __table_args__ = (UniqueConstraint("team_id", "user_id", name="uq_team_member"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    team_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("teams.id"), index=True, nullable=False
    )
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    role: Mapped[str] = mapped_column(String(16), default=TEAM_ROLE_MEMBER, index=True)
    status: Mapped[str] = mapped_column(String(16), default=MEMBER_ACTIVE, index=True)
    # 成员级权限覆盖：只存与角色默认不同的键
    permissions: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    # 展示用：谁把他拉进来的
    invited_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)

    def effective_permissions(self) -> dict[str, bool]:
        """角色默认位 ← 成员覆盖。未知键忽略，避免脏数据把权限放大。"""
        base = {key: bool(DEFAULT_PERMISSIONS[key].get(self.role, False)) for key in PERMISSION_KEYS}
        for key, value in _as_dict(self.permissions).items():
            if key in base and isinstance(value, bool):
                base[key] = value
        return base

    def has(self, permission: str) -> bool:
        return bool(self.effective_permissions().get(permission, False))


class TeamInvitation(Base):
    """团队邀请（邮件令牌，一次性）。"""

    __tablename__ = "team_invitations"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    team_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("teams.id"), index=True, nullable=False
    )
    email: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    role: Mapped[str] = mapped_column(String(16), default=TEAM_ROLE_MEMBER)
    token: Mapped[str] = mapped_column(String(64), unique=True, index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(16), index=True, default="pending")
    note: Mapped[str] = mapped_column(Text, default="")
    invited_by: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("users.id"), nullable=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    accepted_by: Mapped[str | None] = mapped_column(String(36), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
