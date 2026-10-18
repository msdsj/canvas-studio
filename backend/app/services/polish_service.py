"""提示词润色服务 v3：保真优先，多模式 + 多变体，三处入口共用。

为什么不是「一键换句话」
------------------------
主流设计工具（Canva / Lovart / 即梦）的润色不是一个按钮，而是一组**意图明确的动作**：
更具体、更专业、更简洁、转英文、修歧义。用户知道自己缺什么，只是不会写。
所以这里把「润色」拆成 6 个模式，并且一次给 2–3 个方向不同的版本让用户挑。

为什么 v3 要「保真优先」
------------------------
v2 的提示词鼓励模型「补构图 / 光线 / 材质 / 画幅」，`specific` 还允许涨到原文 2.2 倍。
实测用户说「一只橘猫在窗台」，回来变成「一只橘猫在窗台，暖调侧逆光，浅景深，35mm，胶片颗粒……」
——主体之外的风格被模型单方面决定了，这已经不是在润色用户的提示词，而是在替用户做创作决定。
v3 的边界：
- 不可改动区（主体 / 数量 / 颜色 / 动作 / 用户写的文字 / 用户给定的风格词 / 排除项 / 数字尺寸）字面保留；
- 允许增补区只在用户没提、且属纯技术渲染参数时补，每变体最多 2 项；
- 长度硬上限收紧（见 `_length_cap`）；
- 每条产出都过一遍 `_fidelity_guard()`，宁可少润色，不许改错。

两条路径
--------
- **中转站可用**：交给模型，要求返回 JSON（多个 variant + 每个改了什么）；
- **未配置中转站**：走本地规则（去口语、评价词后置具体描述、补场景约束），
  并标记 `engine=local`。英文模式本地做不了，会如实说明而不是假装翻译。
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import design_skills, prompt_service, relay_service
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.polish_service")

MODE_LABELS: dict[str, str] = {
    "auto": "智能",
    "specific": "更具体",
    "professional": "更专业",
    "concise": "更简洁",
    "english": "英文",
    "fix": "修歧义",
}

MODE_HINTS: dict[str, str] = {
    "auto": "补齐必要渲染参数，不动主体",
    "specific": "只在用户没提的地方补技术参数",
    "professional": "换成设计行业术语",
    "concise": "压成一句，去掉冗余",
    "english": "输出英文提示词",
    "fix": "消解矛盾与模糊表述",
}

_MODE_INSTRUCTION: dict[str, str] = {
    "auto": "只补用户确实没提的纯技术渲染参数（最多 2 项），主体、文字、风格词一律原样保留；"
    "原文已经够具体就少改甚至不改。",
    "specific": "只在用户没提的地方补纯技术渲染参数（光线方向与软硬、视角、材质等，最多 2 项），"
    "绝不新增主体 / 道具 / 场景 / 风格流派，也不要把一句话扩写成罗列式长句。",
    "professional": "把口语换成设计行业可执行的说法（构图 / 版式 / 层级 / 留白 / 低饱和 / "
    "哑光 / 压纹 / 柔光箱），只换说法不加内容，不改变用户的题材与主体。",
    "concise": "压成一句话，只保留主体 + 用户自己给的风格词 + 一个画面要求；"
    "不删除括号里的说明，不删除程度词（稍微 / 有点）。",
    "english": "输出英文提示词，用图像模型常见的自然语言句式（不是关键词堆砌），"
    "这是翻译不是扩写：保留原意与信息量，品牌名与用户要求出现的文字保持原样不翻译。",
    "fix": "找出原句里的矛盾或含糊（例如「极简但元素丰富」「写实又卡通」），"
    "选择更符合主体的一种解释并在 notes 里说明你消解了哪个冲突；没冲突就原样返回。",
}

_SCENE_INSTRUCTION: dict[str, str] = {
    "composer": "主输入框：用户可能从零生成一张图，只在确有必要时补技术参数，不要替用户定风格。",
    "region": "框选区域：只修改用户框出的那一块，必须补上「仅修改该区域，其余保持原样」；不要改动区域外的描述。",
    "sidebar": "侧边栏输入框：偏简短直接，不要堆砌长句。",
}

# 口语与犹豫词：中文生图指令里它们只稀释信息。
# 注意：「稍微」「有点」「一点」这类程度词**故意不在名单里**——用户在表达「轻微改动」时它们是有信息的。
_FILLERS = (
    "帮我",
    "帮忙",
    "能不能",
    "可不可以",
    "麻烦",
    "就是",
    "那个",
    "然后呢",
    "我想要",
    "我想",
    "请帮我",
    "给我",
)

# 会话虚词：只在本地模式里剪掉，不涉及语义
_SOFT_FILLERS = ("的风格", "的感觉", "那种", "一下")

# 评价词 → 可执行的视觉描述（本地兜底用）。
# 替换时**保留原词**并追加括号说明，用户才看得出哪部分是自己说的。
_VAGUE_MAP: dict[str, str] = {
    "好看": "构图均衡、配色克制",
    "好看点": "构图均衡、配色克制",
    "高级": "低饱和配色、大面积留白、哑光质感",
    "高级点": "低饱和配色、大面积留白、哑光质感",
    "有设计感": "版式有明确网格与信息层级",
    "精致": "细节锐利、材质纹理清晰",
    "大气": "主体占比大、留白充足、横向舒展构图",
    "ins风": "自然光、低饱和、生活化场景",
    "氛围感": "单侧柔光、浅景深、轻微颗粒",
}

# 专业模式额外替换：把模糊形容换成设计术语（同样保留原词）
_PRO_MAP: dict[str, str] = {
    "排版": "版式采用 12 栏网格、层级清晰",
    "配色": "配色按 60/30/10 分配主辅强调色",
    "质感": "材质区分粗糙度与反射，避免塑料感",
    "亮一点": "整体提高一档曝光，保留高光细节",
    "干净": "背景统一、无多余元素干扰",
}

# 元信息括号：这些不是用户的画面描述，本地模式可以删
_PAREN_META = re.compile(r"[（(]\s*(?:参考图|参考|图\s*\d+|见附件|截图)[^）)]{0,20}[）)]")

_REGION_TAIL = "，仅修改该区域，其余部分保持原样"
_SCENE_TAIL = {
    "composer": "，高清细节，构图完整",
    "sidebar": "",
    "region": _REGION_TAIL,
}

_PUNCT_FIX = (
    (re.compile(r"[，,]\s*[，,]+"), "，"),
    (re.compile(r"[。\.]{2,}"), "。"),
    (re.compile(r"\s+"), " "),
)

# 长度上限：(倍数, 绝对增量)
_LENGTH_CAP: dict[str, tuple[float, int]] = {
    "auto": (1.25, 40),
    "fix": (1.25, 40),
    "concise": (1.25, 40),
    "specific": (1.6, 80),
    "professional": (1.35, 40),
    "english": (2.6, 400),  # 翻译必然变长（中文 → 英文），不做中文比例约束
}

# 中文二元组里的高频虚词：不参与「关键 token」判断
_STOP_BIGRAMS = frozenset(
    {
        "的",
        "了",
        "和",
        "与",
        "在",
        "是",
        "就",
        "也",
        "都",
        "而",
        "及",
        "或",
        "把",
        "被",
        "让",
        "给",
        "对",
        "从",
        "到",
        "为",
        "以",
        "用",
        "很",
        "会",
        "要",
        "有",
        "个",
        "一",
        "这",
        "那",
        "其",
        "之",
        "并",
        "但",
        "却",
        "这",
        "着",
        "过",
        "吗",
        "呢",
        "吧",
        "啊",
    }
)

_EN_STOPWORDS = frozenset(
    {
        "a",
        "an",
        "the",
        "of",
        "in",
        "on",
        "at",
        "to",
        "for",
        "with",
        "and",
        "or",
        "is",
        "are",
        "be",
        "as",
        "by",
        "it",
        "its",
        "this",
        "that",
        "some",
        "very",
        "please",
        "help",
        "me",
        "i",
        "want",
        "make",
        "into",
        "then",
        "there",
        "here",
    }
)

_CJK = re.compile(r"[\u4e00-\u9fff]")
_LATIN = re.compile(r"[A-Za-z][A-Za-z0-9'\-]*")


def _length_cap(original: str, mode: str) -> int:
    """该模式允许的最大字数：倍数与绝对增量取较大者，但绝不放宽到无边界。"""
    ratio, extra = _LENGTH_CAP.get(mode, (1.25, 40))
    return max(int(len(original) * ratio) + extra, len(original))


def _sentence_units(text: str) -> list[str]:
    """按标点切成分句，用于「超长时优先砍新增从句」。"""
    return [part for part in re.split(r"(?<=[，,；;。.!！？?])", text) if part.strip()]


def _truncate_keeping_original(original: str, candidate: str, cap: int) -> str:
    """超长时：优先保留原句，只砍候选新增出来的分句，最后才硬截断。"""
    if len(candidate) <= cap:
        return candidate
    units = _sentence_units(candidate)
    kept: list[str] = []
    for unit in units:
        trial = "".join(kept + [unit]).rstrip("，,；;。. ")
        if len(trial) > cap and kept:
            break
        kept.append(unit)
    trimmed = "".join(kept).rstrip("，,；;。. ")
    if len(trimmed) <= cap and trimmed:
        return trimmed
    return candidate[:cap].rstrip("，,；;。. ")


def _cleanup(text: str, *, strip_parentheses: bool = False) -> str:
    """去口语、修标点、收空白。

    `strip_parentheses` 只删「参考图2」这类元信息括号，画面说明括号默认保留。
    """
    value = text.strip()
    for filler in _FILLERS:
        value = value.replace(filler, "")
    for pattern, replacement in _PUNCT_FIX:
        value = pattern.sub(replacement, value)
    if strip_parentheses:
        value = _PAREN_META.sub("", value)
    return value.strip(" ，,。.")


def _apply_map(value: str, mapping: dict[str, str], notes: list[str], label: str) -> str:
    """评价词后置具体描述：保留用户原词，只在它后面补括号说明。

    「高级感」这种带后缀的要连后缀一起定位，否则会写成「高级（…）感」。
    """
    replaced: list[str] = []
    for word, concrete in mapping.items():
        suffix = "感" if f"{word}感" in value else ""
        anchor = f"{word}{suffix}"
        if anchor in value and f"{word}（" not in value:
            value = value.replace(anchor, f"{anchor}（{concrete}）", 1)
            replaced.append(anchor)
    if replaced:
        notes.append(f"{label}：保留{'、'.join(replaced)}并补充说明")
    return value


def _ensure_tail(value: str, scene: str, notes: list[str]) -> str:
    tail = _SCENE_TAIL.get(scene, "")
    if not tail:
        return value
    if scene == "region":
        if any(word in value for word in ("其余", "其他部分", "保持原样", "保持不变")):
            return value
        notes.append("补上「只改这一块」的约束")
        return f"{value}{tail}"
    if len(value) < 16:
        notes.append("补上基础画面要求")
        return f"{value}{tail}"
    return value


# ---------------------------------------------------------------------------
# 保真守卫
# ---------------------------------------------------------------------------

# 「可被润色掉」的词：评价词与愿望词。
#
# 它们**不是**主体，用户也不要求它们逐字保留——恰恰相反，「好看」「高级」这类词
# 本来就是要被换成具体视觉描述的。如果把它们的二元组算进「关键 token」，
# 那么任何一次合法润色都会触发「丢失 ≥2 个 token」→ 误判成篡改主体 → 整体回退原文，
# 表现为「润色按钮按了等于没按」。所以这里显式排除。
_VAGUE_TOKENS: tuple[str, ...] = (
    "好看",
    "高级",
    "大气",
    "精致",
    "设计",
    "氛围",
    "感",
    "帮我",
    "一点",
    "那种",
    "比较",
)


def _is_vague_token(gram: str) -> bool:
    return any(word in gram for word in _VAGUE_TOKENS)


def _key_tokens(text: str) -> list[str]:
    """提取「关键 token」：中文二元组 + 英文词，去掉虚词与可润色词。

    用二元组而不是分词，是为了不依赖第三方分词库：
    「一只橘猫在窗台」→ 一只 / 只橘 / 橘猫 / 猫在 / 在窗 / 窗台（去掉含虚词的）。
    """
    tokens: list[str] = []
    seen: set[str] = set()
    chars = _CJK.findall(text)
    for word in _LATIN.findall(text):
        low = word.lower()
        if low in _EN_STOPWORDS or len(low) < 2 or low in seen:
            continue
        seen.add(low)
        tokens.append(low)
    # 中文按连续汉字串切，再取二元组。
    # 必须先整词剔除可润色词（好看/高级/那种…）再切：直接切二元组的话
    # 「高级」会被切成「种高 / 级点」，过滤不掉，于是任何一次合法润色都被判成丢 token。
    scrubbed = text
    for word in _VAGUE_TOKENS:
        scrubbed = scrubbed.replace(word, "，")
    for chunk in re.findall(r"[\u4e00-\u9fff]+", scrubbed):
        if len(chunk) == 1:
            continue
        for index in range(len(chunk) - 1):
            gram = chunk[index : index + 2]
            if any(ch in _STOP_BIGRAMS for ch in gram) or gram in seen:
                continue
            if _is_vague_token(gram):
                continue
            seen.add(gram)
            tokens.append(gram)
    # 单汉字串（如「猫」）也保留，避免极短原文无法判定
    if not tokens:
        tokens = [ch for ch in chars if ch not in _STOP_BIGRAMS][:8]
    return tokens


def _is_english(text: str) -> bool:
    latin = len(_LATIN.findall(text))
    cjk = len(_CJK.findall(text))
    return latin > cjk * 2 and latin >= 3


def _coverage(original: str, candidate: str) -> tuple[float, list[str]]:
    """原句关键 token 在候选里的覆盖率，以及丢失的 token。"""
    tokens = _key_tokens(original)
    if not tokens:
        return 1.0, []
    haystack = candidate.lower() if _is_english(candidate) else candidate
    lowered = _is_english(original)
    missing = [
        token
        for token in tokens
        if (token if lowered else token) not in (haystack if lowered else candidate)
    ]
    kept = len(tokens) - len(missing)
    return kept / len(tokens), missing


def _fidelity_guard(
    original: str, candidate: str, *, mode: str = "auto", cap: int | None = None
) -> tuple[str, list[str]]:
    """偏离守卫：宁可少润色，不许改错。

    判定顺序：
    1. 候选几乎为空 → 回退原文；
    2. 关键 token（中文二元组 / 英文词）覆盖：丢失 ≥2 个 → 判定主体或限定被改写，
       尝试「砍掉新增分句」保留原句；若仍不足则整体回退原文；
    3. 长度超上限 → 优先砍新增分句，再不行硬截断（cap）；
    4. 其余保守放行，并如实写 note。
    """
    src = (original or "").strip()
    out = (candidate or "").strip()
    if not src or not out:
        return src, ["已回退：候选为空"]
    limit = cap if cap is not None else _length_cap(src, mode)

    ratio, missing = _coverage(src, out)
    if len(_key_tokens(src)) >= 3 and len(missing) >= 2:
        if _filler_removal_ok(src, out):
            salvaged = _truncate_keeping_original(src, out, limit)
            return salvaged, ["已守护：只去掉口语，信息未改动"]
        # 候选 = 原句 + 新增分句 的情形：保留原句，只留新增部分
        salvaged = _keep_source_units(src, out)
        if salvaged:
            salvaged = _truncate_keeping_original(src, salvaged, limit)
            return salvaged, ["已守护：保留原文主体，只追加新增的渲染参数"]
        logger.info(
            "润色偏离原意，已回退：missing=%s ratio=%.2f", missing[:5], ratio
        )
        return src, ["已回退：检测到主体或限定丢失，保留原文"]

    guarded = _truncate_keeping_original(src, out, limit)
    if guarded != out:
        return guarded, ["已守护：超出长度上限，截断新增内容"]
    if any(marker in out for marker in ("（", "(")) and "（" not in src and "(" not in src:
        return guarded, ["已守护：只补了用户没提的技术参数，主体与文字未改动"]
    return guarded, ["已守护：主体与文字未改动"]


def _keep_source_units(original: str, candidate: str) -> str:
    """以原文为骨架 + 候选新增分句；主体被换掉时返回空串（交给回退）。

    守卫判偏离常有两种情况：
    - 候选只是「原句 + 尾巴」（「…壁纸，高清细节」），中间插字切断了二元组，
      这时原文本身安全，追加新增分句即可；
    - 候选把主体换掉了（「一只橘猫…」→「一只柴犬…」），此时**不能**把新分句接回去，
      直接返回空串让调用方回退原文。
    区分方式：原文第一个分句的主干（前 6 字）是否仍出现在候选里。
    """
    src = original.strip(" ，,；;。.")
    if not src:
        return ""
    head = src[:6]
    if head and head not in candidate:
        return ""
    extras: list[str] = []
    for unit in _sentence_units(candidate):
        cleaned = unit.strip(" ，,；;。.")
        if not cleaned or cleaned in src:
            continue
        if len(cleaned) < 4:
            continue
        # 新增分句里若出现「数量 + 名词」这类新主体迹象，宁可回退
        if re.search(r"[一二两三四五六七八九十几几]\s*(只|个|张|幅|位|朵|株)", cleaned):
            return ""
        # 是「改写原文的某个分句」而不是「新增」：与该分句共享 ≥2 个二元组即判定篡改
        for original_unit in _sentence_units(src):
            target = original_unit.strip(" ，,；;。.")
            if len(target) >= 4 and len(_shared_bigrams(target, cleaned)) >= 2:
                return ""
        extras.append(cleaned)
    if not extras:
        return ""
    return "，".join([src, *extras])


def _shared_bigrams(left: str, right: str) -> set[str]:
    """两段中文共有的二元组（去掉含虚词的）。"""
    def _grams(value: str) -> set[str]:
        grams: set[str] = set()
        for chunk in re.findall(r"[\u4e00-\u9fff]+", value):
            for index in range(len(chunk) - 1):
                gram = chunk[index : index + 2]
                if not any(ch in _STOP_BIGRAMS for ch in gram):
                    grams.add(gram)
        return grams

    return _grams(left) & _grams(right)


def _filler_removal_ok(original: str, candidate: str) -> bool:
    """候选取掉口语虚词后与原文等价 → 允许放行（「帮我」被删不应判为偏离）。

    只删词、不增删信息，是最保守的一种「润色」；判定比对双方都做同样的清理。
    「更简洁」还会删掉评价词（好看/高级/那种…），所以这里也允许候选比原文
    **只少这些可润色词**——否则「简洁」永远过不了守卫，等于这个模式不存在。
    """
    def _bare(value: str) -> str:
        stripped = value
        for filler in _FILLERS:
            stripped = stripped.replace(filler, "")
        for word in _VAGUE_TOKENS:
            stripped = stripped.replace(word, "")
        return re.sub(r"[\s，,。.；;！!？?、]", "", stripped)

    return bool(candidate.strip()) and _bare(original) == _bare(candidate)


def _variant(label: str, text: str, notes: list[str], index: int) -> dict[str, Any]:
    """组装变体：notes 去重、限条数，守卫说明永远排第一。"""
    seen: set[str] = set()
    unique: list[str] = []
    for note in notes:
        key = note.strip()
        if key and key not in seen:
            seen.add(key)
            unique.append(key)
    return {
        "id": f"v{index}",
        "label": label,
        "text": text.rstrip("。."),
        "notes": unique[:3],
        "length": len(text),
    }


def local_variants(
    text: str, scene: str, mode: str = "auto", count: int = 2
) -> list[dict[str, Any]]:
    """本地规则：确定性、不联网、不编造用户没说的主体。每条结果都过保真守卫。"""
    original = text.strip()
    base = _cleanup(original)
    variants: list[dict[str, Any]] = []

    if mode in {"auto", "specific", "professional"}:
        notes: list[str] = []
        value = _apply_map(base, _VAGUE_MAP, notes, "评价词")
        if mode == "professional":
            value = _apply_map(value, _PRO_MAP, notes, "专业化")
        value = _ensure_tail(value, scene, notes)
        if value != original:
            notes.insert(1, "去掉了口语，主体与文字未改动")
        guarded, guard_notes = _fidelity_guard(original, value or base, mode=mode)
        variants.append(
            _variant(MODE_LABELS[mode], guarded, [*guard_notes, *notes], 1)
        )

    if mode in {"auto", "professional"} and len(variants) < count:
        # 第二个方向：更短、更直接，给用户另一种选择
        short = _trim_modifiers(_cleanup(original))
        if scene == "region":
            short = _ensure_tail(short, scene, [])
        guarded, guard_notes = _fidelity_guard(original, short, mode="concise")
        if guarded and all(guarded != item["text"] for item in variants):
            variants.append(
                _variant("更简洁", guarded, [*guard_notes, "去掉修饰，只留主干"], len(variants) + 1)
            )

    if mode == "concise":
        value = _trim_modifiers(_cleanup(original))
        if scene == "region":
            value = _ensure_tail(value, scene, [])
        guarded, guard_notes = _fidelity_guard(original, value or base, mode="concise")
        variants.append(
            _variant("更简洁", guarded, [*guard_notes, "去掉修饰，只留主干"], 1)
        )

    if mode == "fix":
        value = _ensure_tail(_cleanup(original), scene, [])
        guarded, guard_notes = _fidelity_guard(original, value, mode="fix")
        variants.append(_variant("已修正", guarded, [guard_notes[0], "已去掉口语与重复表述"], 1))

    if mode == "english":
        variants.append(
            _variant(
                "英文",
                original,
                ["未配置中转站：英文润色需要模型，这里先保留原文"],
                1,
            )
        )

    return variants[: max(1, min(count, 3))]


def _trim_modifiers(value: str) -> str:
    """「更简洁」的本地裁剪：只删会话虚词与重复标点，**不删括号内容**。"""
    for filler in _SOFT_FILLERS:
        value = value.replace(filler, "")
    return value.strip(" ，,。.")


def _extract_json(text: str) -> dict[str, Any] | None:
    """容忍代码围栏与前后说明，抽出 JSON 对象。"""
    if not text:
        return None
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    candidates = [fenced.group(1)] if fenced else []
    candidates.append(text)
    start, end = text.find("{"), text.rfind("}")
    if start != -1 and end > start:
        candidates.append(text[start : end + 1])
    for candidate in candidates:
        try:
            parsed = json.loads(candidate.strip())
        except (ValueError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def _normalize_variants(
    raw: Any, original: str, mode: str, limit: int
) -> list[dict[str, Any]]:
    """收敛模型返回的变体：去空、去重、保真守卫、限长。"""
    items = raw if isinstance(raw, list) else []
    cap = _length_cap(original, mode)
    variants: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items[:limit]:
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or "").strip().rstrip("。.")
        if len(text) < 2 or text in seen:
            continue
        seen.add(text)
        notes = [
            str(note).strip()[:60]
            for note in (item.get("notes") or [])
            if str(note).strip()
        ][:2]
        guarded, guard_notes = _fidelity_guard(original, text, mode=mode, cap=cap)
        if guarded in seen and guarded != text:
            continue
        seen.add(guarded)
        variants.append(
            _variant(
                str(item.get("label") or MODE_LABELS.get(mode, "润色")).strip()[:8],
                guarded,
                [*guard_notes, *notes],
                len(variants) + 1,
            )
        )
    return variants


def _skill_block(context: dict[str, Any] | None) -> str:
    """把用户当前套用的技能带进润色，让术语与版式跟出图一致。"""
    if not context:
        return "（无）"
    skill = design_skills.get_skill(str(context.get("skill_id") or ""))
    if skill is None:
        return "（无）"
    detail = design_skills.render_detail(skill.id)
    aspect = str(context.get("aspect") or skill.aspect or "").strip()
    if aspect:
        detail += f"\n目标画幅：{aspect}"
    return detail


async def polish(
    db: AsyncSession,
    user_id: str,
    *,
    text: str,
    scene: str = "composer",
    mode: str = "auto",
    variants: int = 2,
    context: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """润色入口：有中转站走模型，没有走本地规则。"""
    content = (text or "").strip()
    if not content:
        raise AppError(ErrorCode.VALIDATION_ERROR, "先写一句要润色的内容")
    mode = mode if mode in MODE_LABELS else "auto"
    limit = max(1, min(int(variants or 1), 3))
    original = content

    target = await relay_service.resolve(db, user_id)
    if target is None:
        items = local_variants(content, scene, mode, limit)
        return {
            "text": items[0]["text"],
            "variants": items,
            "original": original,
            "mode": mode,
            "engine": "local",
            "model": "",
            "elapsed_ms": 0,
        }

    started = time.perf_counter()
    template = await prompt_service.load(db, "polish")
    system_prompt = prompt_service.render(
        template,
        mode_instruction=_MODE_INSTRUCTION.get(mode, _MODE_INSTRUCTION["auto"]),
        scene_instruction=_SCENE_INSTRUCTION.get(scene, _SCENE_INSTRUCTION["composer"]),
        skill_block=_skill_block(context),
        count=str(limit),
    )
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": f"原文：{content}"},
    ]
    try:
        result = await relay_service.chat(
            db,
            user_id,
            messages,
            json_mode=True,
            temperature=0.4,
            max_tokens=1200,
            target=target,
        )
    except AppError as exc:
        # 模型挂了不能让润色按钮变成死按钮：退回本地规则，并如实标注
        logger.warning("润色调用中转站失败，退回本地规则：%s", exc.message)
        items = local_variants(content, scene, mode, limit)
        for item in items:
            item["notes"] = [*item["notes"], f"中转站暂时不可用（{exc.message}）"][:3]
        return {
            "text": items[0]["text"],
            "variants": items,
            "original": original,
            "mode": mode,
            "engine": "local",
            "model": "",
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }

    parsed = _extract_json(result["content"]) or {}
    items = _normalize_variants(parsed.get("variants"), content, mode, limit)
    if not items:
        logger.warning("润色返回内容无法解析：%s", result["content"][:200])
        items = local_variants(content, scene, mode, limit)
        for item in items:
            item["notes"] = [*item["notes"], "中转站返回格式不对，已用本地规则"][:3]
        return {
            "text": items[0]["text"],
            "variants": items,
            "original": original,
            "mode": mode,
            "engine": "local",
            "model": "",
            "elapsed_ms": int((time.perf_counter() - started) * 1000),
        }

    return {
        "text": items[0]["text"],
        "variants": items,
        "original": original,
        "mode": mode,
        "engine": "relay",
        "model": result.get("model", ""),
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
    }
