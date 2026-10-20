"""技能包服务：加载内置技能包、解析用户有效技能集、注入提示词。

数据来源
--------
`app/data/skill_packs/*.json`，由两个离线脚本生成并**随代码提交**：
- `scripts/import_skill_prompts.py`：桌面提示词资源库（电商详情、海报、字体…）
- `scripts/export_design_skill_packs.py`：代码内的 78 条设计技能

运行时只读、`lru_cache` 缓存。技能是产品资产，不走数据库——后台改技能会导致
全站出图风格漂移，而且无法 review / 回滚。

有效技能集 = 团队包 ∪ 个人包 − 单条禁用
--------------------------------------
团队包是「公司统一要求的风格基线」，个人包是「我自己的偏好」；两者是并集，
因为企业用户既需要团队规范，也需要自己那套。禁用是最后一步，优先级最高。
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.skill_pack import (
    SOURCE_DEFAULT,
    SOURCE_ONBOARDING,
    TeamSkillPack,
    UserSkillOverride,
    UserSkillPack,
)
from app.models.user import User
from app.services import access
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.skill_packs")

DATA_DIR = Path(__file__).resolve().parent.parent / "data" / "skill_packs"
PERSONA_FILE = Path(__file__).resolve().parent.parent / "data" / "personas.json"

#: 没有任何选择时的兜底包：保证新用户永远有一个可用的技能集
FALLBACK_PACK = "general_design"
#: 注入提示词的条目上限（每条截断到 200 字，避免吃掉模型的注意力预算）
MAX_INJECT_ITEMS = 8
MAX_INJECT_CHARS = 200


@dataclass(frozen=True, slots=True)
class SkillItem:
    """技能包里的一个条目。"""

    id: str
    pack_key: str
    title: str
    summary: str
    prompt: str
    sub: str = ""
    aspect: str = ""
    tags: tuple[str, ...] = ()
    when_to_use: str = ""
    negative: str = ""
    slots: tuple[str, ...] = ()
    pitfalls: tuple[str, ...] = ()

    def to_public(self) -> dict[str, Any]:
        """列表/详情接口的返回结构。"""
        return {
            "id": self.id,
            "pack_key": self.pack_key,
            "title": self.title,
            "summary": self.summary,
            "prompt": self.prompt,
            "sub": self.sub,
            "aspect": self.aspect,
            "tags": list(self.tags),
            "when_to_use": self.when_to_use,
            "negative": self.negative,
            "slots": list(self.slots),
            "pitfalls": list(self.pitfalls),
        }


@dataclass(frozen=True, slots=True)
class SkillPack:
    """一个技能包。"""

    key: str
    name: str
    description: str
    personas: tuple[str, ...]
    tags: tuple[str, ...]
    category: str
    items: tuple[SkillItem, ...]

    def to_public(self, *, with_items: bool = False) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "key": self.key,
            "name": self.name,
            "description": self.description,
            "personas": list(self.personas),
            "tags": list(self.tags),
            "category": self.category,
            "count": len(self.items),
        }
        if with_items:
            payload["items"] = [item.to_public() for item in self.items]
        return payload


def _load_json(path: Path) -> dict[str, Any]:
    """读 JSON；坏文件返回空 dict 并记日志（不能让一个坏包拖垮整个服务）。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("技能包读取失败 %s：%s", path.name, exc)
        return {}


