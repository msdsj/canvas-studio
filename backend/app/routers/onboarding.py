"""引导与技能包路由 `/api/onboarding/*` 与 `/api/skills/*`。

引导是一次性的：完成后写 `users.onboarding_completed_at`，前端据此决定是否强制
跳 `/onboarding`。接口本身幂等——重复提交只会更新选择，不会报错，也不会重置进度。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user
from app.models.user import User
from app.services import access, skill_packs, team_service
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.ids import utcnow

onboarding_router = APIRouter(prefix="/api/onboarding", tags=["onboarding"])
skills_router = APIRouter(prefix="/api/skills", tags=["skills"])

class OnboardingCompleteRequest(BaseModel):
    """完成引导：选场景与技能包。"""

    persona_key: str = Field(default="", max_length=32)
    pack_keys: list[str] = Field(default_factory=list)


class SkillPacksRequest(BaseModel):
    """替换个人技能包选择。"""

    pack_keys: list[str] = Field(default_factory=list)


class SkillToggleRequest(BaseModel):
    """单条技能开关。"""

    skill_id: str
    enabled: bool = True


class TeamPacksRequest(BaseModel):
    """替换团队默认技能包（仅超级管理员）。"""

    pack_keys: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# 引导
# --------------------------------------------------------------------------- #
@onboarding_router.get("/personas")
async def list_personas() -> dict:
    """场景目录：每个场景带推荐技能包、技能条数与示例提示词。"""
    return envelope(
        {
            "items": list(skill_packs.load_personas()),
            "total": len(skill_packs.load_personas()),
        }
    )


@onboarding_router.get("/state")
async def onboarding_state(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """引导状态：是否已完成、选了哪个场景、当前生效的技能包。"""
    pack_keys = await skill_packs.resolve_pack_keys(db, user)
    packs = skill_packs.load_packs()
    return envelope(
        {
            "completed": user.onboarding_completed_at is not None,
            "persona_key": user.persona_key or "",
            "pack_keys": pack_keys,
            "pack_names": [packs[key].name for key in pack_keys if key in packs],
            "skill_count": sum(len(packs[key].items) for key in pack_keys if key in packs),
            "completed_at": user.onboarding_completed_at,
        }
    )


@onboarding_router.post("/complete")
async def complete_onboarding(
    payload: OnboardingCompleteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """完成引导（幂等）。

    规则：
    - 传了 `persona_key` 就用场景推荐包；否则用 `pack_keys`；都没传就保持现状；
    - 企业账号与团队由平台管理员统一开通，不由终端用户在首登时创建；
    - 重复调用只更新选择与时间戳，不会重复建团队。
    """
    persona_key = (payload.persona_key or "").strip()
    if persona_key:
        persona = skill_packs.get_persona(persona_key)
        if persona is None:
            raise AppError(ErrorCode.VALIDATION_ERROR, "没有这个使用场景")
        user.persona_key = persona_key
        if not payload.pack_keys:
            await skill_packs.apply_persona(db, user, persona_key)
        else:
            await skill_packs.set_user_packs(db, user, payload.pack_keys)
    elif payload.pack_keys:
        await skill_packs.set_user_packs(db, user, payload.pack_keys)
    elif user.onboarding_completed_at is None:
        # 完全跳过选择：给一个可用兜底，避免「没有技能」的空状态
        await skill_packs.set_user_packs(
            db, user, [skill_packs.FALLBACK_PACK], source="onboarding"
        )

    if user.onboarding_completed_at is None:
        user.onboarding_completed_at = utcnow()
    await db.commit()

    pack_keys = await skill_packs.resolve_pack_keys(db, user)
    packs = skill_packs.load_packs()
    return envelope(
        {
            "completed": True,
            "persona_key": user.persona_key or "",
            "pack_keys": pack_keys,
            "pack_names": [packs[key].name for key in pack_keys if key in packs],
            "team": None,
        }
    )


# --------------------------------------------------------------------------- #
# 技能包
# --------------------------------------------------------------------------- #
@skills_router.get("/packs")
async def list_packs(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """技能包目录（含「我是否已启用」）。"""
    enabled = set(await skill_packs.resolve_pack_keys(db, user))
    return envelope(
        {
            "items": [
                {**pack.to_public(), "enabled": pack.key in enabled}
                for pack in skill_packs.all_packs()
            ],
            "total": len(skill_packs.all_packs()),
        }
    )


@skills_router.get("/packs/{pack_key}")
async def get_pack_detail(pack_key: str) -> dict:
    """技能包详情（含全部条目）。"""
    pack = skill_packs.get_pack(pack_key)
    if pack is None:
        raise AppError(ErrorCode.NOT_FOUND, "没有这个技能包")
    return envelope(pack.to_public(with_items=True))


@skills_router.get("/mine")
async def my_skills(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    q: str | None = Query(default=None),
    limit: int = Query(default=60, ge=1, le=200),
) -> dict:
    """我的有效技能集（团队包 ∪ 个人包 − 禁用）。"""
    items = await skill_packs.effective_items(db, user)
    if q:
        items = skill_packs.match_items(items, q, limit=limit)
    else:
        items = items[:limit]
    team_keys, personal_keys = await skill_packs.user_pack_keys(db, user)
    return envelope(
        {
            "items": [item.to_public() for item in items],
            "team_packs": team_keys,
            "personal_packs": personal_keys,
            "total": len(items),
        }
    )


@skills_router.put("/mine")
async def set_my_skills(
    payload: SkillPacksRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """替换个人技能包选择。"""
    keys = await skill_packs.set_user_packs(db, user, payload.pack_keys, source="manual")
    await db.commit()
    packs = skill_packs.load_packs()
    return envelope(
        {
            "pack_keys": keys,
            "pack_names": [packs[key].name for key in keys if key in packs],
        }
    )


@skills_router.post("/mine/toggle")
async def toggle_skill(
    payload: SkillToggleRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """启用 / 停用单条技能。"""
    await skill_packs.toggle_item(db, user, payload.skill_id, payload.enabled)
    await db.commit()
    return envelope({"skill_id": payload.skill_id, "enabled": payload.enabled})


@skills_router.get("/team/{team_id}")
async def team_skills(
    team_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """团队默认技能包。"""
    ctx = await team_service.get_context(db, user, team_id)
    keys = await skill_packs.team_pack_keys(db, team_id)
    packs = skill_packs.load_packs()
    return envelope(
        {
            "pack_keys": keys,
            "pack_names": [packs[key].name for key in keys if key in packs],
            "editable": ctx.is_owner,
        }
    )


@skills_router.put("/team/{team_id}")
async def set_team_skills(
    team_id: str,
    payload: TeamPacksRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """设置团队默认技能包（仅超级管理员）。"""
    ctx = await team_service.get_context(db, user, team_id)
    access.require_owner(ctx)
    keys = await skill_packs.set_team_packs(db, team_id, payload.pack_keys)
    await db.commit()
    packs = skill_packs.load_packs()
    return envelope(
        {
            "pack_keys": keys,
            "pack_names": [packs[key].name for key in keys if key in packs],
        }
    )


@skills_router.get("/search")
async def search_skills(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    q: str = Query(default="", max_length=200),
    limit: int = Query(default=20, ge=1, le=60),
) -> dict:
    """在当前可用技能集内搜索（按关键词粗排）。"""
    items = await skill_packs.effective_items(db, user)
    matched = skill_packs.match_items(items, q, limit=limit) if q else items[:limit]
    return envelope({"items": [item.to_public() for item in matched], "total": len(matched)})
