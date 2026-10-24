"""参数自适应服务：从自然语言里读出「该画多大」，而不是全局写死正方形。

设计原则
--------
1. **文本优先**：用户明确写了 `16:9` / `1024x1536` / 「竖版海报」，一律以文本为准；
2. **场景兜底**：文本没写，再按场景语义匹配（电脑壁纸 16:9、手机壁纸 9:16、
   头像 1:1、海报 3:4…），并按命中关键词给出可解释的 `reason`；
3. **绝不用正方形兜底**：通用生图的默认画幅是 4:3（更接近摄影构图的
   中性比例），只有「头像 / 图标 / 方图」这类场景才落到 1:1；
4. **可覆盖**：前端参数面板的手动选择通过 `override` 传入，优先级最高，
   并把 `source` 标成 `manual`，让界面能如实显示「这是你手动定的」。

画像尺寸按 100 万像素量级给，宽高均为 16 的倍数，便于上游按比例出图。
"""
from __future__ import annotations

import re
from typing import Any

# 画幅预设：aspect 是「构图意图」，size 是上游**真正支持**的输出尺寸。
#
# 为什么要分开：gpt-image 系列只接受 1024x1024 / 1536x1024 / 1024x1536
# 三档（见 compose_service._ALLOWED_SIZES）。如果面板写 16:9 就把
# 1536x864 发上去，上游会直接报错——用户看到的是「生成失败」，
# 而不是「比例不够精确」。所以这里按最接近的档位出图，并把意图保留在
# aspect 字段里（提示词、画布占位卡、二次编辑都按它走）。
ASPECT_PRESETS: list[dict[str, Any]] = [
    {"aspect": "1:1", "label": "方图", "size": "1024x1024", "width": 1024, "height": 1024, "exact": True},
    {"aspect": "4:3", "label": "横向", "size": "1536x1024", "width": 1536, "height": 1024, "exact": False},
    {"aspect": "3:4", "label": "纵向", "size": "1024x1536", "width": 1024, "height": 1536, "exact": False},
    {"aspect": "16:9", "label": "宽屏", "size": "1536x1024", "width": 1536, "height": 1024, "exact": False},
    {"aspect": "9:16", "label": "竖屏", "size": "1024x1536", "width": 1024, "height": 1536, "exact": False},
    {"aspect": "3:2", "label": "相机横", "size": "1536x1024", "width": 1536, "height": 1024, "exact": True},
    {"aspect": "2:3", "label": "相机竖", "size": "1024x1536", "width": 1024, "height": 1536, "exact": True},
    {"aspect": "21:9", "label": "超宽", "size": "1536x1024", "width": 1536, "height": 1024, "exact": False},
    {"aspect": "5:4", "label": "小幅横", "size": "1024x1024", "width": 1024, "height": 1024, "exact": False},
]

_BY_ASPECT = {item["aspect"]: item for item in ASPECT_PRESETS}

# 通用兜底：4:3 而不是 1:1（见模块 docstring 第 3 条）
DEFAULT_ASPECT = "4:3"

# ---------------------------------------------------------------------------
# 场景规则：**顺序即优先级**。「手机壁纸」必须排在「壁纸」之前，否则会被吃掉。
# ---------------------------------------------------------------------------
SCENE_RULES: list[dict[str, Any]] = [
    {
        "id": "phone_wallpaper",
        "label": "手机壁纸",
        "aspect": "9:16",
        "keywords": ["手机壁纸", "手机桌面", "手机锁屏", "锁屏壁纸", "全面屏壁纸", "iphone壁纸", "竖屏壁纸"],
    },
    {
        "id": "desktop_wallpaper",
        "label": "电脑壁纸",
        "aspect": "16:9",
        "keywords": ["电脑壁纸", "桌面壁纸", "电脑桌面", "显示器壁纸", "宽屏壁纸", "壁纸"],
    },
    {
        "id": "avatar",
        "label": "头像 / 图标",
        "aspect": "1:1",
        "keywords": ["头像", "图标", "app icon", "icon", "logo", "徽标", "标识", "应用图标", "品牌标志", "表情包"],
    },
    {
        "id": "poster",
        "label": "海报 / 长图",
        "aspect": "3:4",
        "keywords": ["海报", "长图", "宣传单", "易拉宝", "展架", "菜单", "书封", "封面图"],
    },
    {
        "id": "presentation",
        "label": "演示 / 宽屏",
        "aspect": "16:9",
        "keywords": ["ppt", "幻灯片", "演示文稿", "课件", "发布会", "主视觉", "keynote"],
    },
    {
        "id": "banner",
        "label": "横幅 / 封面",
        "aspect": "16:9",
        "keywords": ["横幅", "banner", "头图", "公众号封面", "视频封面", "直播封面", "网页首屏", "网站首屏"],
    },
    {
        "id": "social_vertical",
        "label": "社交竖图",
        "aspect": "3:4",
        "keywords": ["小红书", "朋友圈九宫格", "种草图", "竖版"],
    },
    {
        "id": "ui_screen",
        "label": "界面 / 网页",
        "aspect": "16:9",
        "keywords": ["界面", "ui 设计", "ui设计", "网页设计", "网站设计", "app 界面", "仪表盘", "后台界面"],
    },
    {
        "id": "product",
        "label": "商品图",
        "aspect": "1:1",
        "keywords": ["商品主图", "主图", "详情页", "电商图", "白底图"],
    },
    {
        "id": "illustration",
        "label": "插画 / 漫画",
        "aspect": "3:4",
        "keywords": ["插画", "漫画", "分镜", "绘本", "立绘"],
    },
]