def _build_pack(path: Path) -> SkillPack | None:
    """把一份 JSON 转成不可变结构。"""
    data = _load_json(path)
    key = str(data.get("key") or path.stem)
    raw_items = data.get("items")
    if not isinstance(raw_items, list) or not raw_items:
        return None
    items: list[SkillItem] = []
    for raw in raw_items:
        if not isinstance(raw, dict):
            continue
        item_id = str(raw.get("id") or "").strip()
        prompt = str(raw.get("prompt") or "").strip()
        if not item_id or not prompt:
            continue
        items.append(
            SkillItem(
                id=item_id,
                pack_key=key,
                title=str(raw.get("title") or "")[:80],
                summary=str(raw.get("summary") or "")[:200],
                prompt=prompt,
                sub=str(raw.get("sub") or "")[:40],
                aspect=str(raw.get("aspect") or "")[:16],
                tags=tuple(str(tag) for tag in (raw.get("tags") or []) if tag),
                when_to_use=str(raw.get("when_to_use") or ""),
                negative=str(raw.get("negative") or ""),
                slots=tuple(str(slot) for slot in (raw.get("slots") or []) if slot),
                pitfalls=tuple(str(item) for item in (raw.get("pitfalls") or []) if item),
            )
        )
    if not items:
        return None
    return SkillPack(
        key=key,
        name=str(data.get("name") or key),
        description=str(data.get("description") or ""),
        personas=tuple(str(p) for p in (data.get("personas") or []) if p),
        tags=tuple(str(t) for t in (data.get("tags") or []) if t),
        category=str(data.get("category") or ""),
        items=tuple(items),
    )


@lru_cache(maxsize=1)
def load_packs() -> dict[str, SkillPack]:
    """加载全部技能包（进程内缓存）。"""
    packs: dict[str, SkillPack] = {}
    if not DATA_DIR.exists():
        logger.warning("技能包目录不存在：%s", DATA_DIR)
        return packs
    for path in sorted(DATA_DIR.glob("*.json")):
        if path.name == "index.json":
            continue
        pack = _build_pack(path)
        if pack is not None:
            packs[pack.key] = pack
    logger.info("已加载 %s 个技能包 / %s 条技能", len(packs), sum(len(p.items) for p in packs.values()))
    return packs


def get_pack(pack_key: str) -> SkillPack | None:
    return load_packs().get(pack_key)


def all_packs() -> list[SkillPack]:
    """全部技能包（按目录顺序）。"""
    return list(load_packs().values())


def items_by_id() -> dict[str, SkillItem]:
    """id → 条目（跨包索引）。"""
    index: dict[str, SkillItem] = {}
    for pack in load_packs().values():
        for item in pack.items:
            index.setdefault(item.id, item)
    return index


@lru_cache(maxsize=1)
def load_personas() -> tuple[dict[str, Any], ...]:
    """场景目录（引导页用）。"""
    data = _load_json(PERSONA_FILE)
    personas = data.get("personas")
    if not isinstance(personas, list):
        return ()
    result: list[dict[str, Any]] = []
    packs = load_packs()
    for raw in personas:
        if not isinstance(raw, dict) or not raw.get("key"):
            continue
        entry = dict(raw)
        # 只保留真实存在的包，避免引导页点了「启用」却什么都没发生
        entry["packs"] = [key for key in (raw.get("packs") or []) if key in packs]
        entry["pack_names"] = [packs[key].name for key in entry["packs"]]
        entry["skill_count"] = sum(len(packs[key].items) for key in entry["packs"])
        result.append(entry)
    return tuple(result)


def get_persona(persona_key: str) -> dict[str, Any] | None:
    for persona in load_personas():
        if persona.get("key") == persona_key:
            return dict(persona)
    return None


def validate_pack_keys(keys: list[str]) -> list[str]:
    """校验并规整包 key：未知包直接报错，避免「选了一个不存在的包」被静默吞掉。"""
    known = load_packs()
    cleaned: list[str] = []
    for key in keys:
        value = str(key or "").strip()
        if not value:
            continue
        if value not in known:
            raise AppError(ErrorCode.VALIDATION_ERROR, f"没有这个技能包：{value}")
        if value not in cleaned:
            cleaned.append(value)
    return cleaned


