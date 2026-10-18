"""AI 中转站配置 / 设计技能库 / 提示词润色 路由 `/api/ai/*`。"""
from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import get_current_user, require_pro
from app.models.ai_provider import AIProvider
from app.models.user import User
from app.schemas.ai import (
    DesignSkillCategoryOut,
    DesignSkillOut,
    PolishRequest,
    PolishResult,
    ProviderOut,
    ProviderTestRequest,
    ProviderUpsertRequest,
    RelayStatusOut,
)
from app.services import design_skills, polish_service, relay_chain, relay_service
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.ids import utcnow
from app.utils.logging import get_logger

logger = get_logger("app.routers.ai")

router = APIRouter(prefix="/api/ai", tags=["ai"])

# 连通性测试的简易限流：这是一个「让后端主动发请求」的入口，
# 不限速就会被当成内网扫描器用。10 次/分钟对正常配置足够。
_TEST_WINDOW_SECONDS = 60
_TEST_LIMIT = 10
_test_hits: dict[str, deque[float]] = defaultdict(deque)


def _guard_test_rate(user_id: str) -> None:
    now = time.monotonic()
    hits = _test_hits[user_id]
    while hits and now - hits[0] > _TEST_WINDOW_SECONDS:
        hits.popleft()
    if len(hits) >= _TEST_LIMIT:
        raise AppError(ErrorCode.RATE_LIMITED, "测试有点频繁，等一分钟再试")
    hits.append(now)


def _to_out(row: AIProvider) -> dict:
    """序列化：api_key 只给掩码，永不回明文。"""
    return {
        "id": row.id,
        "name": row.name or "",
        "kind": row.kind or "compatible",
        "base_url": row.base_url or "",
        "model": row.model or "",
        # 归一后再输出：用户存了什么就回什么（≤3、去重、不含主模型），
        # 避免「配置页显示 4 个、实际只试 2 个」这种不可解释的差异
        "fallback_models": relay_chain.normalize_fallback_models(
            row.fallback_models, row.model or ""
        ),
        "temperature": float(row.temperature if row.temperature is not None else 0.7),
        "max_tokens": int(row.max_tokens or 2048),
        "extra": row.extra or {},
        "supports_vision": bool(row.supports_vision),
        "is_active": bool(row.is_active),
        "key_hint": relay_service.mask_key(row.api_key or ""),
        "has_key": bool(row.api_key),
        "last_test_ok": row.last_test_ok,
        "last_test_at": row.last_test_at,
        "last_test_message": row.last_test_message or "",
        "created_at": row.created_at,
        "updated_at": row.updated_at,
    }


async def _get_row(db: AsyncSession, user: User, provider_id: str) -> AIProvider:
    row = (
        await db.execute(
            select(AIProvider).where(
                AIProvider.id == provider_id, AIProvider.user_id == user.id
            )
        )
    ).scalar_one_or_none()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "这条中转站配置不存在")
    return row


@router.get("/presets")
async def presets(user: User = Depends(get_current_user)) -> dict:
    """新建表单的预填建议（只是建议，不写入任何配置）。"""
    return envelope(
        {
            "kinds": [
                {"id": kind, **{k: v for k, v in preset.items()}}
                for kind, preset in relay_service.KIND_PRESETS.items()
            ]
        }
    )