_CN_NUM = {"一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}

# 「16:9」「16：9」「16 / 9」；避免把时间 12:30 当成比例（要求两侧都在 1–32 且不相等）
_RATIO_RE = re.compile(r"(?<![\d.])(\d{1,2})\s*[:：/]\s*(\d{1,2})(?![\d.])")
# 「1024x1536」「1024*1536」「1024×1536」
_PIXEL_RE = re.compile(r"(?<![\d.])(\d{3,4})\s*[x×*]\s*(\d{3,4})(?![\d.])")
# 「宽 1024 高 768」/「1024 宽 768 高」
_WH_RE = re.compile(r"宽\s*(\d{3,4}).{0,6}?高\s*(\d{3,4})|(\d{3,4})\s*宽.{0,6}?(\d{3,4})\s*高")
# 数量：「两张」「3 张」「四个版本」
_COUNT_RE = re.compile(r"([1-9]|[一二两三四五六七八九])\s*(张|幅|个|版|款)")
_HD_WORDS = ("4k", "8k", "2k", "高清", "超清", "高画质", "超高清", "细节丰富", "锐利")
_SD_WORDS = ("标清", "低清", "草图", "粗略")


def _norm(value: str) -> str:
    return (value or "").strip().lower()


def _preset(aspect: str) -> dict[str, Any]:
    return _BY_ASPECT.get(aspect) or _BY_ASPECT[DEFAULT_ASPECT]


def _ratio_value(aspect: str) -> float:
    try:
        left, right = aspect.split(":")
        return float(left) / max(float(right), 1e-6)
    except (ValueError, AttributeError):
        return 1.0


def _to_allowed(width: int, height: int) -> tuple[int, int]:
    """把任意尺寸映射到上游支持的三档，保持横/竖/方关系。"""
    allowed = {(1024, 1024), (1536, 1024), (1024, 1536)}
    if (width, height) in allowed:
        return width, height
    if abs(width - height) <= max(width, height) * 0.06:
        return 1024, 1024
    return (1536, 1024) if width > height else (1024, 1536)


def _nearest_aspect(width: int, height: int) -> str:
    """把任意像素尺寸归到最近的预设比例（用于面板显示与编辑任务）。"""
    exact = {(1024, 1024): "1:1", (1536, 1024): "3:2", (1024, 1536): "2:3"}
    hit = exact.get((width, height))
    if hit:
        return hit
    target = width / max(height, 1)
    best, best_delta = DEFAULT_ASPECT, 9e9
    for item in ASPECT_PRESETS:
        delta = abs(_ratio_value(item["aspect"]) - target)
        if delta < best_delta:
            best, best_delta = item["aspect"], delta
    return best


def resolve_size(size: str) -> tuple[int, int] | None:
    """解析 `1024x1536` 这类尺寸；不合法返回 None。"""
    match = _PIXEL_RE.search(_norm(size).replace(" ", ""))
    if not match:
        return None
    width, height = int(match.group(1)), int(match.group(2))
    if not (64 <= width <= 8192 and 64 <= height <= 8192):
        return None
    return width, height


def _scene_for(text: str) -> dict[str, Any] | None:
    lowered = text.lower()
    for rule in SCENE_RULES:
        for keyword in rule["keywords"]:
            if keyword.lower() in lowered:
                return rule
    return None


def _explicit_aspect(text: str) -> str | None:
    for match in _RATIO_RE.finditer(text):
        left, right = int(match.group(1)), int(match.group(2))
        if left == right:
            continue
        if not (1 <= left <= 32 and 1 <= right <= 32):
            continue
        # 12:30 这种时间：右侧 > 24 且左侧 <= 12 时视为时间戳
        if right > 24 and left <= 12:
            continue
        aspect = f"{left}:{right}"
        # 允许 8:16 这类等价写法归一化
        if aspect in _BY_ASPECT:
            return aspect
        # 不在预设里：按数值找最接近的预设（如 16:10 → 16:9）
        return _nearest_aspect(left * 100, right * 100)
    return None


def _explicit_pixels(text: str) -> tuple[int, int] | None:
    match = _PIXEL_RE.search(text.replace(" ", ""))
    if match:
        width, height = int(match.group(1)), int(match.group(2))
        if 64 <= width <= 8192 and 64 <= height <= 8192:
            return width, height
    match = _WH_RE.search(text)
    if match:
        width = int(match.group(1) or match.group(3))
        height = int(match.group(2) or match.group(4))
        if 64 <= width <= 8192 and 64 <= height <= 8192:
            return width, height
    return None


def _explicit_count(text: str) -> int | None:
    match = _COUNT_RE.search(text)
    if not match:
        return None
    raw = match.group(1)
    value = int(raw) if raw.isdigit() else _CN_NUM.get(raw, 0)
    return value if 1 <= value <= 4 else None


def _strength_for(text: str) -> tuple[float, str]:
    """风格强度：从「轻微/强烈」这类副词读出，给编辑链路的强度一个落点。"""
    lowered = text.lower()
    if any(word in lowered for word in ("轻微", "微调", "细微", "稍微", "淡一点", "弱化")):
        return 0.35, "轻微"
    if any(word in lowered for word in ("强烈", "大幅", "彻底", "完全改变", "重塑", "颠覆", "夸张")):
        return 0.85, "强烈"
    return 0.6, "标准"


def _quality_for(text: str) -> str:
    lowered = text.lower()
    if any(word in lowered for word in _SD_WORDS):
        return "standard"
    if any(word in lowered for word in _HD_WORDS):
        return "hd"
    return "standard"


def infer(
    prompt: str,
    *,
    kind: str = "generate",
    override_size: str | None = None,
    override_aspect: str | None = None,
    source_image: tuple[int, int] | None = None,
) -> dict[str, Any]:
    """推断一次生成应当使用的画幅与渲染参数。

    返回结构（前端参数面板直接消费）::

        {
          "size": "1536x1024", "aspect": "16:9", "width": 1536, "height": 1024,
          "label": "宽屏", "exact": false,     # 输出像素是否精确等于 aspect
          "scene": "desktop_wallpaper", "scene_label": "电脑壁纸",
          "quality": "hd", "style_strength": 0.6, "count": 1,
          "source": "manual|text|scene|source|fallback",
          "reason": "识别为「电脑壁纸」，按 16:9 出图",
          "locked": false,          # 编辑任务锁原图比例
          "options": [...]
        }
    """
    result = _infer(
        prompt,
        kind=kind,
        override_size=override_size,
        override_aspect=override_aspect,
        source_image=source_image,
    )
    result["exact"] = abs(
        result["width"] / max(result["height"], 1) - _ratio_value(result["aspect"])
    ) < 0.02
    return result


def _infer(
    prompt: str,
    *,
    kind: str = "generate",
    override_size: str | None = None,
    override_aspect: str | None = None,
    source_image: tuple[int, int] | None = None,
) -> dict[str, Any]:
    text = prompt or ""
    reasons: list[str] = []

    # 0) 编辑类任务：比例天然跟随原图，不接受「重新定画幅」
    if kind == "edit" and source_image:
        width, height = source_image
        allowed = {(1024, 1024), (1536, 1024), (1024, 1536)}
        if (width, height) in allowed:
            output = (width, height)
        elif width > height:
            output = (1536, 1024)
        elif height > width:
            output = (1024, 1536)
        else:
            output = (1024, 1024)
        out_w, out_h = output
        aspect = _nearest_aspect(out_w, out_h)
        return {
            "size": f"{out_w}x{out_h}",
            "aspect": aspect,
            "width": out_w,
            "height": out_h,
            "label": "跟随原图",
            "scene": "source",
            "scene_label": "原图比例",
            "quality": _quality_for(text),
            "style_strength": _strength_for(text)[0],
            "count": 1,
            "source": "source",
            "reason": "编辑任务沿用原图比例，避免拉伸变形",
            "locked": True,
            "options": ASPECT_PRESETS,
        }

    # 1) 手动覆盖：面板里选的，优先级最高
    if override_aspect and override_aspect in _BY_ASPECT:
        preset = _BY_ASPECT[override_aspect]
        return {
            "size": preset["size"],
            "aspect": preset["aspect"],
            "width": preset["width"],
            "height": preset["height"],
            "label": preset["label"],
            "scene": "manual",
            "scene_label": "手动指定",
            "quality": _quality_for(text),
            "style_strength": _strength_for(text)[0],
            "count": _explicit_count(text) or 1,
            "source": "manual",
            "reason": f"已手动指定 {preset['aspect']}",
            "locked": False,
            "options": ASPECT_PRESETS,
        }
    if override_size:
        parsed = resolve_size(override_size)
        if parsed:
            aspect = _nearest_aspect(*parsed)
            width, height = _to_allowed(*parsed)
            return {
                "size": f"{width}x{height}",
                "aspect": aspect,
                "width": width,
                "height": height,
                "label": _preset(aspect)["label"],
                "scene": "manual",
                "scene_label": "手动尺寸",
                "quality": _quality_for(text),
                "style_strength": _strength_for(text)[0],
                "count": _explicit_count(text) or 1,
                "source": "manual",
                "reason": f"已手动指定尺寸 {width}×{height}",
                "locked": False,
                "options": ASPECT_PRESETS,
            }

    # 2) 文本里的像素 / 比例
    pixels = _explicit_pixels(text)
    if pixels:
        aspect = _nearest_aspect(*pixels)
        width, height = _to_allowed(*pixels)
        reasons.append(f"文本指定 {pixels[0]}×{pixels[1]}")
        return {
            "size": f"{width}x{height}",
            "aspect": aspect,
            "width": width,
            "height": height,
            "label": _preset(aspect)["label"],
            "scene": "text_size",
            "scene_label": "文本指定",
            "quality": _quality_for(text),
            "style_strength": _strength_for(text)[0],
            "count": _explicit_count(text) or 1,
            "source": "text",
            "reason": f"按文本尺寸 {pixels[0]}×{pixels[1]} 选择最接近的上游档位 {width}×{height}",
            "locked": False,
            "options": ASPECT_PRESETS,
        }

    aspect = _explicit_aspect(text)
    if aspect:
        preset = _preset(aspect)
        reasons.append(f"文本指定 {aspect}")
        return {
            "size": preset["size"],
            "aspect": preset["aspect"],
            "width": preset["width"],
            "height": preset["height"],
            "label": preset["label"],
            "scene": "text_ratio",
            "scene_label": "文本指定",
            "quality": _quality_for(text),
            "style_strength": _strength_for(text)[0],
            "count": _explicit_count(text) or 1,
            "source": "text",
            "reason": f"以文本写明的 {preset['aspect']} 比例出图",
            "locked": False,
            "options": ASPECT_PRESETS,
        }

    # 3) 场景语义
    scene = _scene_for(text)
    if scene:
        preset = _preset(scene["aspect"])
        return {
            "size": preset["size"],
            "aspect": preset["aspect"],
            "width": preset["width"],
            "height": preset["height"],
            "label": preset["label"],
            "scene": scene["id"],
            "scene_label": scene["label"],
            "quality": _quality_for(text),
            "style_strength": _strength_for(text)[0],
            "count": _explicit_count(text) or 1,
            "source": "scene",
            "reason": f"识别为「{scene['label']}」，按 {preset['aspect']} 出图",
            "locked": False,
            "options": ASPECT_PRESETS,
        }

    # 4) 兜底：中性 4:3，并如实告诉用户「这是兜底值，可改」
    preset = _preset(DEFAULT_ASPECT)
    return {
        "size": preset["size"],
        "aspect": preset["aspect"],
        "width": preset["width"],
        "height": preset["height"],
        "label": preset["label"],
        "scene": "fallback",
        "scene_label": "通用",
        "quality": _quality_for(text),
        "style_strength": _strength_for(text)[0],
        "count": _explicit_count(text) or 1,
        "source": "fallback",
        "reason": "未识别到明确画幅，按通用 4:3 出图；可在参数面板调整",
        "locked": False,
        "options": ASPECT_PRESETS,
    }


def aspect_hint(params: dict[str, Any]) -> str:
    """把画幅补成一句可拼进提示词的说明（上游模型对比例不敏感时靠它）。"""
    aspect = str(params.get("aspect") or "").strip()
    if not aspect:
        return ""
    return f"画面比例 {aspect}（{params.get('width')}×{params.get('height')}），构图需完整填充画幅。"


def presets() -> list[dict[str, Any]]:
    """画幅预设清单（前端参数面板渲染用）。"""
    return [dict(item) for item in ASPECT_PRESETS]


def scene_rules() -> list[dict[str, Any]]:
    """场景规则（用于产品文档/调试接口）。"""
    return [
        {"id": item["id"], "label": item["label"], "aspect": item["aspect"], "keywords": item["keywords"]}
        for item in SCENE_RULES
    ]