# --------------------------------------------------------------------------- #
# 用户级有效技能集
# --------------------------------------------------------------------------- #
async def user_pack_keys(db: AsyncSession, user: User) -> tuple[list[str], list[str]]:
    """返回 (团队包, 个人包)。"""
    personal = (
        await db.execute(
            select(UserSkillPack.pack_key).where(UserSkillPack.user_id == user.id)
        )
    ).scalars().all()
    team: list[str] = []
    ctx = await access.current_context(db, user)
    if ctx.team is not None:
        team = list(
            (
                await db.execute(
                    select(TeamSkillPack.pack_key).where(TeamSkillPack.team_id == ctx.team.id)
                )
            ).scalars().all()
        )
    return team, list(personal)


async def effective_items(db: AsyncSession, user: User) -> list[SkillItem]:
    """当前用户的全部可用技能条目（团队 ∪ 个人 − 禁用，按包顺序去重）。"""
    packs = load_packs()
    team_keys, personal_keys = await user_pack_keys(db, user)
    merged: list[str] = []
    for key in [*team_keys, *personal_keys]:
        if key in packs and key not in merged:
            merged.append(key)
    if not merged:
        merged = [FALLBACK_PACK] if FALLBACK_PACK in packs else list(packs)[:1]

    disabled = set(
        (
            await db.execute(
                select(UserSkillOverride.skill_id).where(
                    UserSkillOverride.user_id == user.id,
                    UserSkillOverride.enabled.is_(False),
                )
            )
        ).scalars().all()
    )
    items: list[SkillItem] = []
    seen: set[str] = set()
    for key in merged:
        for item in packs[key].items:
            if item.id in seen or item.id in disabled:
                continue
            seen.add(item.id)
            items.append(item)
    return items


async def resolve_pack_keys(db: AsyncSession, user: User) -> list[str]:
    """当前生效的包 key 列表（含兜底）。"""
    packs = load_packs()
    team_keys, personal_keys = await user_pack_keys(db, user)
    merged: list[str] = []
    for key in [*team_keys, *personal_keys]:
        if key in packs and key not in merged:
            merged.append(key)
    if not merged:
        merged = [FALLBACK_PACK] if FALLBACK_PACK in packs else list(packs)[:1]
    return merged


async def set_user_packs(
    db: AsyncSession, user: User, pack_keys: list[str], source: str = SOURCE_ONBOARDING
) -> list[str]:
    """替换用户的个人技能包选择（幂等：重复调用结果一致）。"""
    cleaned = validate_pack_keys(pack_keys)
    existing = (
        await db.execute(select(UserSkillPack).where(UserSkillPack.user_id == user.id))
    ).scalars().all()
    keep = set(cleaned)
    for row in existing:
        if row.pack_key not in keep:
            await db.delete(row)
    current = {row.pack_key for row in existing}
    for key in cleaned:
        if key not in current:
            db.add(
                UserSkillPack(
                    user_id=user.id,
                    pack_key=key,
                    source=source,
                )
            )
    await db.flush()
    return cleaned


async def toggle_item(db: AsyncSession, user: User, skill_id: str, enabled: bool) -> None:
    """单条技能开关（默认启用，关闭才落行）。"""
    if skill_id not in items_by_id():
        raise AppError(ErrorCode.VALIDATION_ERROR, "没有这条技能")
    row = (
        await db.execute(
            select(UserSkillOverride).where(
                UserSkillOverride.user_id == user.id,
                UserSkillOverride.skill_id == skill_id,
            )
        )
    ).scalar_one_or_none()
    if enabled:
        if row is not None:
            await db.delete(row)
    else:
        if row is None:
            db.add(UserSkillOverride(user_id=user.id, skill_id=skill_id, enabled=False))
        else:
            row.enabled = False
    await db.flush()


