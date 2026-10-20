#!/usr/bin/env python3
"""把代码里的设计技能（`design_skills.SKILLS`）导出为技能包 JSON。

为什么需要这一步
----------------
技能包（`app/data/skill_packs/*.json`）是统一的数据形态：引导页选场景 → 启用包 →
对话时注入。电商类内容来自桌面提示词资源库（`scripts/import_skill_prompts.py`），
而 UI / 品牌 / 通用这些**本来就是代码里的 78 条设计技能**。把两者对齐成同一种
JSON，运行时只需要一个加载器，不必写两套「取技能」的逻辑。

用法
----
    python scripts/export_design_skill_packs.py            # 写盘
    python scripts/export_design_skill_packs.py --check    # 只统计
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
BACKEND = REPO_ROOT / "backend"
OUT_DIR = BACKEND / "app" / "data" / "skill_packs"

sys.path.insert(0, str(BACKEND))

from app.services import design_skills  # noqa: E402

#: 目录展示顺序（未列出的包按 key 排在最后）
PACK_ORDER = [
    "ecommerce_detail",
    "ecommerce_poster",
    "promo_poster",
    "festival_poster",
    "social_cover",
    "font_effect",
    "dev_ui",
    "brand_vi",
    "packaging",
    "film_poster",
    "guofeng_poster",
    "food_poster",
    "book_cover",
    "creative_play",
    "photo_edit",
    "general_design",
]


def rebuild_index(out_dir: Path, source: str = "") -> dict:
    """扫描目录重建 index.json。

    两个导入脚本各写各的包，索引必须由**目录实际内容**推导，而不是由某个脚本
    自己维护一份清单——否则先后执行两个脚本时，后执行的会把前一个的条目挤掉。
    """
    packs: list[dict] = []
    for path in sorted(out_dir.glob("*.json")):
        if path.name == "index.json":
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            continue
        packs.append(
            {
                "key": data.get("key", path.stem),
                "name": data.get("name", path.stem),
                "description": data.get("description", ""),
                "personas": data.get("personas", []),
                "tags": data.get("tags", []),
                "category": data.get("category", ""),
                "count": int(data.get("count") or len(data.get("items") or [])),
            }
        )
    order = {key: index for index, key in enumerate(PACK_ORDER)}
    packs.sort(key=lambda item: (order.get(item["key"], len(PACK_ORDER)), item["key"]))
    index = {
        "version": 1,
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": source,
        "total_items": sum(item["count"] for item in packs),
        "packs": packs,
    }
    (out_dir / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return index


#: 包 → 从设计技能里取哪些分类
PACKS: list[dict] = [
    {
        "key": "dev_ui",
        "name": "开发与 UI",
        "description": "界面稿、组件风格、图标、流程图与架构图：把需求落成可交付的视觉。",
        "personas": ["developer", "ui_designer"],
        "tags": ["UI", "界面", "架构图", "流程图", "图标"],
        "category": "ui",
        "categories": ["ui", "deck", "layout", "color"],
    },
    {
        "key": "brand_vi",
        "name": "品牌与 VI",
        "description": "LOGO、品牌视觉、印刷物料与周边延展，构成一套完整的品牌资产。",
        "personas": ["brand"],
        "tags": ["品牌", "LOGO", "VI", "印刷"],
        "category": "brand",
        "categories": ["brand", "print", "merch", "type"],
    },
    {
        "key": "general_design",
        "name": "通用设计",
        "description": "覆盖插画、摄影、海报、社媒、3D、音频封面的通用技能集，什么都能起步。",
        "personas": ["general"],
        "tags": ["通用", "插画", "摄影", "海报", "3D"],
        "category": "general",
        "categories": [
            "illustration",
            "photo",
            "poster",
            "social",
            "three_d",
            "audio",
            "avatar",
            "ecommerce",
        ],
    },
]


def build(spec: dict) -> dict:
    """按分类挑选技能并转成技能包条目。"""
    items: list[dict] = []
    for skill in design_skills.SKILLS:
        if skill.category not in spec["categories"]:
            continue
        prompt = (skill.prompt_scaffold or "").strip()
        if not prompt:
            continue
        items.append(
            {
                "id": skill.id,
                "title": skill.name,
                "summary": skill.description,
                "prompt": prompt,
                "sub": skill.category,
                "aspect": (skill.aspect or "").strip(),
                "tags": list(skill.style_tags),
                "when_to_use": skill.when_to_use,
                "negative": skill.negative,
                "slots": list(skill.slots),
                "pitfalls": skill.pitfalls,
            }
        )
    items.sort(key=lambda item: (item["sub"], item["id"]))
    return {
        "key": spec["key"],
        "name": spec["name"],
        "description": spec["description"],
        "personas": spec["personas"],
        "tags": spec["tags"],
        "category": spec["category"],
        "sources": ["backend/app/services/design_skills.py"],
        "count": len(items),
        "items": items,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="把设计技能导出为技能包 JSON")
    parser.add_argument("--check", action="store_true", help="只统计，不写盘")
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    total = 0
    for spec in PACKS:
        pack = build(spec)
        total += pack["count"]
        print(f"→ {pack['key']}：{pack['count']} 条")
        if not args.check:
            (OUT_DIR / f"{pack['key']}.json").write_text(
                json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
    print(f"合计 {total} 条")
    if not args.check:
        index = rebuild_index(OUT_DIR, source="backend/app/services/design_skills.py")
        print(f"索引：{len(index['packs'])} 个包 / {index['total_items']} 条")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