@router.get("/providers")
async def list_providers(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """列出我的中转站（含激活状态与最近测试结果）。"""
    rows = (
        await db.execute(
            select(AIProvider)
            .where(AIProvider.user_id == user.id)
            .order_by(AIProvider.created_at.asc())
        )
    ).scalars().all()
    return envelope([ProviderOut(**_to_out(row)).model_dump() for row in rows])


@router.post("/providers")
async def create_provider(
    payload: ProviderUpsertRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """新增一条中转站配置（允许全部留空，作为预留配置位）。"""
    # 存之前先做静态校验（不解析 DNS：允许离线先把配置填好），
    # 免得用户存了个 file:// 或平台自身端口，等到真正生成时才报错
    if payload.base_url.strip():
        await relay_service.guard_url(payload.base_url.strip(), resolve_dns=False)
    row = AIProvider(
        user_id=user.id,
        name=payload.name.strip(),
        kind=payload.kind,
        base_url=payload.base_url.strip(),
        api_key=payload.api_key.strip(),
        model=payload.model.strip(),
        # 备用模型链：strip → 去空 → 去重 → 去掉等于主模型 → 截断到 3（存 3 试 2）
        fallback_models=relay_chain.normalize_fallback_models(
            payload.fallback_models, payload.model.strip()
        ),
        temperature=payload.temperature,
        max_tokens=payload.max_tokens,
        extra=payload.extra or {},
        supports_vision=payload.supports_vision,
        is_active=False,
    )
    db.add(row)
    await db.flush()

    # 第一条配置自动激活：否则用户填完还是一直「未配置」，会以为没保存
    existing = (
        await db.execute(select(AIProvider).where(AIProvider.user_id == user.id))
    ).scalars().all()
    if len(existing) == 1 or payload.is_active:
        for item in existing:
            item.is_active = item.id == row.id
        row.is_active = True

    await db.commit()
    await db.refresh(row)
    return envelope(ProviderOut(**_to_out(row)).model_dump())


@router.patch("/providers/{provider_id}")
async def update_provider(
    provider_id: str,
    payload: ProviderUpsertRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """更新配置。

    `api_key` 若传入的是掩码（含 `*`），视为「不改」——否则前端回填掩码再保存，
    真实 Key 会被一串星号覆盖，用户下次生成就会 401。
    """
    row = await _get_row(db, user, provider_id)
    if payload.base_url.strip():
        await relay_service.guard_url(payload.base_url.strip(), resolve_dns=False)
    row.name = payload.name.strip()
    row.kind = payload.kind
    row.base_url = payload.base_url.strip()
    row.model = payload.model.strip()
    if payload.fallback_models is not None:
        # None = 不改这一项（PATCH 语义）；[] = 清空
        row.fallback_models = relay_chain.normalize_fallback_models(
            payload.fallback_models, row.model
        )
    else:
        # 主模型可能被改了：把「等于新主模型」的备用项去掉，避免自我重复
        row.fallback_models = relay_chain.normalize_fallback_models(
            row.fallback_models, row.model
        )
    row.temperature = payload.temperature
    row.max_tokens = payload.max_tokens
    row.extra = payload.extra or {}
    row.supports_vision = payload.supports_vision
    row.updated_at = utcnow()
    key = payload.api_key.strip()
    if payload.clear_api_key:
        row.api_key = ""
    elif key and "*" not in key:
        # 掩码视为「不改」；要清空请用 clear_api_key，避免把星号写进库
        row.api_key = key

    if payload.is_active:
        rows = (
            await db.execute(select(AIProvider).where(AIProvider.user_id == user.id))
        ).scalars().all()
        for item in rows:
            item.is_active = item.id == row.id
    await db.commit()
    await db.refresh(row)
    return envelope(ProviderOut(**_to_out(row)).model_dump())


@router.post("/providers/{provider_id}/activate")
async def activate_provider(
    provider_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """切换当前生效的中转站（同一时刻只有一个）。"""
    row = await _get_row(db, user, provider_id)
    rows = (
        await db.execute(select(AIProvider).where(AIProvider.user_id == user.id))
    ).scalars().all()
    for item in rows:
        item.is_active = item.id == row.id
    await db.commit()
    await db.refresh(row)
    return envelope(ProviderOut(**_to_out(row)).model_dump())


@router.delete("/providers/{provider_id}")
async def delete_provider(
    provider_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """删除配置；删掉的如果是激活项，自动把最近更新的一条设为激活。"""
    row = await _get_row(db, user, provider_id)
    was_active = row.is_active
    await db.delete(row)
    await db.flush()
    if was_active:
        rest = (
            await db.execute(
                select(AIProvider)
                .where(AIProvider.user_id == user.id)
                .order_by(AIProvider.updated_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()
        if rest is not None:
            rest.is_active = True
    await db.commit()
    return envelope({"deleted": provider_id})


@router.post("/providers/{provider_id}/test")
async def test_saved_provider(
    provider_id: str,
    payload: ProviderTestRequest | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """测试已保存的配置；请求体可覆盖表单里尚未保存的值。"""
    _guard_test_rate(user.id)
    row = await _get_row(db, user, provider_id)
    target = relay_service.build_target_from_draft(
        base_url=(payload.base_url if payload and payload.base_url else row.base_url),
        # 空串表示「用已保存的」：否则前端留空测试会把真实 Key 覆盖成空
        api_key=(payload.api_key if payload and payload.api_key else row.api_key),
        model=(payload.model if payload and payload.model else row.model),
        kind=(payload.kind if payload and payload.kind else row.kind),
        supports_vision=row.supports_vision,
        name=row.name,
        temperature=float(row.temperature or 0.7),
        max_tokens=int(row.max_tokens or 2048),
        extra=dict(row.extra or {}),
    )
    if target.api_key and "*" in target.api_key:
        target.api_key = row.api_key
    result = await relay_service.test_target(target)
    row.last_test_ok = bool(result["ok"])
    row.last_test_at = utcnow()
    row.last_test_message = str(result.get("message") or "")[:300]
    await db.commit()
    return envelope({**result, "endpoint": target.endpoint, "model": target.model})


@router.post("/providers/test")
async def test_draft_provider(
    payload: ProviderTestRequest,
    user: User = Depends(get_current_user),
) -> dict:
    """未保存也能先测（避免「先存一份错的再改」）。"""
    _guard_test_rate(user.id)
    target = relay_service.build_target_from_draft(
        base_url=payload.base_url or "",
        api_key=payload.api_key or "",
        model=payload.model or "",
        kind=payload.kind or "compatible",
        supports_vision=bool(payload.supports_vision),
    )
    result = await relay_service.test_target(target)
    return envelope({**result, "endpoint": target.endpoint, "model": target.model})


@router.get("/status")
async def relay_status(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> dict:
    """当前是否可用：前端据此显示「未配置」引导，而不是等生成时才发现。

    额外给出 `fallback_models`（用户配置）与 `chain_preview`（**实际会遍历的链**）：
    二者不同是刻意的（存 3 试 2 + 跨 provider 追加），配置页据此做「失败时依次尝试」
    的预览，避免用户以为填了 3 个就会试 3 个。
    """
    target = await relay_service.resolve(db, user.id)
    if target is None:
        return envelope(
            RelayStatusOut(
                configured=False,
                source="none",
                reason="还没有可用的中转站：填一个自己的，或让管理员配置平台公共中转",
                skills_count=len(design_skills.SKILLS),
            ).model_dump()
        )
    # 只构造链、不发请求：状态接口不能被上游的 90 秒读超时拖住
    plan = await relay_chain.build_chain_plan(db, user.id, target)
    return envelope(
        RelayStatusOut(
            configured=True,
            source=target.source,
            provider_name=target.name,
            model=target.model,
            kind=target.kind,
            skills_count=len(design_skills.SKILLS),
            fallback_models=list(plan.fallback_models),
            chain_preview=list(plan.models),
            backup_provider=plan.backup_provider,
        ).model_dump()
    )


@router.get("/skills")
async def list_skills(
    user: User = Depends(get_current_user),
    category: str | None = Query(default=None),
    q: str | None = Query(default=None),
) -> dict:
    """设计技能库（分类 / 关键词过滤）。"""
    items = design_skills.list_skills(category, q)
    return envelope(
        {
            "items": [DesignSkillOut(**item.to_public()).model_dump() for item in items],
            "total": len(design_skills.SKILLS),
            "categories": [
                DesignSkillCategoryOut(**item).model_dump()
                for item in design_skills.categories_with_count()
            ],
        }
    )


@router.post("/polish")
async def polish(
    payload: PolishRequest,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """润色提示词：6 种模式 × 1–3 个变体；无中转站时走本地规则（engine=local）。

    提示词润色属于 Pro 功能：普通用户直接使用自己输入的原文，不会被改写。
    """
    result = await polish_service.polish(
        db,
        user.id,
        text=payload.text,
        scene=payload.scene,
        mode=payload.mode,
        variants=payload.variants,
        context=payload.context,
    )
    return envelope(PolishResult(**result).model_dump())