async def set_team_packs(
    db: AsyncSession, team_id: str, pack_keys: list[str]
) -> list[str]:
    """替换团队默认技能包（调用方负责权限校验）。"""
    cleaned = validate_pack_keys(pack_keys)
    existing = (
        await db.execute(select(TeamSkillPack).where(TeamSkillPack.team_id == team_id))
    ).scalars().all()
    keep = set(cleaned)
    for row in existing:
        if row.pack_key not in keep:
            await db.delete(row)
    current = {row.pack_key for row in existing}
    for key in cleaned:
        if key not in current:
            db.add(TeamSkillPack(team_id=team_id, pack_key=key))
    await db.flush()
    return cleaned


async def team_pack_keys(db: AsyncSession, team_id: str) -> list[str]:
    return list(
        (
            await db.execute(
                select(TeamSkillPack.pack_key).where(TeamSkillPack.team_id == team_id)
            )
        ).scalars().all()
    )


async def apply_persona(db: AsyncSession, user: User, persona_key: str) -> list[str]:
    """把场景的推荐包写入用户选择（引导完成时调用）。"""
    persona = get_persona(persona_key)
    if persona is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "没有这个使用场景")
    keys = validate_pack_keys(list(persona.get("packs") or []))
    if not keys:
        keys = [FALLBACK_PACK] if FALLBACK_PACK in load_packs() else []
    return await set_user_packs(db, user, keys, source=SOURCE_DEFAULT)


# --------------------------------------------------------------------------- #
# 提示词注入
# --------------------------------------------------------------------------- #
def render_for_prompt(items: list[SkillItem], limit: int = MAX_INJECT_ITEMS) -> str:
    """把技能条目渲染成紧凑的提示词片段。

    只给「名称 + 适用场景 + 骨架前 200 字」：技能是**参考**，不是模板填空。
    给太多细节会把用户的原始需求挤掉，模型反而照着模板抄。
    """
    if not items:
        return ""
    lines: list[str] = ["## 可用的技能包参考（用户已启用，按需参考，不要照抄）"]
    for item in items[:limit]:
        body = " ".join(item.prompt.split())[:MAX_INJECT_CHARS]
        hint = item.when_to_use or item.summary
        lines.append(f"- {item.title}｜{hint}｜参考骨架：{body}")
    return "\n".join(lines)


def match_items(items: list[SkillItem], text: str, limit: int = MAX_INJECT_ITEMS) -> list[SkillItem]:
    """按关键词粗筛（确定性、可单测）。

    打分：标题命中 +6、标签命中 +4、正文二元组重合最多 +4、子分类命中 +2。
    不做语义检索——对话主链路已经有一次模型调用，这里只需要把明显相关的挑出来。
    """
    query = (text or "").lower().strip()
    if not query:
        return items[:limit]

    def bigrams(value: str) -> set[str]:
        compact = "".join(value.split())
        return {compact[i : i + 2] for i in range(len(compact) - 1)}

    query_grams = bigrams(query)
    scored: list[tuple[float, SkillItem]] = []
    for item in items:
        score = 0.0
        if item.title and item.title.lower() in query:
            score += 6
        for tag in item.tags:
            if tag and tag.lower() in query:
                score += 4
        if item.sub and item.sub.lower() in query:
            score += 2
        body = f"{item.title}{item.summary}{item.when_to_use}{item.prompt}"
        overlap = len(query_grams & bigrams(body.lower()))
        score += min(overlap, 8) * 0.5
        if score > 0:
            scored.append((score, item))
    scored.sort(key=lambda pair: pair[0], reverse=True)
    picked = [item for _, item in scored[:limit]]
    return picked or items[:limit]


__all__ = [
    "FALLBACK_PACK",
    "SkillItem",
    "SkillPack",
    "all_packs",
    "apply_persona",
    "effective_items",
    "get_pack",
    "get_persona",
    "items_by_id",
    "load_packs",
    "load_personas",
    "match_items",
    "render_for_prompt",
    "resolve_pack_keys",
    "set_team_packs",
    "set_user_packs",
    "team_pack_keys",
    "toggle_item",
    "user_pack_keys",
    "validate_pack_keys",
]
