"""设计技能库：把「专业设计师的套路」固化成可检索、可注入提示词的资产。

为什么要它
----------
技能库保存可选的行业模板，包括版式结构、配色逻辑、质感词和常见风险。
只有显式选择模板的流程才会引用它；原话直用的生图流程不会自动把模板加进用户提示词。

约定
----
- 纯数据 + 纯函数，不依赖数据库：技能是**产品资产**，随代码版本走，
  默认数据存放在 JSON 资源中，管理员可以在系统配置里覆盖并即时生效。
- `prompt_scaffold` 里用中文占位符（如「{主体}」），**刻意不用英文大括号**，
  以免与 JSON / `str.format` 冲突。
- `negative` 是该场景真正容易画坏的东西，不是通用「低质量」堆砌。
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.utils.logging import get_logger

logger = get_logger("app.design_skills")

CATEGORIES: list[dict[str, str]] = [
    {"id": "brand", "name": "品牌与标识", "description": "Logo、VI、包装、品牌手册视觉"},
    {"id": "poster", "name": "海报与主视觉", "description": "活动海报、电影感、国潮、复古印刷"},
    {"id": "social", "name": "社媒与封面", "description": "小红书、朋友圈、公众号、课程与播客封面"},
    {"id": "ecommerce", "name": "电商与产品", "description": "主图、详情页、场景合成、模特展示"},
    {"id": "ui", "name": "UI 与界面", "description": "App、落地页、后台、图标、组件风格"},
    {"id": "illustration", "name": "插画与角色", "description": "扁平、手绘、3D 角色、二次元、像素"},
    {"id": "photo", "name": "摄影与写实", "description": "人像、产品、建筑、美食、胶片质感"},
    {"id": "type", "name": "字体与排版", "description": "标题字、字体设计、文字海报、排版规则"},
    {"id": "color", "name": "色彩与光影", "description": "配色方案、渐变、电影调色、霓虹光效"},
    {"id": "layout", "name": "版式与构图", "description": "网格系统、杂志跨页、信息图、折页"},
    {"id": "print", "name": "印刷物料", "description": "菜单、价签、名片、简历、邀请函、证书"},
    {"id": "deck", "name": "演示与图表", "description": "PPT 封面与内容页、流程图、架构图"},
    {"id": "audio", "name": "音频与书籍封面", "description": "播客、专辑、书封、有声书"},
    {"id": "merch", "name": "周边与延展", "description": "T恤印花、贴纸、表情包、IP 三视图"},
    {"id": "avatar", "name": "头像与壁纸", "description": "社交头像、手机壁纸、直播间背景"},
    {"id": "three_d", "name": "3D 与材质", "description": "3D 渲染、粘土、玻璃、金属、等距场景"},
]


@dataclass(frozen=True)
class DesignSkill:
    """一条设计技能。

    `slots` 是结构化参数（构图/光线/色彩/材质/文字…）：比一整段散文更容易被
    模型稳定执行。没有显式 slots 的技能，会从 `prompt_scaffold` 里按标签抽取。
    """

    id: str
    name: str
    category: str
    description: str
    when_to_use: str = ""
    prompt_scaffold: str = ""
    negative: str = ""
    aspect: str = ""
    style_tags: list[str] = field(default_factory=list)
    slots: dict[str, str] = field(default_factory=dict)
    pitfalls: list[str] = field(default_factory=list)

    def resolved_slots(self) -> dict[str, str]:
        """显式 slots 优先，缺的从骨架里按「标签：内容」抽取。"""
        merged = dict(self.slots)
        for key, value in extract_slots(self.prompt_scaffold).items():
            merged.setdefault(key, value)
        return merged

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "description": self.description,
            "when_to_use": self.when_to_use,
            "prompt_scaffold": self.prompt_scaffold,
            "negative": self.negative,
            "aspect": self.aspect,
            "style_tags": list(self.style_tags),
            "slots": self.resolved_slots(),
            "pitfalls": list(self.pitfalls),
        }


# 骨架里常见的参数标签：抽出来做结构化注入
_SLOT_LABELS = (
    "构图",
    "版式",
    "结构",
    "布局",
    "排列",
    "光线",
    "光影",
    "布光",
    "色彩",
    "配色",
    "材质",
    "质感",
    "字体",
    "文字",
    "镜头",
    "视角",
    "渲染",
    "工艺",
    "网格",
    "节奏",
    "主体",
)
_SLOT_PATTERN = re.compile(
    "(" + "|".join(_SLOT_LABELS) + r")[：:]\s*([^；;。\n]+)"
)


def extract_slots(scaffold: str) -> dict[str, str]:
    """从「构图：…；光线：…」这类骨架里抽出结构化参数。"""
    slots: dict[str, str] = {}
    for label, value in _SLOT_PATTERN.findall(scaffold or ""):
        text = value.strip()
        if text and label not in slots:
            slots[label] = text[:120]
    return slots


def list_skills(
    category: str | None = None,
    query: str | None = None,
    catalog: list[DesignSkill] | None = None,
) -> list[DesignSkill]:
    """按分类 / 关键词过滤技能。"""
    items = catalog if catalog is not None else SKILLS
    if category:
        items = [item for item in items if item.category == category]
    if query:
        keyword = query.strip().lower()
        if keyword:
            items = [
                item
                for item in items
                if keyword in item.name.lower()
                or keyword in item.description.lower()
                or keyword in item.when_to_use.lower()
                or any(keyword in tag.lower() for tag in item.style_tags)
                or keyword in item.id.lower()
            ]
    return items


def get_skill(
    skill_id: str | None, catalog: list[DesignSkill] | None = None
) -> DesignSkill | None:
    """按 id 取技能（未知 id 返回 None，调用方不得凭空造技能）。"""
    if not skill_id:
        return None
    items = catalog if catalog is not None else SKILLS
    return next((item for item in items if item.id == skill_id.strip()), None)


def categories_with_count(catalog: list[DesignSkill] | None = None) -> list[dict[str, Any]]:
    """分类 + 数量（前端分类导航用）。"""
    counts: dict[str, int] = {}
    items = catalog if catalog is not None else SKILLS
    for item in items:
        counts[item.category] = counts.get(item.category, 0) + 1
    return [{**category, "count": counts.get(category["id"], 0)} for category in CATEGORIES]


def render_catalog(limit: int = 24, catalog: list[DesignSkill] | None = None) -> str:
    """生成注入提示词的紧凑技能清单。

    只给 id / 名称 / 一句话适用场景：给太多细节会挤占模型注意力，
    真正的参数（版式、配色、负面词）在选定技能后再单独注入。
    """
    lines: list[str] = []
    for item in (catalog if catalog is not None else SKILLS)[:limit]:
        lines.append(f"- {item.id}｜{item.name}｜{item.description}")
    return "\n".join(lines)


def render_detail(skill_id: str | None, catalog: list[DesignSkill] | None = None) -> str:
    """把选中技能的全部参数展开成提示词素材（结构化槽位优先）。"""
    skill = get_skill(skill_id, catalog)
    if skill is None:
        return ""
    parts = [
        f"技能：{skill.name}（{skill.category}）",
        f"适用：{skill.when_to_use}",
        f"提示词骨架：{skill.prompt_scaffold}",
    ]
    slots = skill.resolved_slots()
    if slots:
        parts.append(
            "结构化参数：" + "；".join(f"{key}={value}" for key, value in slots.items())
        )
    if skill.negative:
        parts.append(f"必须避免：{skill.negative}")
    if skill.pitfalls:
        parts.append("常见翻车：" + "；".join(skill.pitfalls))
    if skill.aspect:
        parts.append(f"推荐画幅：{skill.aspect}")
    if skill.style_tags:
        parts.append(f"风格关键词：{'、'.join(skill.style_tags)}")
    return "\n".join(parts)


def _from_record(value: Any) -> DesignSkill | None:
    if not isinstance(value, dict):
        return None
    skill_id = str(value.get("id") or "").strip()
    name = str(value.get("name") or "").strip()
    if not skill_id or not name:
        return None
    slots = value.get("slots") if isinstance(value.get("slots"), dict) else {}
    tags = value.get("style_tags") if isinstance(value.get("style_tags"), list) else []
    pitfalls = value.get("pitfalls") if isinstance(value.get("pitfalls"), list) else []
    return DesignSkill(
        id=skill_id[:120],
        name=name[:120],
        category=str(value.get("category") or "custom")[:80],
        description=str(value.get("description") or "")[:1000],
        when_to_use=str(value.get("when_to_use") or "")[:1000],
        prompt_scaffold=str(value.get("prompt_scaffold") or "")[:4000],
        negative=str(value.get("negative") or "")[:500],
        aspect=str(value.get("aspect") or "")[:32],
        style_tags=[str(item)[:80] for item in tags if str(item).strip()][:20],
        slots={str(key)[:80]: str(item)[:500] for key, item in slots.items()},
        pitfalls=[str(item)[:300] for item in pitfalls if str(item).strip()][:30],
    )


def _load_bundled_skills() -> list[DesignSkill]:
    """Load the shipped seed catalog from its editable JSON resource."""
    values = json.loads(Path(__file__).with_name("design_skills.json").read_text(encoding="utf-8"))
    return [skill for item in values if (skill := _from_record(item))]


SKILLS: list[DesignSkill] = _load_bundled_skills()


async def load_catalog(db: AsyncSession | None) -> list[DesignSkill]:
    """Load the admin-managed catalog at request time; blank config uses the JSON seed."""
    if db is not None:
        from app.services import config_service

        raw = await config_service.get_raw(db, "DESIGN_SKILLS_JSON", "")
        if raw and raw.strip():
            try:
                values = json.loads(raw)
                if isinstance(values, list):
                    return [skill for item in values if (skill := _from_record(item))]
            except (TypeError, ValueError):
                logger.warning("DESIGN_SKILLS_JSON 不是合法技能数组，使用默认技能库")
    return list(SKILLS)


def filter_catalog(
    items: list[DesignSkill], category: str | None = None, query: str | None = None
) -> list[DesignSkill]:
    filtered = [item for item in items if not category or item.category == category]
    needle = (query or "").strip().lower()
    if not needle:
        return filtered
    return [
        item
        for item in filtered
        if needle in " ".join(
            [item.id, item.name, item.description, item.when_to_use, item.prompt_scaffold, *item.style_tags]
        ).lower()
    ]


def catalog_categories(items: list[DesignSkill]) -> list[dict[str, Any]]:
    counts: dict[str, int] = {}
    for item in items:
        counts[item.category] = counts.get(item.category, 0) + 1
    categories = {str(item["id"]): item for item in CATEGORIES}
    for category in counts:
        categories.setdefault(category, {"id": category, "name": category, "description": ""})
    return [{**item, "count": counts[key]} for key, item in categories.items() if counts.get(key)]
