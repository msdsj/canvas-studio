"""技能包模型：用户/团队选择的技能集。

技能内容本身是**产品资产**（`app/data/skill_packs/*.json`，随代码版本走，管理员不可改），
这里只存「谁启用了哪些包」与「单条技能的开关」，这样：
- 技能更新 = 发版，不会因为后台误改导致全站出图风格漂移；
- 用户选择 = 数据，可随时增删、可被团队统一配置。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow

SOURCE_ONBOARDING = "onboarding"
SOURCE_MANUAL = "manual"
SOURCE_TEAM = "team"
SOURCE_DEFAULT = "default"


class UserSkillPack(Base):
    """用户启用的技能包。"""

    __tablename__ = "user_skill_packs"
    __table_args__ = (UniqueConstraint("user_id", "pack_key", name="uq_user_skill_pack"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    pack_key: Mapped[str] = mapped_column(String(64), nullable=False)
    source: Mapped[str] = mapped_column(String(16), default=SOURCE_ONBOARDING)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class TeamSkillPack(Base):
    """团队默认技能包（成员继承，可在个人侧追加）。"""

    __tablename__ = "team_skill_packs"
    __table_args__ = (UniqueConstraint("team_id", "pack_key", name="uq_team_skill_pack"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    team_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("teams.id"), index=True, nullable=False
    )
    pack_key: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class UserSkillOverride(Base):
    """单条技能的用户级开关（默认启用，显式关闭才落行）。"""

    __tablename__ = "user_skill_overrides"
    __table_args__ = (UniqueConstraint("user_id", "skill_id", name="uq_user_skill_override"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    skill_id: Mapped[str] = mapped_column(String(96), nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
