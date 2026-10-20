#!/usr/bin/env python3
"""把桌面提示词资源库导入为结构化技能包（离线一次性脚本）。

用法
----
    python scripts/import_skill_prompts.py --src ~/Desktop/skills提示词
    python scripts/import_skill_prompts.py --src ... --check   # 只校验不写盘

产出
----
    backend/app/data/skill_packs/<pack_key>.json   每个技能包一个文件
    backend/app/data/skill_packs/index.json        包目录（含条数与场景映射）

为什么要离线导入而不是运行时读桌面
----------------------------------
1. 技能内容是**产品资产**：必须随代码版本走，才能 review、回滚、灰度；
2. 桌面目录在服务器上根本不存在；
3. 解析 docx/xlsx 有依赖（python-docx / openpyxl），不该成为线上运行时依赖。

清洗规则（都在 `_clean_prompt` 里）
-----------------------------------
- 去掉 URL、二维码文案、「点击蓝字跳转」、联系方式（微信/QQ/手机号）、
  以及「本套提示词仅供学习」这类声明——这些是资源包的营销外壳，不是提示词；
- 去掉纯标题行（如「耳机首屏提示词1」「一、整体风格延续提示词」）；
- 去重（同一提示词在多个文档里重复出现很常见）；
- 单条截断到 900 字：再长就不是「提示词」，而是教程正文。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / "backend" / "app" / "data" / "skill_packs"

#: 单条提示词长度上限
MAX_PROMPT_CHARS = 900
#: 小于这个长度基本是标题 / 过渡句，不是提示词
MIN_PROMPT_CHARS = 45
#: 单个技能包的条数上限（防止某份文档把 200 条教程全塞进来）
MAX_ITEMS_PER_PACK = 60

URL_RE = re.compile(r"https?://\S+|www\.\S+")
# 联系方式：微信/QQ/手机号/邮箱（资源包末尾常见「加我领资料」）
CONTACT_RE = re.compile(
    r"(微信|威信|weixin|wechat|vx|v信|公众号|QQ群|qq群|加群|客服微信)\s*[:：]?\s*[\w\-]*"
    r"|1[3-9]\d{9}"
    r"|[\w.+-]+@[\w-]+\.[\w.]+",
    re.IGNORECASE,
)
# 营销外壳 / 免责声明 / 跳转提示
NOISE_PATTERNS = (
    "点击蓝字",
    "跳转到工具主页",
    "仅供学习",
    "仅供交流",
    "请勿商用",
    "如有侵权",
    "关注公众号",
    "扫码",
    "二维码",
    "领取资料",
    "免费领取",
    "更新赠送",
    "飞书文档",
    "加我",
    "私信",
)
# 纯标题行：编号开头 / 以「提示词」结尾 / 很短且无标点
TITLE_RE = re.compile(
    r"^(\d+[、.．)）]|[一二三四五六七八九十]+[、.．]|第[一二三四五六七八九十]+[章节]|\(?\d+\)|（\d+）)"
)
TITLE_TAIL_RE = re.compile(r"(提示词|prompt|指南|教程|合集|方案|模板)\s*\d*[:：]?$", re.IGNORECASE)
# 中文标点：用于判断「这是句子不是标题」
SENTENCE_PUNCT = "，。；：、！？,.;:!?"


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


@dataclass
class PackSpec:
    """一个技能包的导入声明。"""

    key: str
    name: str
    description: str
    personas: list[str]
    tags: list[str]
    #: 相对 `--src` 的文件或目录
    sources: list[str]
    #: 显式的分类名（docx 内部的小标题会作为子分类提示）
    category: str = ""
    #: xlsx 需要按 sheet 拆分
    xlsx_sheets: dict[str, str] = field(default_factory=dict)


#: 导入清单：pack_key → 来源。顺序决定 index.json 的展示顺序。
PACK_SPECS: list[PackSpec] = [
    PackSpec(
        key="ecommerce_detail",
        name="电商详情页",
        description="从首屏到行动号召的完整详情页链路：3C、分子图、文生图/图生图/融图、LOGO 与详情页方法论。",
        personas=["ecommerce"],
        tags=["电商", "详情页", "主图", "转化"],
        sources=["7.AI电商详情设计提示词"],
        category="ecommerce",
    ),
    PackSpec(
        key="ecommerce_poster",
        name="电商海报",
        description="大促、年货节、新品首发的电商海报：C4D 展台、立体字、优惠券与价格锚点。",
        personas=["ecommerce", "marketing"],
        tags=["电商", "海报", "大促", "618", "双11"],
        sources=["2、AI海报设计提示词/电商海报设计提示词"],
        category="ecommerce",
    ),
    PackSpec(
        key="promo_poster",
        name="商业促销海报",
        description="通用商业促销：价格力、限时、爆款单品，适合门店与品牌活动。",
        personas=["marketing", "ecommerce"],
        tags=["海报", "促销", "商业"],
        sources=["2、AI海报设计提示词/商业与促销海报提示词"],
        category="poster",
    ),
    PackSpec(
        key="festival_poster",
        name="节气节庆海报",
        description="24 节气与传统节庆营销海报，含时令物候与节庆色彩体系。",
        personas=["marketing"],
        tags=["节气", "节庆", "海报", "国潮"],
        sources=["2、AI海报设计提示词/节气节庆海报提示词"],
        category="poster",
    ),
    PackSpec(
        key="film_poster",
        name="电影海报",
        description="电影感构图与光影：情绪片、类型片、人物特写的叙事化排版。",
        personas=["content", "marketing"],
        tags=["电影", "海报", "叙事", "光影"],
        sources=["2、AI海报设计提示词/电影海报设计提示词"],
        category="poster",
    ),
    PackSpec(
        key="guofeng_poster",
        name="国风海报",
        description="国风与东方美学：水墨、青绿、篆刻、留白与卷轴版式。",
        personas=["marketing", "brand"],
        tags=["国风", "东方", "水墨", "海报"],
        sources=["2、AI海报设计提示词/国风海报设计提示词"],
        category="poster",
    ),
    PackSpec(
        key="food_poster",
        name="美食海报",
        description="民族食物与餐饮海报：热气、油脂、食材堆叠与食欲光。",
        personas=["marketing", "ecommerce"],
        tags=["美食", "餐饮", "海报"],
        sources=["2、AI海报设计提示词/民族食物海报提示词"],
        category="poster",
    ),
    PackSpec(
        key="book_cover",
        name="图书封面",
        description="图书与出版物封面：版式层级、书名排版、系列感。",
        personas=["content", "brand"],
        tags=["封面", "出版", "排版"],
        sources=["2、AI海报设计提示词/图书封面设计提示词"],
        category="print",
    ),
    PackSpec(
        key="social_cover",
        name="自媒体封面",
        description="小红书/公众号/短视频封面：大字标题、撕纸、拼贴、高点击率版式。",
        personas=["marketing", "content"],
        tags=["封面", "小红书", "自媒体", "标题"],
        sources=["3、封面设计提示词"],
        category="social",
    ),
    PackSpec(
        key="packaging",
        name="产品包装",
        description="包装设计与草图：结构、材质、工艺与国潮文创多图融合。",
        personas=["brand"],
        tags=["包装", "结构", "工艺", "文创"],
        sources=["4、AI产品包装设计提示词"],
        category="print",
    ),
    PackSpec(
        key="creative_play",
        name="创意玩法",
        description="像素风、祈运壁纸、鱼眼自拍与创意海报：社交传播向的新奇视觉。",
        personas=["content"],
        tags=["创意", "像素", "壁纸", "鱼眼"],
        sources=["5、创意玩法提示词"],
        category="illustration",
    ),
    PackSpec(
        key="photo_edit",
        name="P 图与反推",
        description="图生图与提示词反推：把一张图拆成可复现的结构化提示词，再做风格迁移。",
        personas=["ecommerce", "general", "content"],
        tags=["反推", "图生图", "P图", "风格迁移"],
        sources=["6.AI反推图片提示词教程", "AI生图 P图提示词合集"],
        category="photo",
    ),
    PackSpec(
        key="font_effect",
        name="字体字效",
        description="205 套字体字效：书法、艺术风格、文艺创意、3D 电商与游戏字体。",
        personas=["brand", "ui_designer", "marketing"],
        tags=["字体", "字效", "3D", "书法"],
        sources=["1、AI字体与风格提示词/AI字体字效提示词(205套）.xlsx"],
        category="type",
    ),
]

#: xlsx sheet → 子分类（仅 font_effect 用到）
XLSX_SHEET_CATEGORY = {
    "书法字体prompt": "书法",
    "艺术风格prompt": "艺术风格",
    "文艺&创意字体prompt": "文艺创意",
    "3D电商&游戏字体prompt": "3D电商",
}


def _is_noise(text: str) -> bool:
    """是否是营销外壳 / 免责声明 / 跳转提示。"""
    return any(pattern in text for pattern in NOISE_PATTERNS)


def _is_title(text: str) -> bool:
    """是否是标题行而不是提示词正文。"""
    stripped = text.strip()
    if len(stripped) <= 24:
        # 短且没有句子标点：标题
        if not any(ch in stripped for ch in SENTENCE_PUNCT):
            return True
    if TITLE_RE.match(stripped) and len(stripped) < 40:
        return True
    if TITLE_TAIL_RE.search(stripped) and len(stripped) < 40:
        return True
    return False


def _clean_prompt(raw: str) -> str:
    """清洗单条提示词。"""
    text = raw.replace("\u3000", " ").replace("\xa0", " ")
    text = URL_RE.sub("", text)
    text = CONTACT_RE.sub("", text)
    # 压掉连续空白，但保留换行（有些提示词靠换行分段）
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip(" \n·-—|")


def _title_from(text: str, fallback: str) -> str:
    """给一条提示词起标题：取首句前 18 字，去掉标点。

    引号要在截断**之前**剥掉：资源包里大量提示词是「字体"XX"设计…」这种句式，
    直接截 18 字会切在一个开引号后面，标题看起来像被吞了一半。
    """
    head = re.split(r"[。；！？\n]", text.strip(), maxsplit=1)[0]
    head = re.sub(r"[“”\"'「」『』]", "", head)
    head = head.strip(" ，,、:：")
    if not head:
        head = fallback
    return head if len(head) <= 18 else f"{head[:17]}…"


def _item_id(pack_key: str, title: str, prompt: str) -> str:
    """稳定 id：同一条提示词每次导入都得到同一个 id（协作/统计不会漂移）。"""
    digest = hashlib.sha1(prompt.encode("utf-8")).hexdigest()[:10]
    slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:24]
    return f"{pack_key}__{slug or 'item'}-{digest}"


def _guess_aspect(text: str) -> str:
    """从文案里猜画面比例（资源包里常写「竖版」「3:4」「9:16」）。"""
    match = re.search(r"(\d{1,2})\s*[:：]\s*(\d{1,2})", text)
    if match:
        w, h = int(match.group(1)), int(match.group(2))
        if 1 <= w <= 32 and 1 <= h <= 32:
            return f"{w}:{h}"
    if any(word in text for word in ("竖版", "竖构图", "手机海报", "全屏")):
        return "3:4"
    if any(word in text for word in ("横版", "横构图", "banner", "横幅")):
        return "16:9"
    if any(word in text for word in ("方形", "方图", "1:1")):
        return "1:1"
    return ""


def _iter_docx_prompts(path: Path):
    """从 docx 提取候选提示词段落（含表格单元格）。"""
    try:
        import docx  # 延迟导入：只有导入时才需要这个依赖
    except ImportError:  # pragma: no cover
        raise SystemExit("需要 python-docx：pip install python-docx")
    document = docx.Document(str(path))
    for paragraph in document.paragraphs:
        text = paragraph.text.strip()
        if text:
            yield text
    for table in document.tables:
        for row in table.rows:
            for cell in row.cells:
                text = cell.text.strip()
                if text and "\n" not in text:
                    yield text
                elif text:
                    for line in text.split("\n"):
                        if line.strip():
                            yield line.strip()


def _iter_xlsx_prompts(path: Path):
    """从 xlsx 提取 (子分类, 提示词)。表格布局是「序号 | 提示词 | 效果图」重复多列。

    按 sheet **轮转**输出，而不是一个 sheet 抽完再抽下一个：包有 60 条上限，
    顺序抽取会让第一个 sheet（书法 40 套）把名额吃光，用户在「字体字效」里
    永远看不到 3D 电商与游戏字体。轮转后每个子分类都能被代表到。
    """
    try:
        import openpyxl
    except ImportError:  # pragma: no cover
        raise SystemExit("需要 openpyxl：pip install openpyxl")
    workbook = openpyxl.load_workbook(str(path), read_only=True, data_only=True)
    buckets: list[tuple[str, list[str]]] = []
    for sheet_name in workbook.sheetnames:
        category = XLSX_SHEET_CATEGORY.get(sheet_name, sheet_name)
        sheet = workbook[sheet_name]
        values: list[str] = []
        for row in sheet.iter_rows(values_only=True):
            for value in row:
                if not isinstance(value, str):
                    continue
                text = value.strip()
                if len(text) < MIN_PROMPT_CHARS:
                    continue
                # 表头与说明行
                if text in ("提示词", "序号", "效果图") or _is_noise(text):
                    continue
                values.append(text)
        if values:
            buckets.append((category, values))

    cursors = [0] * len(buckets)
    while True:
        progressed = False
        for index, (category, values) in enumerate(buckets):
            if cursors[index] < len(values):
                yield category, values[cursors[index]]
                cursors[index] += 1
                progressed = True
        if not progressed:
            break


def _docx_paragraphs_via_zip(path: Path) -> list[str]:
    """兜底解析：直接读 docx 里的 word/document.xml。

    有些资源包被工具重新打包过，`word/_rels/document.xml.rels` 里挂着
    `Target="NULL"` 的坏关系，python-docx 会在 `Document()` 阶段直接抛
    "There is no item named 'NULL' in the archive"。这类文件正文其实是好的，
    按 `<w:p>` 段落切一遍就能拿到文字，没必要整份丢掉。
    """
    import zipfile
    from xml.etree import ElementTree

    ns = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
    try:
        with zipfile.ZipFile(path) as archive:
            xml = archive.read("word/document.xml")
    except (KeyError, zipfile.BadZipFile, OSError):
        return []
    try:
        root = ElementTree.fromstring(xml)
    except ElementTree.ParseError:
        return []
    paragraphs: list[str] = []
    for para in root.iter(f"{ns}p"):
        chunks = [node.text or "" for node in para.iter(f"{ns}t")]
        text = "".join(chunks).strip()
        if text:
            paragraphs.append(text)
    return paragraphs


def _collect_file(path: Path, spec: PackSpec) -> list[dict]:
    """从一个文件收集条目。"""
    items: list[dict] = []
    if path.suffix.lower() == ".xlsx":
        for category, raw in _iter_xlsx_prompts(path):
            prompt = _clean_prompt(raw)
            if len(prompt) < MIN_PROMPT_CHARS or _is_title(prompt):
                continue
            items.append({"raw": prompt, "sub": category})
        return items

    if path.suffix.lower() == ".docx":
        # 子分类来自文档内的小标题（Heading 3/4），资源包用它们分模块
        document = None
        try:
            import docx

            document = docx.Document(str(path))
        except Exception as exc:  # noqa: BLE001 - 坏包走 zip 兜底
            print(f"  · 用兜底解析读取 {path.name}（{type(exc).__name__}）", file=sys.stderr)
            document = None

        if document is None:
            for text in _docx_paragraphs_via_zip(path):
                if _is_noise(text) or _is_title(text):
                    continue
                prompt = _clean_prompt(text)
                if len(prompt) >= MIN_PROMPT_CHARS:
                    items.append({"raw": prompt, "sub": ""})
            return items

        current_sub = ""
        for paragraph in document.paragraphs:
            text = paragraph.text.strip()
            if not text:
                continue
            style = paragraph.style.name if paragraph.style is not None else ""
            if style.startswith("Heading") and len(text) <= 40:
                current_sub = text
                continue
            if _is_noise(text) or _is_title(text):
                continue
            prompt = _clean_prompt(text)
            if len(prompt) < MIN_PROMPT_CHARS:
                continue
            items.append({"raw": prompt, "sub": current_sub})
        # 表格里的提示词（有些文档整份都是表格）
        for table in document.tables:
            for row in table.rows:
                for cell in row.cells:
                    for line in cell.text.split("\n"):
                        text = line.strip()
                        if len(text) < MIN_PROMPT_CHARS:
                            continue
                        if _is_noise(text) or _is_title(text):
                            continue
                        prompt = _clean_prompt(text)
                        if len(prompt) >= MIN_PROMPT_CHARS:
                            items.append({"raw": prompt, "sub": ""})
        return items

    if path.suffix.lower() == ".txt":
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines():
            text = line.strip()
            if len(text) < MIN_PROMPT_CHARS or _is_noise(text) or _is_title(text):
                continue
            items.append({"raw": _clean_prompt(text), "sub": ""})
        return items

    return items


def build_pack(spec: PackSpec, src_root: Path) -> dict:
    """构建单个技能包。"""
    collected: list[dict] = []
    for rel in spec.sources:
        target = src_root / rel
        if not target.exists():
            print(f"  ! 来源不存在：{rel}", file=sys.stderr)
            continue
        files = [target] if target.is_file() else sorted(target.rglob("*"))
        for path in files:
            if path.is_dir() or path.suffix.lower() not in (".docx", ".xlsx", ".txt"):
                continue
            if path.name.startswith("~$"):
                continue  # Office 临时文件
            collected.extend(_collect_file(path, spec))

    # 去重 + 截断 + 生成标题
    seen: set[str] = set()
    items: list[dict] = []
    for entry in collected:
        prompt = entry["raw"][:MAX_PROMPT_CHARS].strip()
        fingerprint = re.sub(r"\s+", "", prompt)
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        title = _title_from(prompt, f"{spec.name}示例")
        items.append(
            {
                "id": _item_id(spec.key, title, prompt),
                "title": title,
                "summary": prompt[:60].replace("\n", " "),
                "prompt": prompt,
                "sub": entry.get("sub", ""),
                "aspect": _guess_aspect(prompt),
            }
        )
        if len(items) >= MAX_ITEMS_PER_PACK:
            break

    return {
        "key": spec.key,
        "name": spec.name,
        "description": spec.description,
        "personas": spec.personas,
        "tags": spec.tags,
        "category": spec.category,
        "sources": spec.sources,
        "count": len(items),
        "items": items,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="导入桌面提示词资源库为技能包 JSON")
    parser.add_argument(
        "--src",
        default=str(Path.home() / "Desktop" / "skills提示词"),
        help="资源库根目录",
    )
    parser.add_argument("--check", action="store_true", help="只校验，不写盘")
    args = parser.parse_args()

    src_root = Path(args.src).expanduser()
    if not src_root.exists():
        print(f"资源库不存在：{src_root}", file=sys.stderr)
        return 1

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index_packs: list[dict] = []
    total = 0
    for spec in PACK_SPECS:
        print(f"→ {spec.key}（{spec.name}）")
        pack = build_pack(spec, src_root)
        total += pack["count"]
        print(f"   {pack['count']} 条")
        if not args.check:
            target = OUT_DIR / f"{spec.key}.json"
            target.write_text(
                json.dumps(pack, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
            )
        index_packs.append(
            {
                "key": pack["key"],
                "name": pack["name"],
                "description": pack["description"],
                "personas": pack["personas"],
                "tags": pack["tags"],
                "category": pack["category"],
                "count": pack["count"],
            }
        )

    if not args.check:
        index = rebuild_index(OUT_DIR, source=str(src_root))
        print(f"\n索引：{len(index['packs'])} 个包 / {index['total_items']} 条")
    print(f"\n本次导入 {total} 条 / {len(index_packs)} 个技能包")
    if args.check:
        print("（--check：未写盘）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
