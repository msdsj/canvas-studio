"""输出契约的校验、纠错提示与模板兜底（R05 / R06）。

职责
----
1. `validate_plan()`：Pydantic 严格校验 + 两条跨字段校验（`skill_id` 命中技能库、
   `final_prompt` 含 ≥1 个 `style_tag`）；
2. `build_repair_hint()`：把 `[(字段路径, 期望)]` 拼成一句模型能读懂的纠错提示，
   追加到下一次请求（R05：泛化提示「请输出合法 JSON」无效）；
3. `template_fallback_plan()`：3 次仍不合法时用技能模板兜底，**不阻塞建任务**；
4. `assert_dispatchable()`：R06 的三条硬约束，不满足就**拒绝建任务**（不静默通过）；
5. `normalize_plan()`：把业务层的半成品（verbatim / 本地模板）收敛成契约形状。

边界：本模块**不调模型、不碰数据库**，全部是纯函数（`design_skills` 是纯数据），
因此可以 100% 单测覆盖。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable

from pydantic import ValidationError

from app.schemas.compose_plan import (
    ASPECTS,
    ASPECT_TO_SIZE,
    DEFAULT_NEGATIVE,
    DEFAULT_STYLE_TAGS,
    MAX_DISPATCH_PROMPT_CHARS,
    MAX_PROMPT_CHARS,
    MIN_PROMPT_CHARS,
    NEGATIVE_MARKER,
    PLAN_SCHEMA_VERSION,
    QUALITY_SUFFIX,
    ComposeAnalysis,
    ComposePlan,
)
from app.services import design_skills
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.plan_validator")

#: 拼「期望」时用的中文映射：`ValidationError.errors()` 的 `type` → 人话
_ISSUE_TEMPLATES: dict[str, str] = {
    "missing": "必填，不能省略",
    "extra_forbidden": "不要输出这个字段",
    "string_type": "类型应为字符串",
    "int_type": "类型应为整数",
    "bool_type": "类型应为布尔值",
    "list_type": "类型应为数组",
    "float_type": "类型应为数字",
    "literal_error": "取值不在允许范围内",
    "string_too_short": "太短了",
    "string_too_long": "太长了",
    "too_short": "数量不够",
    "too_long": "数量太多",
    "greater_than_equal": "数值太小",
    "less_than_equal": "数值太大",
}

#: `aspect` 的比值视图：把技能库里 4:5 / 1:1.414 / 9:19.5 这类比例收敛到 5 个合法值
_RATIO_TARGETS: tuple[tuple[str, float], ...] = (
    ("1:1", 1.0),
    ("3:4", 3 / 4),
    ("4:3", 4 / 3),
    ("9:16", 9 / 16),
    ("16:9", 16 / 9),
)

#: `size → aspect` 反向映射（模型给的是 size，契约要的是 aspect）
_SIZE_TO_ASPECT: dict[str, str] = {
    "1024x1024": "1:1",
    "1024x1536": "3:4",
    "1536x1024": "4:3",
}


@dataclass(frozen=True)
class PlanIssue:
    """一条校验问题：字段路径 + 人话 + 期望（正好是 R05 要的格式）。"""

    path: str
    message: str
    expected: str = ""

    def as_dict(self) -> dict[str, str]:
        """给日志与 `AppError.data` 用的结构（无自由文本以外的字段）。"""
        return {"path": self.path, "message": self.message, "expected": self.expected}


@dataclass
class ValidationReport:
    """一次校验的结果。"""

    ok: bool
    plan: dict[str, Any] | None
    errors: list[PlanIssue] = field(default_factory=list)
    source: str = "relay"

    @property
    def paths(self) -> list[str]:
        """出错字段路径（去重保序），用于日志与错误卡。"""
        seen: list[str] = []
        for issue in self.errors:
            if issue.path not in seen:
                seen.append(issue.path)
        return seen


# --------------------------------------------------------------------------- #
# 归一工具
# --------------------------------------------------------------------------- #
def _parse_ratio(value: str) -> float | None:
    """把 `"4:5"` / `"1:1.414"` 解析成浮点比值；解析不了返回 None。"""
    text = str(value or "").strip()
    if ":" not in text:
        return None
    left, _, right = text.partition(":")
    try:
        width = float(left)
        height = float(right)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    return width / height


def normalize_aspect(value: Any) -> str:
    """把任意比例写法收敛到 5 个合法值之一（对数距离最近的）。

    技能库里存在 `4:5` / `1:1.414` / `9:19.5` / `16:10` / `1:3` 等写法，
    契约只允许 5 个值，所以必须做一次「最近邻」映射而不是直接丢弃。
    """
    text = str(value or "").strip()
    if text in ASPECTS:
        return text
    ratio = _parse_ratio(text)
    if ratio is None:
        return "1:1"
    best = min(_RATIO_TARGETS, key=lambda item: abs(math.log(ratio / item[1])))
    return best[0]


def aspect_from_size(size: Any) -> str:
    """`size → aspect`（模型给 size 时补契约字段）。"""
    return _SIZE_TO_ASPECT.get(str(size or "").strip(), "1:1")


def aspect_to_size(aspect: Any) -> str:
    """`aspect → size`（C1 的派生字段；`9:16` 与 `16:9` 降级到最接近的上游尺寸）。"""
    return ASPECT_TO_SIZE.get(normalize_aspect(aspect), "1024x1024")


# --------------------------------------------------------------------------- #
# 技能选取
# --------------------------------------------------------------------------- #
def _pick_skill(
    skill_id: Any,
    shortlisted: Iterable[Any] | None,
    catalog: list[design_skills.DesignSkill] | None = None,
) -> Any:
    """优先用声明的 `skill_id`，取不到就用初筛第一条；都没有则返回 `None`。

    不再回退到技能库第一条：那会把与用户需求无关的技能骨架（风格词、负向词）
    静默塞进提示词，导致画面风格被平台预设覆盖。
    """
    candidate = design_skills.get_skill(str(skill_id or "").strip(), catalog)
    if candidate is not None:
        return candidate
    for item in list(shortlisted or []):
        if item is not None:
            return item
    return None


def _skill_tags(skill: Any) -> list[str]:
    """技能的风格词（1–5 个，每个 1–40 字符）；没有就用兜底词。"""
    tags = [
        str(tag).strip()
        for tag in (getattr(skill, "style_tags", None) or [])
        if 1 <= len(str(tag).strip()) <= 40
    ]
    return tags[:5] or list(DEFAULT_STYLE_TAGS)


def _skill_negative(skill: Any, fallback: str | None = None) -> str:
    """技能的负向词（非空，≤200）；没有就用兜底负向词。"""
    text = str(getattr(skill, "negative", "") or "").strip()
    return (text or (DEFAULT_NEGATIVE if fallback is None else fallback))[:200]


def _ensure_rich_prompt(prompt: str, tags: list[str]) -> str:
    """把一段提示词补到「≥40 字符 + 含 ≥1 个 style_tag」（R06 的两条硬约束）。"""
    text = str(prompt or "").strip() or "画面主体清晰，构图完整"
    filler = "，画面主体清晰，构图完整，光线自然，细节锐利，超高清画质，4K/8K 细节，专业摄影灯光"
    guard = 0
    while len(text) < MIN_PROMPT_CHARS and guard < 8:
        text = f"{text}{filler}"
        guard += 1
    if tags and not any(tag in text for tag in tags):
        text = f"{text}，{tags[0]}"
    return text


def _clip(value: Any, limit: int, default: str = "") -> str:
    """截断到 `limit` 字符（去空白；空则用默认值）。"""
    text = str(value or "").strip()
    return (text or default)[:limit]


# --------------------------------------------------------------------------- #
# 校验
# --------------------------------------------------------------------------- #
def _issue_from_pydantic(error: dict[str, Any]) -> PlanIssue:
    """把 Pydantic 的一条错误翻成「字段路径 + 期望」。"""
    loc = error.get("loc") or ()
    path = ".".join(str(part) for part in loc) or "__root__"
    error_type = str(error.get("type") or "")
    ctx = error.get("ctx") or {}
    if error_type in {"string_too_short", "too_short"}:
        message = f"至少 {ctx.get('min_length', '?')} 个字符/项"
    elif error_type in {"string_too_long", "too_long"}:
        message = f"最多 {ctx.get('max_length', '?')} 个字符/项"
    elif error_type == "literal_error":
        message = f"必须是 {ctx.get('expected', '允许的取值')} 之一"
    elif error_type in {"greater_than_equal", "less_than_equal"}:
        bound = ctx.get("ge", ctx.get("le", "?"))
        message = f"必须在 {bound} 附近"
    else:
        message = _ISSUE_TEMPLATES.get(error_type) or str(error.get("msg") or "不符合要求")
    return PlanIssue(path=path, message=message, expected=str(error.get("msg") or ""))


def _validate_model(raw: dict[str, Any]) -> tuple[ComposePlan | None, list[PlanIssue]]:
    """Pydantic 校验；失败时把错误清单转成 `PlanIssue`。"""
    try:
        return ComposePlan.model_validate(raw), []
    except ValidationError as exc:
        return None, [_issue_from_pydantic(item) for item in exc.errors()]


def _cross_field_issues(
    plan: ComposePlan, catalog: list[design_skills.DesignSkill] | None = None
) -> list[PlanIssue]:
    """两条跨字段校验（字段级 Pydantic 表达不了的约束）。"""
    issues: list[PlanIssue] = []
    if design_skills.get_skill(plan.skill_id, catalog) is None:
        issues.append(
            PlanIssue(
                path="skill_id",
                message="没有命中技能库里的任何技能",
                expected="技能库里已有的 id（如 poster-*）",
            )
        )
    if not any(tag in plan.final_prompt for tag in plan.style_tags):
        issues.append(
            PlanIssue(
                path="final_prompt",
                message="至少要包含 style_tags 里的 1 个词",
                expected="包含 " + " / ".join(plan.style_tags[:3]),
            )
        )
    return issues


def validate_plan(
    raw: Any,
    shortlisted: Iterable[Any] | None = None,
    *,
    allow_verbatim: bool = False,
    catalog: list[design_skills.DesignSkill] | None = None,
) -> ValidationReport:
    """校验一份 plan。

    Args:
        raw: 模型输出或业务层拼装的 dict。
        shortlisted: 技能初筛结果（仅 verbatim 路径用于补默认值）。
        allow_verbatim: 允许 `source='verbatim'` 走宽松路径（用户原话不改写，
            因此 `final_prompt` 可能短于 40 或长于 800——这是产品决策，见 README 的
            偏离说明；其余两条硬约束（aspect / 负向段）仍然强制）。

    Returns:
        `ValidationReport`。`ok=True` 时 `plan` 是**契约形状**的 dict。
    """
    if not isinstance(raw, dict):
        return ValidationReport(
            ok=False,
            plan=None,
            errors=[PlanIssue(path="__root__", message="必须是一个对象", expected="object")],
        )
    source = str(raw.get("source") or "relay")
    if allow_verbatim and source == "verbatim":
        plan = _verbatim_plan(raw, shortlisted, catalog=catalog)
        return ValidationReport(ok=True, plan=plan, errors=[], source=source)

    model, issues = _validate_model(raw)
    if model is not None:
        issues.extend(_cross_field_issues(model, catalog))
    if issues:
        return ValidationReport(ok=False, plan=None, errors=issues, source=source)
    assert model is not None  # 类型收窄：走到这里必然校验通过
    return ValidationReport(ok=True, plan=model.model_dump(), errors=[], source=source)


def validate_analysis(raw: Any) -> ValidationReport:
    """analyze 阶段的契约校验（**只投影契约字段**，仅用于记录格式漂移）。

    线上 analyze 的提示词还会让模型输出 `summary` / `thinking` / `ambiguity` 等展示
    字段，它们不属本契约；这里只取 `subject` / `missing` / `confidence` 三个字段校验，
    失败只记日志、不改行为（否则会把「展示字段多了」误判成「分析失败」）。
    """
    if not isinstance(raw, dict):
        return ValidationReport(
            ok=False,
            plan=None,
            errors=[PlanIssue(path="__root__", message="必须是一个对象", expected="object")],
        )
    projected = {
        "subject": raw.get("subject"),
        "missing": raw.get("missing") or [],
        "confidence": raw.get("confidence"),
    }
    try:
        model = ComposeAnalysis.model_validate(projected)
    except ValidationError as exc:
        return ValidationReport(
            ok=False,
            plan=None,
            errors=[_issue_from_pydantic(item) for item in exc.errors()],
        )
    return ValidationReport(ok=True, plan=model.model_dump(), errors=[])


def build_repair_hint(errors: list[PlanIssue]) -> str:
    """把错误清单拼成一句模型能读懂的纠错提示（R05）。

    必须携带**具体字段路径与期望**：「请输出合法 JSON」这种泛化提示无效。
    """
    lines = [f"你的上一次输出有 {len(errors)} 处不符合要求："]
    for index, issue in enumerate(errors, start=1):
        detail = f"`{issue.path}`：{issue.message}"
        if issue.expected:
            detail += f"（原始提示：{issue.expected}）"
        lines.append(f"{index}. {detail}")
    lines.append(
        "请只输出一个 JSON 对象，不要任何解释文字、不要代码围栏，"
        "也不要输出 extra_notes 之外的任何额外字段。"
    )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# 构造：verbatim / 模板兜底 / 归一
# --------------------------------------------------------------------------- #
def _verbatim_plan(
    raw: dict[str, Any],
    shortlisted: Iterable[Any] | None,
    default_negative: str | None = None,
    catalog: list[design_skills.DesignSkill] | None = None,
) -> dict[str, Any]:
    """`source='verbatim'`：用户原话直用，长度上限走派发兜底（3800）而不是契约 800。"""
    skill = _pick_skill(raw.get("skill_id"), shortlisted, catalog)
    prompt = str(raw.get("final_prompt") or "").strip()
    truncated = len(prompt) > MAX_DISPATCH_PROMPT_CHARS
    if truncated:
        prompt = prompt[:MAX_DISPATCH_PROMPT_CHARS]
    tags = _skill_tags(skill)
    return {
        "schema_version": PLAN_SCHEMA_VERSION,
        "title": _clip(raw.get("title"), 60, "按你的原话生成"),
        "subject": _clip(raw.get("subject"), 120, prompt[:120] or "用户原话"),
        "aspect": normalize_aspect(raw.get("aspect") or getattr(skill, "aspect", "")),
        "negative": _clip(raw.get("negative"), 200, _skill_negative(skill, default_negative)),
        "final_prompt": prompt,
        "skill_id": str(getattr(skill, "id", "") or "")[:80] or "generic",
        "style_tags": tags,
        "reasoning": _reasoning(raw.get("reasoning"), ["原话已足够明确，不加字也不减字"]),
        "source": "verbatim",
        "prompt_truncated": truncated,
    }


def _reasoning(value: Any, default: list[str]) -> list[str]:
    """把 reasoning 收敛成 1–4 条、每条 ≤80 字符。"""
    items = [_clip(item, 80) for item in (value or []) if str(item).strip()]
    items = [item for item in items if item][:4]
    return items or [item[:80] for item in default][:4]


def _assemble_plan(
    raw: dict[str, Any],
    shortlisted: Iterable[Any] | None,
    *,
    source: str,
    default_negative: str | None = None,
    catalog: list[design_skills.DesignSkill] | None = None,
) -> dict[str, Any]:
    """把业务层的半成品拼成**契约形状**的 dict（构造，不校验）。"""
    skill = _pick_skill(raw.get("skill_id"), shortlisted, catalog)
    tags = _skill_tags(skill)
    prompt = _ensure_rich_prompt(str(raw.get("final_prompt") or ""), tags)
    truncated = len(prompt) > MAX_PROMPT_CHARS
    if truncated:
        prompt = prompt[:MAX_PROMPT_CHARS]
    title = _clip(raw.get("title"), 60, getattr(skill, "name", "") or "生图方案")
    return {
        "schema_version": PLAN_SCHEMA_VERSION,
        "title": title,
        "subject": _clip(raw.get("subject"), 120, title),
        "aspect": normalize_aspect(raw.get("aspect") or getattr(skill, "aspect", "")),
        "negative": _clip(raw.get("negative"), 200, _skill_negative(skill, default_negative)),
        "final_prompt": prompt,
        "skill_id": str(getattr(skill, "id", "") or "")[:80] or "generic",
        "style_tags": tags,
        "reasoning": _reasoning(raw.get("reasoning"), ["按技能骨架拼装提示词"]),
        "source": source,
        "prompt_truncated": truncated,
    }


def template_fallback_plan(
    text: str,
    skills: Iterable[Any] | None = None,
    default_negative: str | None = None,
    catalog: list[design_skills.DesignSkill] | None = None,
) -> dict[str, Any]:
    """模板兜底产出：3 次纠错仍不合法时用它，**保证合法且不阻塞建任务**（R05）。"""
    skill = _pick_skill("", skills, catalog)
    base = str(text or "").strip()
    scaffold = str(getattr(skill, "prompt_scaffold", "") or "").strip()
    if base and scaffold:
        prompt = f"{base}。{scaffold}".replace("{主体}", base)
    elif scaffold:
        prompt = scaffold.replace("{主体}", base or "画面主体")
    else:
        prompt = base
    plan = _assemble_plan(
        {
            "final_prompt": prompt,
            "title": getattr(skill, "name", "") or "技能模板方案",
            "subject": base or getattr(skill, "name", "") or "画面主体",
            "reasoning": ["模型输出未通过格式校验，已按技能模板兜底", "可在下方编辑提示词后重新生成"],
            "skill_id": getattr(skill, "id", ""),
        },
        [skill] if skill is not None else [],
        source="template_fallback",
        default_negative=default_negative,
        catalog=catalog,
    )
    report = validate_plan(plan, [skill] if skill is not None else [], catalog=catalog)
    if report.ok and report.plan is not None:
        return {**report.plan, "size": aspect_to_size(report.plan["aspect"]), "prompt_source": "template_fallback"}

    # 兜底中的兜底：绝不允许「兜底本身不合法」。构造上必然满足约束，这里只防意外。
    logger.error("模板兜底产出未通过校验，使用最小合法产出：%s", [i.as_dict() for i in report.errors])
    tags = _skill_tags(skill)
    safe = {
        "schema_version": PLAN_SCHEMA_VERSION,
        "title": "技能模板方案",
        "subject": (base or "画面主体")[:120],
        "aspect": "1:1",
        "negative": _skill_negative(skill, default_negative),
        "final_prompt": _ensure_rich_prompt(scaffold or base or "画面主体清晰", tags)[:MAX_PROMPT_CHARS],
        "skill_id": str(getattr(skill, "id", "") or "")[:80] or "generic",
        "style_tags": tags,
        "reasoning": ["按技能模板兜底生成"],
        "source": "template_fallback",
        "prompt_truncated": False,
    }
    return {**safe, "size": aspect_to_size(safe["aspect"]), "prompt_source": "template_fallback"}


def normalize_plan(
    raw: dict[str, Any] | None,
    shortlisted: Iterable[Any] | None = None,
    *,
    prompt_source: str = "relay",
    default_negative: str | None = None,
    catalog: list[design_skills.DesignSkill] | None = None,
) -> dict[str, Any]:
    """把业务层的半成品收敛成契约形状（并保证可用）。

    - `prompt_source="verbatim"`：用户原话直用，走宽松路径；
    - 其它：拼装 → 校验 → 不合法就退到模板兜底（**不抛异常**，R05「不阻塞建任务」）。

    返回值是**契约字段 + 派生字段**（`size` / `prompt_source`），保持一期前端
    「读 size」的兼容性（架构 §4.4 的向后兼容要求）。
    """
    data = raw if isinstance(raw, dict) else {}
    if prompt_source == "verbatim":
        plan = _verbatim_plan(data, shortlisted, default_negative, catalog)
        return {**plan, "size": aspect_to_size(plan["aspect"]), "prompt_source": "verbatim"}

    source = "template_fallback" if prompt_source in {"template", "template_fallback"} else "relay"
    assembled = _assemble_plan(
        data, shortlisted, source=source, default_negative=default_negative, catalog=catalog
    )
    report = validate_plan(assembled, shortlisted, catalog=catalog)
    if report.ok and report.plan is not None:
        return {
            **report.plan,
            "size": aspect_to_size(report.plan["aspect"]),
            "prompt_source": prompt_source,
        }
    logger.warning(
        "plan 归一后仍不合法，退到模板兜底：source=%s paths=%s",
        prompt_source,
        report.paths,
    )
    fallback = template_fallback_plan(
        str(data.get("final_prompt") or ""), shortlisted, default_negative, catalog
    )
    return {**fallback, "prompt_source": "template_fallback"}


# --------------------------------------------------------------------------- #
# 派发前硬约束（R06）
# --------------------------------------------------------------------------- #
def assemble_dispatch_prompt(
    final_prompt: str,
    negative: str,
    *,
    limit: int = MAX_DISPATCH_PROMPT_CHARS,
    quality_suffix: str = QUALITY_SUFFIX,
) -> str:
    """拼装最终交给图像模型的提示词：`negative` 折进尾部（上游无独立负向参数）。

    超长时**优先截断负向段**而不是主体（ADR-4）——主体是用户要的画面，
    负向段只是「避免什么」，丢几个词不致命。

    平台内置的 `QUALITY_SUFFIX` 会追加在主体末尾：用户自己要的画面原样保留，
    只在后面补画质词。用户已经写过 4K/8K/超高清时不再重复。
    """
    body = str(final_prompt or "").strip()
    suffix = (
        quality_suffix
        if body and not any(mark in body for mark in ("4K", "8K", "超高清"))
        else ""
    )
    tail_text = str(negative or "").strip()
    if not tail_text:
        return f"{body}{suffix}"[:limit]
    tail = f"{NEGATIVE_MARKER}{tail_text}"
    if len(body) + len(suffix) + 2 + len(tail) <= limit:
        return f"{body}{suffix}\n\n{tail}"
    # 空间不够时先放弃画质后缀，保住主体与负向段（主体优先）
    room_for_tail = limit - len(body) - 2
    if room_for_tail > len(NEGATIVE_MARKER):
        return f"{body}\n\n{tail[:room_for_tail]}"
    keep = max(limit - len(tail) - 2, 0)
    return f"{body[:keep]}\n\n{tail}"[:limit]


def assert_dispatchable(plan: dict[str, Any], assembled_prompt: str) -> None:
    """R06：三条硬约束，任一不满足就**拒绝建任务**（不静默通过）。

    校验对象是**拼装后的最终提示词**（`assembled_prompt`），因为 `negative` 是折进
    尾部的——校验 plan 原始字段会漏掉「负向段没进提示词」这种情况。

    Raises:
        AppError: `VALIDATION_ERROR`，`data.missing` 列出缺失项（结构化，无自由文本）。
    """
    missing: list[str] = []
    aspect = str(plan.get("aspect") or "")
    if aspect not in ASPECTS:
        missing.append("aspect")

    final_prompt = str(plan.get("final_prompt") or "")
    negative = str(plan.get("negative") or "")
    if not negative or NEGATIVE_MARKER not in assembled_prompt:
        missing.append("negative")

    # verbatim 是「用户原话一字不改」的一期基线路径：长度与风格词由用户自己决定，
    # R06 的这两条只约束**模型/模板产出**（详见交付说明里的偏离条目）。
    if str(plan.get("source") or "relay") != "verbatim":
        if len(final_prompt) < MIN_PROMPT_CHARS:
            missing.append("final_prompt")
        tags = [str(tag) for tag in (plan.get("style_tags") or []) if str(tag).strip()]
        if not tags or not any(tag in final_prompt for tag in tags):
            missing.append("style_tags")

    if missing:
        logger.warning("出图参数不满足硬约束，拒绝建任务：missing=%s", missing)
        raise AppError(
            ErrorCode.VALIDATION_ERROR,
            "出图的参数还不完整，补齐后就能生成",
            data={"missing": missing},
        )
