"""纯生图全链路编排：需求分析 → 歧义澄清 → 方案推导 → 最终提示词 → 提交生图。

和 `skills.stream_analysis` 的分工
----------------------------------
- `skills.stream_analysis`：**画布图片编辑**，结合原图和选区拆解独立产出；
- 本模块：**从零生成 / 带参考图生成**（侧边栏的主链路），核心是「先想清楚再花钱」。

三条铁律
--------
1. **歧义必须停**：需求不明确时只出方案、不建任务、不扣生图额度；
2. **先分析再执行**：明确需求可按模型确认的原话执行；含糊需求先澄清。
   模型返回不可用时如实失败，不静默降级；
3. **可追溯**：每次编排落一行 `skill_runs`，步骤轨迹与最终提示词都存下来，
   刷新页面后仍能看到当时为什么这么画。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.chat import ChatMessage, ChatSession
from app.models.skill import SkillRun
from app.models.user import User
from app.schemas.compose_plan import (
    MAX_PROMPT_CHARS,
    PLAN_SCHEMA_VERSION,
    ComposeOption,
)
from app.services import (
    asset_service,
    design_skills,
    generate_service,
    plan_validator,
    prompt_service,
    relay_service,
    relay_types,
    vision_service,
)
from app.services.intent_plan import MAX_OUTPUTS
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.compose_service")

SKILL_COMPOSE = "image_compose"
# 「不做任何改写、直接用原话」的选项 id：前端据此把它渲染成兜底选项
VERBATIM_OPTION_ID = "verbatim"
_ALLOWED_SIZES = {"1024x1024", "1536x1024", "1024x1536"}
_MAX_PROMPT = 3800
#: 语义纠错总尝试次数（1 次原始 + 2 次纠错），R05 明确「最多修复 2 次」
MAX_SEMANTIC_ATTEMPTS = 3
#: 保留到日志里的非法输出前缀长度（R05 明确要求 200 字符）
INVALID_HEAD_CHARS = 200

STEPS: tuple[tuple[str, str], ...] = (
    ("analyze", "读懂需求"),
    ("ambiguity", "歧义检查"),
    ("reason", "推导方案"),
    ("prompt", "生成提示词"),
    ("dispatch", "提交生图"),
    ("schedule", "张数判定与并发调度"),
)

#: 一次需求最多独立产出数量；每个任务始终 n=1
MAX_IMAGES = MAX_OUTPUTS
#: 分析流：首字最长等待 / 整体时长上限（超时回落到非流式的 _call_json）
ANALYZE_FIRST_TOKEN_TIMEOUT = 20.0
ANALYZE_TOTAL_TIMEOUT = 75.0
#: 分析过程原文最多保留多少字（实时推送 + 落库回看）
THOUGHT_MAX_CHARS = 2000
#: 模型输出里「思考过程」与「JSON」之间的分隔标记（见 compose_analyze.md）
JSON_MARKER = "<<<JSON>>>"


# --------------------------------------------------------------------------- #
# 技能库：确定性初筛（不让模型在 40+ 条里瞎选）
# --------------------------------------------------------------------------- #
_CATEGORY_HINTS: dict[str, tuple[str, ...]] = {
    "poster": ("海报", "主视觉", "活动", "展览", "演出", "宣传"),
    "brand": ("logo", "标志", "品牌", "vi", "包装", "商标", "手册"),
    "social": ("小红书", "朋友圈", "公众号", "封面", "头图", "笔记", "社媒", "直播"),
    "ecommerce": ("电商", "主图", "详情页", "产品图", "淘宝", "商品", "模特", "banner"),
    "ui": ("界面", "app", "ui", "网页", "落地页", "看板", "图标", "表单", "引导页"),
    "illustration": ("插画", "角色", "绘本", "二次元", "卡通", "ip", "像素", "单线"),
    "photo": ("摄影", "人像", "实拍", "写真", "美食", "建筑", "街拍"),
    "type": ("字体", "标题字", "排版", "文字海报", "竖排"),
    "color": ("配色", "色彩", "调色", "色板", "渐变"),
    "layout": ("版式", "构图", "画册", "杂志", "信息图", "折页", "三联"),
    "print": ("菜单", "价签", "名片", "简历", "邀请函", "证书", "印刷", "传单", "立牌"),
    "deck": ("ppt", "演示", "汇报", "路演", "流程图", "架构图", "图表", "幻灯片"),
    "audio": ("播客", "专辑", "书封", "书籍", "有声书", "封面图"),
    "merch": ("t恤", "贴纸", "表情包", "周边", "三视图", "印花", "徽章"),
    "avatar": ("头像", "壁纸", "直播间背景", "个人主页"),
    "three_d": ("3d", "渲染", "立体", "材质", "粘土", "玻璃", "等距"),
}


def _bigrams(text: str) -> set[str]:
    """中文没有空格，用二元组做粗糙但有效的相似度。"""
    value = re.sub(r"\s+", "", text.lower())
    return {value[i : i + 2] for i in range(len(value) - 1)}


def shortlist_skills(text: str, limit: int = 5) -> list[design_skills.DesignSkill]:
    """按关键词 + 用途词 + 二元组重合度初筛技能（纯确定性，可单测）。

    约束：同一分类最多入选 2 条——否则「海报」一句话会把 4 张海报技能全塞给模型，
    反而丢掉「这次到底该用海报还是社媒封面」的判断空间。
    """
    query = (text or "").lower()
    if not query.strip():
        return []
    query_grams = _bigrams(query)
    scored: list[tuple[float, design_skills.DesignSkill]] = []
    for skill in design_skills.SKILLS:
        score = 0.0
        for tag in skill.style_tags:
            if tag and tag.lower() in query:
                score += 4
        for word in _CATEGORY_HINTS.get(skill.category, ()):
            if word in query:
                score += 3
        if skill.name.lower() in query:
            score += 6
        body = f"{skill.name}{skill.description}{skill.when_to_use}{skill.prompt_scaffold}"
        overlap = len(query_grams & _bigrams(body))
        score += min(overlap, 8) * 0.5
        if score > 0:
            scored.append((score, skill))
    scored.sort(key=lambda item: item[0], reverse=True)

    picked: list[design_skills.DesignSkill] = []
    per_category: dict[str, int] = {}
    for _, skill in scored:
        if per_category.get(skill.category, 0) >= 2:
            continue
        picked.append(skill)
        per_category[skill.category] = per_category.get(skill.category, 0) + 1
        if len(picked) >= limit:
            break
    return picked


# --------------------------------------------------------------------------- #
# 工具
# --------------------------------------------------------------------------- #
def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


# --------------------------------------------------------------------------- #
# 面向用户的回复正文（流式）
# --------------------------------------------------------------------------- #
#: 首字最长等待：超过就放弃流式、改用本地文案，别让用户对着空气泡发呆
REPLY_FIRST_TOKEN_TIMEOUT = 12.0
#: 整段回复的总时长上限
REPLY_TOTAL_TIMEOUT = 40.0
#: 回复正文上限（防止模型失控刷屏）
REPLY_MAX_CHARS = 1200
#: 本地文案「打字机」每段字数与间隔：让回落文案也是一个字一个字出来，体验与流式一致
TYPEWRITER_CHUNK = 4
TYPEWRITER_DELAY = 0.014


async def _typewriter(text: str) -> AsyncIterator[str]:
    """把一段现成文案按小段吐出（回落路径用）。"""
    for start in range(0, len(text), TYPEWRITER_CHUNK):
        yield _sse({"event": "delta", "text": text[start : start + TYPEWRITER_CHUNK]})
        await asyncio.sleep(TYPEWRITER_DELAY)


async def _stream_reply(
    db: AsyncSession,
    target: relay_service.RelayTarget | None,
    *,
    mode: str,
    facts: dict[str, Any],
    fallback: str,
    sink: list[str],
) -> AsyncIterator[str]:
    """生成这一轮的回复正文，以 `{"event":"delta","text":...}` 逐段推给前端。

    结论（澄清 / 已开画 / 失败）在调用前就已经定了，这里只负责「把结论说成人话」：
    - 有中转站 → 流式请求 `compose_reply` 提示词，边生成边推；
    - 没有中转站、首字超时、上游报错 → 回落到 `fallback`（原来那一句），用打字机吐出。

    完整正文写进 `sink[0]`，调用方拿它落库。回复失败**绝不**影响主流程：
    任务已经提交、澄清选项已经落库，最差也只是回复短一点。
    """
    collected: list[str] = []

    async def pump() -> AsyncIterator[str]:
        template = await prompt_service.load(db, "compose_reply")
        payload = json.dumps({"mode": mode, **facts}, ensure_ascii=False)
        stream = relay_service.chat_stream(
            target,  # type: ignore[arg-type] - 调用方已判空
            [
                {"role": "system", "content": template},
                {"role": "user", "content": f"本轮事实（JSON）：\n{payload}\n\n请直接写回复正文。"},
            ],
            temperature=0.6,
            max_tokens=700,
        )
        iterator = stream.__aiter__()
        started = time.perf_counter()
        first = True
        while True:
            budget = REPLY_FIRST_TOKEN_TIMEOUT if first else REPLY_TOTAL_TIMEOUT - (time.perf_counter() - started)
            if budget <= 0:
                break
            try:
                piece = await asyncio.wait_for(iterator.__anext__(), timeout=budget)
            except StopAsyncIteration:
                break
            first = False
            room = REPLY_MAX_CHARS - sum(len(item) for item in collected)
            if room <= 0:
                break
            piece = piece[:room]
            collected.append(piece)
            yield _sse({"event": "delta", "text": piece})

    if target is not None:
        try:
            async for chunk in pump():
                yield chunk
        except (AppError, asyncio.TimeoutError, OSError) as exc:  # noqa: PERF203
            logger.warning("回复正文流式失败，回落本地文案 mode=%s: %s", mode, getattr(exc, "message", exc))
        except Exception:  # noqa: BLE001 - 回复是锦上添花，任何异常都不能打断主流程
            logger.exception("回复正文流式异常 mode=%s", mode)

    text = "".join(collected).strip()
    if len(text) < 8:
        # 什么都没拿到（或只蹦出几个字就断了）：让前端清掉半截，换成完整的本地文案
        if collected:
            yield _sse({"event": "delta_reset"})
        async for chunk in _typewriter(fallback):
            yield chunk
        text = fallback
    sink.append(text)


def _extract_json(text: str) -> dict[str, Any] | None:
    """从模型回复里稳健抽取 JSON（容忍围栏、前后说明）。"""
    if not text:
        return None
    # 「先写思考、再写 JSON」的输出：只在标记之后找，免得摘要里的花括号干扰
    if JSON_MARKER in text:
        text = text.split(JSON_MARKER, 1)[1]
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


class _Trace:
    """步骤轨迹：支持 items（公开处理要点）与 detail（一句话结论）。"""

    def __init__(self) -> None:
        self.steps: list[dict[str, Any]] = []
        self._started: dict[str, float] = {}

    def start(self, step_id: str, title: str, detail: str = "") -> dict[str, Any]:
        self._started[step_id] = time.perf_counter()
        payload = {
            "id": step_id,
            "title": title,
            "detail": detail,
            "status": "running",
            "elapsed_ms": 0,
            "items": [],
        }
        self.steps.append(payload)
        return payload

    def finish(
        self,
        step_id: str,
        *,
        status: str = "done",
        detail: str | None = None,
        items: list[str] | None = None,
        thought: str | None = None,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """结束一步。

        - `thought`：这一步模型公开输出的分析摘要（前端可展开回看）；
        - `meta`：模型 / 耗时 / 输出量等可量化信息，用来如实展示「算力花在哪」。
        """
        started = self._started.pop(step_id, None)
        elapsed = int((time.perf_counter() - started) * 1000) if started else 0
        for step in reversed(self.steps):
            if step["id"] != step_id:
                continue
            step["status"] = status
            step["elapsed_ms"] = elapsed
            if detail is not None:
                step["detail"] = detail
            if items is not None:
                step["items"] = items
            if thought:
                step["thought"] = thought[:THOUGHT_MAX_CHARS]
            if meta:
                step["meta"] = meta
            return step
        payload = {
            "id": step_id,
            "title": step_id,
            "detail": detail or "",
            "status": status,
            "elapsed_ms": elapsed,
            "items": items or [],
        }
        self.steps.append(payload)
        return payload


def _normalize_size(value: Any, fallback: str = "1024x1024") -> str:
    size = str(value or "").strip()
    if size in _ALLOWED_SIZES:
        return size
    return fallback


def _confidence(value: Any, default: float = 0.9) -> int:
    """模型给的置信度是不可信输入：夹到 0–1 再转百分数。"""
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return int(round(max(0.0, min(1.0, number)) * 100))


def _normalize_options(raw: Any, default_count: int = 1) -> list[dict[str, Any]]:
    """把模型给的方案收敛成前端可渲染的结构；没有 prompt 的方案直接丢弃。

    顺序即推荐序：模型排在前面的是它认为最贴合的方案，前端把第一条标成「最推荐」。

    契约说明：模型给的是 `size`（一期字段），契约要的是 `aspect`（R04/C1）。
    这里按 `ASPECT_TO_SIZE` 反向映射补上 `aspect`，并用 `ComposeOption` 做一次
    **只记日志、不改行为**的漂移检测——澄清卡丢掉一个方案，用户就少一个方向，
    代价远大于「格式洁癖」。
    """
    items = raw if isinstance(raw, list) else []
    options: list[dict[str, Any]] = []
    for position, item in enumerate(items[:3], start=1):
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or "").strip()
        if len(prompt) < 8:
            continue
        size = _normalize_size(item.get("size"))
        option = {
            "id": str(item.get("id") or chr(96 + position))[:8],
            "label": str(item.get("label") or f"方案 {position}").strip()[:20],
            "description": str(item.get("description") or "").strip()[:120],
            "prompt": prompt[:_MAX_PROMPT],
            "size": size,
            # 契约字段（R04）：由 size 派生，保证前端两条路径拿到的比例一致
            "aspect": plan_validator.aspect_from_size(size),
            # 每个方向可以自带张数；没写就沿用分析判定的张数
            "image_count": _clamp_count(item.get("image_count"), default_count),
        }
        _log_option_drift(option)
        options.append(option)
    return options


def _log_option_drift(option: dict[str, Any]) -> None:
    """用契约模型做漂移检测：只记日志，不丢弃选项（R04 的可观测性）。"""
    projected = {**option, "prompt": str(option.get("prompt") or "")[:MAX_PROMPT_CHARS]}
    try:
        ComposeOption.model_validate(projected)
    except Exception as exc:  # noqa: BLE001 - 校验失败只记日志
        logger.info("澄清方案不符合契约（保留不丢弃）：%s", str(exc)[:300])


def _verbatim_option(text: str, size: str = "1024x1024", image_count: int = 1) -> dict[str, Any]:
    """「直接用我的原话」——永远排在选项列表最后，且永远存在。

    这是整条链的兜底与用户主权：无论模型觉得这句话多含糊、多想替他改，
    他都可以选它，系统就按原文一字不改地去画。
    """
    return {
        "id": VERBATIM_OPTION_ID,
        "label": "直接用我的原话",
        "description": "一字不改，按你写的这句去生成",
        "prompt": text.strip()[:_MAX_PROMPT],
        "size": _normalize_size(size),
        "image_count": _clamp_count(image_count, 1),
    }


def _prompt_is_actionable(analysis: dict[str, Any], text: str) -> bool:
    """判断用户原话是否已经**足够明确、可以原样开工**。

    只有三个条件同时成立才认为「可以直接画」：
    1. 模型没有列出缺失信息（`missing` 为空）；
    2. 模型识别出了主体；
    3. 模型自评置信度 ≥ 0.7（<0.7 表示它自己也没把握）。

    不满足就走澄清流程停下来问用户，**绝不拿改写后的提示词顶替原话**。
    """
    if len(text.strip()) < 8:
        return False
    if [item for item in (analysis.get("missing") or []) if str(item).strip()]:
        return False
    if not str(analysis.get("subject") or "").strip():
        return False
    try:
        confidence = float(analysis.get("confidence"))
    except (TypeError, ValueError):
        # 模型没报置信度：沿用系统其它地方一致的默认口径（0.9）
        confidence = 0.9
    return confidence >= 0.7


_SKILL_NEGATIVES = {
    str(skill.negative).strip()
    for skill in design_skills.SKILLS
    if str(skill.negative).strip()
}
_SKILL_NEGATIVE_TAIL = re.compile(r"\n*\s*画面中避免出现：([^\n]+)\s*$")


def _strip_skill_negative_tails(text: str) -> str:
    """删掉用户输入末尾由技能模板注入的负向段（如「避免写实皮肤」）。

    这些负向段是平台自己的产物：用户从历史结果里复制、或旧版技能库插入后，
    会一直留在输入里，把「真人写实」反向压成 Q 版/3D 角色。只删与内置技能
    负向词**完全一致**的尾段，用户自己写的其它内容原样保留。
    """
    original = str(text or "").strip()
    cleaned = original
    while True:
        match = _SKILL_NEGATIVE_TAIL.search(cleaned)
        if match is None or match.group(1).strip() not in _SKILL_NEGATIVES:
            break
        cleaned = cleaned[: match.start()].rstrip()
    return cleaned or original


def _last_user_text(messages: list[dict[str, Any]]) -> str:
    """取最后一条 user 消息的正文（模板兜底时当作「用户需求」的近似）。"""
    for item in reversed(messages):
        if item.get("role") == "user":
            return str(item.get("content") or "")
    return ""


async def _call_json(
    db: AsyncSession,
    user_id: str,
    messages: list[dict[str, Any]],
    *,
    temperature: float = 0.4,
    max_tokens: int = 1600,
    target: relay_service.RelayTarget | None = None,
    schema: type | None = None,
    stage: str = "generic",
    shortlisted: list[design_skills.DesignSkill] | None = None,
) -> tuple[dict[str, Any], relay_types.RelayOutcome, list[str]]:
    """调中转站并要求 JSON，返回 ``(plan_dict, outcome, repair_log)``。

    **两层重试的分工（陷阱：两层不能互相抵消）**

    - **L1 传输重试**在 `relay_service.chat_resilient()` 内部：响应体是网页 / 空体 /
      截断时，它自己同模型重试 + 换备用模型。这一层不消耗下面的纠错预算，因为
      「上游返回网页」不是模型输出的格式问题，拿同一条坏管道做语义纠错毫无意义；
    - **L2 语义纠错**在本函数：只有在**拿到了可解析文本、但内容不符合契约**时才追加
      纠错提示再试（≤2 次）。纠错提示必须带「字段路径 + 期望」，否则模型改不动。

    3 次仍不合法 → **模板兜底**（`source=template_fallback`），不抛异常、不阻塞建任务
    （R05）。传输层彻底失败（链耗尽）仍然如实抛 `AppError`——那时连文本都没有，
    用模板顶替等于骗用户。

    Args:
        schema: 传入契约模型即开启语义纠错；`None` 表示只要「能解析成 dict」。
        stage: `analyze` / `reason` / `prompt`，仅用于日志与统计。
        shortlisted: 技能初筛结果，模板兜底时用来选技能骨架。
    """
    repair_log: list[str] = []
    last_issues: list[plan_validator.PlanIssue] = []
    outcome: relay_types.RelayOutcome | None = None
    current = list(messages)
    attempts = 0

    while attempts < MAX_SEMANTIC_ATTEMPTS:
        attempts += 1
        # L1：传输层的重试 / 换模型全在 chat_resilient 里，这里只关心「拿到什么文本」
        outcome = await relay_service.chat_resilient(
            db,
            user_id,
            current,
            json_mode=True,
            temperature=temperature,
            max_tokens=max_tokens,
            target=target,
            purpose=stage,
        )
        parsed = _extract_json(outcome.content)
        if parsed is None:
            head = outcome.content[:INVALID_HEAD_CHARS]
            logger.warning("编排返回非 JSON（第 %s 次，stage=%s）：%s", attempts, stage, head)
            repair_log.append(f"attempt={attempts} reason=not_json head={head[:60]}")
            if schema is None and attempts >= 2:
                # 无契约的老路径：保留一期的「再试一次」语义，两次都不行就如实失败
                break
            current = [
                *messages,
                {
                    "role": "user",
                    "content": "上一次的回复无法解析成一个 JSON 对象。请只输出一个 JSON 对象，不要任何解释文字。",
                },
            ]
            continue

        if schema is None:
            return (
                {
                    **parsed,
                    "_meta": {
                        "model": outcome.model,
                        "provider": outcome.provider,
                        "source": outcome.source,
                        "elapsed_ms": outcome.elapsed_ms,
                    },
                },
                outcome,
                repair_log,
            )

        report = plan_validator.validate_plan(parsed, shortlisted, allow_verbatim=True)
        if report.ok and report.plan is not None:
            return report.plan, outcome, repair_log

        last_issues = report.errors
        logger.warning(
            "plan 校验失败（第 %s 次，stage=%s）paths=%s head=%s",
            attempts,
            stage,
            report.paths,
            outcome.content[:INVALID_HEAD_CHARS],
        )
        repair_log.append(f"attempt={attempts} paths={','.join(report.paths)}")
        # 纠错提示必须带具体字段路径与期望（R05）
        current = [
            *messages,
            {"role": "user", "content": plan_validator.build_repair_hint(report.errors)},
        ]

    if schema is None:
        raise AppError(
            ErrorCode.UPSTREAM_FORMAT_ERROR,
            "这次返回的内容读不出来，重试一次或换一个模型",
            data={"reason": "not_json", "stage": stage, "attempts": attempts},
        )

    # 3 次仍不合法 → 模板兜底，不阻塞建任务（R05）
    plan = plan_validator.template_fallback_plan(_last_user_text(messages), shortlisted)
    logger.warning(
        "plan 连续 %s 次未通过校验，已用技能模板兜底：stage=%s issues=%s",
        attempts,
        stage,
        [issue.as_dict() for issue in last_issues],
    )
    repair_log.append("template_fallback")
    if outcome is None:  # 防御：循环至少执行一次，这里理论上不可达
        raise AppError(
            ErrorCode.UPSTREAM_FORMAT_ERROR,
            "这次没能拿到可用的结果，换一个模型再试一次",
            data={"reason": "no_content", "stage": stage, "attempts": attempts},
        )
    return plan, outcome, repair_log


async def _stream_analysis(
    target: relay_service.RelayTarget | None,
    messages: list[dict[str, Any]],
    sink: dict[str, Any],
    *,
    text_stream: AsyncIterator[str] | None = None,
    model: str = "",
) -> AsyncIterator[str]:
    """流式跑需求分析：模型实时输出公开需求摘要，结构化计划仅报告生成进度。

    事件：
    - `{"event":"thought","text":...}`：分析摘要的增量（`<<<JSON>>>` 之前的自然语言）；
    - `{"event":"thought_progress","chars":N}`：进入 JSON 段后只报字数，不刷原文。

    结束后 `sink` 里放 `analysis`（解析好的 dict）与 `thought`（公开摘要）。
    读不出 JSON / 超时 / 上游报错都抛异常，由调用方回落到非流式的 `_call_json`。
    """
    started = time.perf_counter()
    stream = text_stream if text_stream is not None else relay_service.chat_stream(target, messages, temperature=0.4, max_tokens=5000)
    iterator = stream.__aiter__()
    raw: list[str] = []
    thought_sent = 0  # 已经推给前端的思考字数
    in_json = False
    last_progress = 0
    first = True
    while True:
        elapsed = time.perf_counter() - started
        budget = ANALYZE_FIRST_TOKEN_TIMEOUT if first else ANALYZE_TOTAL_TIMEOUT - elapsed
        if budget <= 0:
            raise asyncio.TimeoutError()
        try:
            piece = await asyncio.wait_for(iterator.__anext__(), timeout=budget)
        except StopAsyncIteration:
            break
        first = False
        raw.append(piece)
        text = "".join(raw)
        if not in_json:
            stripped = text.lstrip()
            # 模型跳过了思考、直接写 JSON：不把 JSON 当思考刷给用户
            if JSON_MARKER in text or stripped.startswith(("{", "```")):
                in_json = True
                head = text.split(JSON_MARKER, 1)[0] if JSON_MARKER in text else ""
                if len(head) > thought_sent:
                    yield _sse({"event": "thought", "text": head[thought_sent:THOUGHT_MAX_CHARS]})
                    thought_sent = len(head)
            else:
                # 末尾留出标记长度：防止 "<<<JS" 这种半截标记先被推出去
                safe = max(0, len(text) - len(JSON_MARKER))
                safe = min(safe, THOUGHT_MAX_CHARS)
                if safe > thought_sent:
                    yield _sse({"event": "thought", "text": text[thought_sent:safe]})
                    thought_sent = safe
        if in_json:
            body_chars = len(text.split(JSON_MARKER, 1)[-1])
            if body_chars - last_progress >= 80:
                last_progress = body_chars
                yield _sse({"event": "thought_progress", "chars": body_chars})

    text = "".join(raw)
    if not in_json and len(text) > thought_sent:
        # 没写标记、整段都当成了思考：补推剩余部分（JSON 还是会从全文里找）
        tail = text[thought_sent:THOUGHT_MAX_CHARS]
        if tail and not tail.lstrip().startswith("{"):
            yield _sse({"event": "thought", "text": tail})
    parsed = _extract_json(text)
    if parsed is None:
        raise AppError(ErrorCode.UPSTREAM_FORMAT_ERROR, "分析结果读不出来")
    thought = text.split(JSON_MARKER, 1)[0].strip() if JSON_MARKER in text else ""
    if thought.startswith(("{", "```")):
        thought = ""
    parsed["_meta"] = {
        "model": target.model if target else model,
        "provider": target.name if target else "意图分析模型",
        "source": target.source if target else "intent",
        "elapsed_ms": int((time.perf_counter() - started) * 1000),
        "output_chars": len(text),
        "streamed": True,
    }
    sink["analysis"] = parsed
    sink["thought"] = thought[:THOUGHT_MAX_CHARS]


def _clamp_count(value: Any, default: int = 1) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(1, min(MAX_IMAGES, number))


def resolve_jobs(analysis: dict[str, Any], base_prompt: str) -> list[dict[str, Any]]:
    """把分析结果展开成 N 个独立生图任务（通用：不认任何具体场景）。

    - 张数来自模型的 `image_count`（1–12），超限明确失败，缺省为 1；
    - 每张的提示词：`images[i].prompt` 有内容（≥8 字）就用它（「不同画面」拆分），
      否则用 `base_prompt`（「同一画面多版本」/ 单张）；
    - 只有 1 张时**永远**用 `base_prompt`：保持原话直用的规则不变。
    """
    base = base_prompt.strip()
    raw_count = analysis.get("image_count", 1)
    if type(raw_count) is not int:
        raise AppError(ErrorCode.UPSTREAM_FORMAT_ERROR, "分析结果没有有效的产出数量，请重新分析")
    count = raw_count
    if count < 1 or count > MAX_IMAGES:
        raise AppError(ErrorCode.VALIDATION_ERROR, f"单次最多支持 {MAX_IMAGES} 张图片，请拆分需求后提交")
    raw_images = analysis.get("images") if isinstance(analysis.get("images"), list) else []
    jobs: list[dict[str, Any]] = []
    for index in range(count):
        item = raw_images[index] if index < len(raw_images) and isinstance(raw_images[index], dict) else {}
        custom = str(item.get("prompt") or "").strip()[:_MAX_PROMPT]
        label = str(item.get("label") or "").strip()[:20]
        use_custom = count > 1 and len(custom) >= 8
        jobs.append(
            {
                "index": index + 1,
                "label": label or (f"第 {index + 1} 张" if count > 1 else ""),
                "prompt": custom if use_custom else base,
                "custom": use_custom,
            }
        )
    return jobs


async def _free_slots(db: AsyncSession, user_id: str) -> int:
    """当前用户还能同时跑几个任务（受 MAX_ACTIVE_TASKS_PER_USER 约束）。"""
    from app.config import settings
    from app.services import config_service, task_service

    limit = int(
        await config_service.get_value(db, "MAX_ACTIVE_TASKS_PER_USER", settings.max_active_tasks_per_user)
    )
    return max(0, limit - await task_service.count_active(db, user_id))


async def _pool_capacity() -> dict[str, int] | None:
    """号池可用账号数（尽力而为：网关不可达 / 演示模式就不展示）。"""
    from app.services import pool_service

    try:
        stats = await asyncio.wait_for(pool_service.stats(), timeout=2.0)
    except Exception:  # noqa: BLE001 - 只是展示信息，拿不到就不说
        return None
    if not stats.get("total"):
        return None
    return {"total": int(stats.get("routable_total") or 0), "normal": int(stats.get("routable_available") or 0)}


async def _schedule_jobs(
    db: AsyncSession, user_id: str, jobs: list[dict[str, Any]], count_reason: str
) -> tuple[list[dict[str, Any]], list[str]]:
    """保留完整需求清单，展示实际容量；派发前统一校验整批。"""
    wanted = len(jobs)
    free = await _free_slots(db, user_id)
    scheduled = jobs
    items = [f"需要生成 {wanted} 张" + (f"：{count_reason}" if count_reason else "")]
    for job in scheduled:
        source = "专属描述" if job["custom"] else "原话"
        label = f"「{job['label']}」" if job["label"] else ""
        items.append(f"通道 {job['index']}{label} → 独立账号额度 · 提示词来源：{source}")
    if free < wanted:
        items.append(f"当前可用 {free} 个并发槽位，需要 {wanted} 个；提交前校验整批，避免遗漏产出")
    pool = await _pool_capacity()
    if pool:
        items.append(f"可独立路由账号 {pool['normal']}/{pool['total']}；以执行时实际预留为准")
    return scheduled, items


async def _load_assets(db: AsyncSession, user: User, ids: list[str]) -> list[Any]:
    """加载参考图资产（按传入顺序，跳过不属于该用户的）。"""
    assets: list[Any] = []
    for asset_id in ids[:4]:
        try:
            assets.append(await asset_service.get_asset(db, user, asset_id))
        except AppError:
            logger.warning("参考图不存在或无权访问：%s", asset_id)
    return assets


def _describe_context(assets: list[Any], selection: dict[str, Any] | None) -> str:
    """参考图与选区的文字上下文，像素由vision_service同时附加。"""
    lines: list[str] = []
    if assets:
        lines.append(f"用户提供了 {len(assets)} 张参考图（用于图生图或风格参考）。")
    else:
        lines.append("用户没有提供参考图。")
    regions = (selection or {}).get("regions") or []
    if regions:
        lines.append(f"用户框选了 {len(regions)} 个区域，只希望改这些区域，其余保持原样。")
        for item in regions[:6]:
            prompt = str(item.get("prompt") or "").strip()
            lines.append(f"- 区域{item.get('index')}：{prompt or '（未写说明）'}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
async def stream_compose(
    *,
    user: User,
    session_id: str,
    content: str,
    canvas_id: str | None = None,
    image_refs: list[str] | None = None,
    selection: dict[str, Any] | None = None,
    model: str | None = None,
) -> AsyncIterator[str]:
    """SSE：把全链路思考实时吐给前端，最后给出结论（澄清 / 已提交 / 未配置）。"""
    trace = _Trace()
    raw_text = (content or "").strip()
    # 展示与留档保留用户原话；分析与出图用清理掉技能注入负向段的版本
    text = _strip_skill_negative_tails(raw_text)
    refs = [str(item) for item in (image_refs or []) if str(item).strip()][:4]

    async with AsyncSessionLocal() as db:
        session = (
            await db.execute(select(ChatSession).where(ChatSession.id == session_id))
        ).scalar_one_or_none()
        if session is None or session.user_id != user.id:
            raise AppError(ErrorCode.NOT_FOUND, "会话不存在")

        assets = await _load_assets(db, user, refs)
        attachments = [
            {
                "type": "image",
                "asset_id": asset.id,
                "url": asset.url,
                "name": asset.url.rsplit("/", 1)[-1],
                "width": asset.width,
                "height": asset.height,
            }
            for asset in assets
        ]
        user_message = await _append_message(
            db, session.id, user.id, "user", raw_text, attachments=attachments
        )
        # 新的提交让本会话里还在等待选择的澄清卡作废：否则刷新后旧卡仍可点，
        # 用户会拿着一条已经过时的方案去花额度（服务端也会再拒一次）。
        await db.execute(
            update(SkillRun)
            .where(
                SkillRun.session_id == session.id,
                SkillRun.skill_id == SKILL_COMPOSE,
                SkillRun.status == "clarify",
            )
            .values(status="voided", updated_at=utcnow())
        )
        await db.commit()

        # ---- 0) 中转站就绪检查：没有就停在这里，不伪造任何 AI 结论 ----
        target = await relay_service.resolve(db, user.id)
        if target is None:
            step = trace.start("analyze", STEPS[0][1])
            yield _sse({"event": "step", "step": dict(step)})
            step = trace.finish(
                "analyze",
                status="blocked",
                detail="还没有配置 AI 中转站，无法做需求分析",
                items=[
                    "本平台不绕过中转站直接生成：需求分析、澄清、提示词都必须由它完成",
                    "配置入口：左侧「中转站」按钮 → 填地址、Key、模型",
                ],
            )
            yield _sse({"event": "step", "step": dict(step)})
            message = await _append_message(
                db,
                session.id,
                user.id,
                "assistant",
                "还没连上 AI 中转站，我先停在这里。填好地址、Key 和模型后，再发一次这句话我就能直接开画。",
                attachments=[
                    {
                        "type": "compose_run",
                        "run_id": "",
                        "status": "unconfigured",
                        "reply": "还没连上 AI 中转站，我先停在这里。",
                        "content": text,
                        "steps": list(trace.steps),
                        "final_prompt": "",
                        "options": [],
                        "tasks": [],
                        "prompt_source": "none",
                        "degraded": False,
                    }
                ],
            )
            await db.commit()
            yield _sse(
                {
                    "event": "result",
                    "result": {
                        "run_id": "",
                        "message_id": message.id,
                        "user_message_id": user_message.id,
                        "status": "unconfigured",
                        "reply": message.content,
                        "steps": list(trace.steps),
                        "options": [],
                        "tasks": [],
                        "final_prompt": "",
                        "prompt_source": "none",
                        "degraded": False,
                        "action": {"type": "open_ai_config"},
                        "relay": {"configured": False},
                    },
                }
            )
            return

        # ---- 1) 读懂需求 ----
        step = trace.start("analyze", STEPS[0][1], "正在把这句话拆成主体、风格、构图与约束")
        yield _sse({"event": "step", "step": dict(step)})

        template = await prompt_service.load(db, "compose_analyze")
        # 技能骨架 / 技能包不再注入分析提示词：只按用户原话判断，
        # 避免平台预设的风格词覆盖用户的真实需求（例如把写实人像带成 Q 版）。
        shortlisted: list[design_skills.DesignSkill] = []
        user_prompt = (
            f"用户原话：{text}\n\n"
            f"{_describe_context(assets, selection)}\n\n"
            "请先输出面向用户的分析摘要，再按系统契约输出结构化计划。"
        )

        analyze_messages = [
            {"role": "system", "content": template},
            {"role": "user", "content": vision_service.user_content(user_prompt, assets)},
        ]
        thought_text = ""
        try:
            # 先走流式：公开分析摘要实时可见；流式读不出 JSON 再回落到非流式 + 纠错重试
            sink: dict[str, Any] = {}
            streamed_ok = False
            try:
                async for chunk in _stream_analysis(target, analyze_messages, sink):
                    yield chunk
                streamed_ok = "analysis" in sink
            except (AppError, asyncio.TimeoutError, OSError) as exc:
                logger.warning("流式分析失败，回落非流式：%s", getattr(exc, "message", exc))
            except Exception:  # noqa: BLE001 - 流式只是体验增强，任何异常都回落
                logger.exception("流式分析异常，回落非流式")
            if streamed_ok:
                analysis = sink["analysis"]
                thought_text = str(sink.get("thought") or "")
            else:
                yield _sse({"event": "thought_reset"})
                analysis, _outcome, _repairs = await _call_json(
                    db,
                    user.id,
                    analyze_messages,
                    target=target,
                    stage="analyze",
                )
            # Validate counts while still inside the visible analysis error path.
            resolve_jobs(analysis, text)
        except AppError as exc:
            step = trace.finish("analyze", status="failed", detail=exc.message)
            yield _sse({"event": "step", "step": dict(step)})
            message = await _append_message(
                db, session.id, user.id, "assistant", exc.message,
                attachments=[
                    {
                        "type": "compose_run",
                        "run_id": "",
                        "status": "failed",
                        "steps": list(trace.steps),
                        "reply": exc.message,
                        "final_prompt": "",
                        "options": [],
                        "tasks": [],
                        "prompt_source": "none",
                        "degraded": False,
                    }
                ],
            )
            await db.commit()
            yield _sse(
                {
                    "event": "result",
                    "result": {
                        "run_id": "",
                        "message_id": message.id,
                        "user_message_id": user_message.id,
                        "status": "failed",
                        "reply": exc.message,
                        "steps": list(trace.steps),
                        "options": [],
                        "tasks": [],
                        "final_prompt": "",
                        "prompt_source": "none",
                        "degraded": False,
                        "error_code": exc.code.value,
                        # R03：结构化错误数据（现象 / 已尝试 / 下一步）随失败帧下发，
                        # 前端 ErrorCard 据此渲染三段式，不依赖后端自由文本
                        "error_data": exc.data,
                    },
                }
            )
            return
        # 契约漂移只记录、不阻塞：analyze 还带展示字段（thinking / ambiguity），
        # 不在 ComposeAnalysis 契约范围内，投影校验只用于发现真漂移（R04 可观测性）
        drift = plan_validator.validate_analysis(analysis)
        if not drift.ok:
            logger.warning(
                "analyze 输出不符合契约（仅记录）：%s",
                [issue.as_dict() for issue in drift.errors],
            )
        thinking = [str(item) for item in (analysis.get("thinking") or []) if str(item).strip()][:5]
        # 结构化拆解：把模型读出的主体 / 风格 / 约束 / 张数也摆出来，过程才完整
        facts: list[str] = []
        if analysis.get("subject"):
            facts.append(f"主体：{str(analysis.get('subject'))[:60]}")
        if analysis.get("style"):
            facts.append(f"风格：{str(analysis.get('style'))[:60]}")
        constraints = [str(c) for c in (analysis.get("constraints") or []) if str(c).strip()]
        if constraints:
            facts.append(f"约束：{'；'.join(constraints[:3])[:80]}")
        facts.append(f"判定张数：{_clamp_count(analysis.get('image_count'), 1)}")
        meta_raw = analysis.get("_meta") if isinstance(analysis.get("_meta"), dict) else {}
        step = trace.finish(
            "analyze",
            detail=str(analysis.get("summary") or "已读懂需求")[:160],
            items=thinking + facts,
            thought=thought_text,
            meta={
                "model": str(meta_raw.get("model") or target.model),
                "elapsed_ms": int(meta_raw.get("elapsed_ms") or 0),
                "output_chars": int(meta_raw.get("output_chars") or 0),
                "streamed": bool(meta_raw.get("streamed")),
            },
        )
        yield _sse({"event": "step", "step": dict(step)})

        # ---- 2) 歧义检查 ----
        #
        # 这一步决定整条链往哪走，规则只有两条，且都必须显式成立：
        #   A. 模型说「有歧义」或判定「还不明确」→ **停下来问**，
        #      给出多个方向选项（第一条 = 最推荐）+ 永远保留的「直接用我的原话」；
        #   B. 模型确认原话已经足够明确 → **原样使用**，一个字都不改。
        # 不存在第三条「悄悄改一版再画」的路——那正是重复对话与信任崩塌的来源。
        step = trace.start("ambiguity", STEPS[1][1], "检查主体、用途、约束是否足以开画")
        yield _sse({"event": "step", "step": dict(step)})
        ambiguity = analysis.get("ambiguity") if isinstance(analysis.get("ambiguity"), dict) else {}
        is_ambiguous = bool(ambiguity.get("is_ambiguous"))
        missing = [str(item) for item in (analysis.get("missing") or []) if str(item).strip()]
        actionable = _prompt_is_actionable(analysis, text)
        needs_choice = is_ambiguous or not actionable

        if needs_choice:
            question = str(ambiguity.get("question") or "").strip()[:200]
            if not question:
                question = (
                    f"这句还差一点信息，我先不猜：「{missing[0][:40]}」"
                    if missing
                    else "这句我有几种画法，你要哪一种？"
                )
            reason = str(ambiguity.get("reason") or "").strip()[:200]
            # 模型的方案在前（默认第一条最推荐），「直接用我的原话」永远排在最后兜底
            analyzed_count = _clamp_count(analysis.get("image_count"), 1)
            options = _normalize_options(ambiguity.get("options"), analyzed_count)
            options = [*options, _verbatim_option(text, image_count=analyzed_count)]
            step = trace.finish(
                "ambiguity",
                status="blocked",
                detail=reason or "原话还不够明确，先停下来问你",
                items=([f"还缺：{item}" for item in missing[:3]] or [])
                + [f"候选方向：{len(options) - 1} 个", "未生成图片，也未扣生图额度"],
            )
            yield _sse({"event": "step", "step": dict(step)})
            run = SkillRun(
                id=new_id(),
                user_id=user.id,
                session_id=session.id,
                canvas_id=canvas_id or session.canvas_id,
                message_id=user_message.id,
                skill_id=SKILL_COMPOSE,
                status="clarify",
                image_count=1,
                confidence=int(round(100 - len(missing) * 12)) if missing else 60,
                input={"content": text, "image_refs": [asset.id for asset in assets]},
                plan={"image_refs": [asset.id for asset in assets], "size": "1024x1024"},
                steps=list(trace.steps),
                options=options,
                task_ids=[],
            )
            db.add(run)
            await db.flush()
            # 回复正文：先把「理解到什么 / 差什么 / 可以往哪走」说成人话，再落卡片
            reply_sink: list[str] = []
            async for chunk in _stream_reply(
                db,
                target,
                mode="clarify",
                facts={
                    "user_text": text,
                    "summary": analysis.get("summary") or "",
                    "missing": missing[:4],
                    "question": question,
                    "reason": reason,
                    "has_reference_images": bool(assets),
                    "options": [
                        {"label": item.get("label"), "description": item.get("description")}
                        for item in options
                        if item.get("id") != VERBATIM_OPTION_ID
                    ],
                },
                fallback=question,
                sink=reply_sink,
            ):
                yield chunk
            # 消息正文 = 完整回复；附件里的 reply 仍是那句短问题，给决策卡做标题
            message = await _append_message(
                db, session.id, user.id, "assistant", reply_sink[0],
                attachments=[_compose_attachment(run, question, status="clarify")],
            )
            run.input = {**(run.input or {}), "result_message_id": message.id}
            await db.commit()
            yield _sse(
                {
                    "event": "result",
                    "result": _compose_result(
                        run, message, user_message.id, reply=question, status="clarify"
                    ),
                }
            )
            return

        step = trace.finish(
            "ambiguity",
            detail="原话已经足够明确：按原文使用，不做任何改写",
            items=[f"已确认：{analysis.get('subject')}"] if analysis.get("subject") else [],
        )
        yield _sse({"event": "step", "step": dict(step)})

        # ---- 3) 已分析需求的执行方案 ----
        step = trace.start("reason", STEPS[2][1], "确认画幅与技能骨架")
        yield _sse({"event": "step", "step": dict(step)})

        # **原话直用**：不调模型做提示词改写，也不做模板兜底。
        prompt_source = "verbatim"
        plan_data = {
            "final_prompt": text.strip()[:_MAX_PROMPT],
            "negative": "",
            "size": "1024x1024",
            "title": "按你的原话生成",
            "reasoning": [
                "原话已足够明确，不加字也不减字",
                "想换个说法：用输入框右侧的「润色」，或直接在澄清卡里选一个方向",
            ],
        }
        step = trace.finish(
            "reason",
            status="skipped",
            detail="原话直用：不调用模型改写提示词",
            items=plan_data["reasoning"],
        )
        yield _sse({"event": "step", "step": dict(step)})
        # 分析确认可执行的原话归一为 ComposePlan，补齐画幅等执行字段。
        # 用户提示词保留；不以本地模板替代前置模型分析。
        plan_data = plan_validator.normalize_plan(
            plan_data, shortlisted, prompt_source=prompt_source
        )
        final_prompt = str(plan_data.get("final_prompt") or "").strip()
        negative = str(plan_data.get("negative") or "").strip()
        # size 是 aspect 的派生字段（C1）：只从 aspect 推，避免两个字段各说一套
        size = plan_validator.aspect_to_size(plan_data.get("aspect"))
        skill_id = str(plan_data.get("skill_id") or "").strip()
        prompt_source = str(plan_data.get("prompt_source") or prompt_source)

        step = trace.start("prompt", STEPS[3][1], "确认最终交给图像模型的提示词")
        yield _sse({"event": "step", "step": dict(step)})

        # 提示词为空/过短是硬错误：**不许拿用户原话顶替**（那会让"帮我弄好看点"被原样
        # 送去画图），也不许扣额度。如实失败，让用户重试。
        if len(final_prompt) < 8:
            reason_text = (
                "这句还是太短了，补一点主体、场景或风格再试"
                if prompt_source == "verbatim"
                else "模型这次没有给出可用的提示词，重试一次或换一个模型"
            )
            step = trace.finish("prompt", status="failed", detail=reason_text)
            yield _sse({"event": "step", "step": dict(step)})
            run = SkillRun(
                id=new_id(),
                user_id=user.id,
                session_id=session.id,
                canvas_id=canvas_id or session.canvas_id,
                message_id=user_message.id,
                skill_id=SKILL_COMPOSE,
                status="failed",
                image_count=1,
                confidence=_confidence(analysis.get("confidence")),
                input={"content": text, "image_refs": [asset.id for asset in assets]},
                plan={"prompt_source": "none", "image_refs": [asset.id for asset in assets]},
                steps=list(trace.steps),
                options=[],
                task_ids=[],
            )
            db.add(run)
            await db.flush()
            message = await _append_message(
                db, session.id, user.id, "assistant", reason_text,
                attachments=[_compose_attachment(run, reason_text, status="failed")],
            )
            run.input = {**(run.input or {}), "result_message_id": message.id}
            await db.commit()
            yield _sse(
                {
                    "event": "result",
                    "result": _compose_result(
                        run, message, user_message.id, reply=reason_text, status="failed"
                    ),
                }
            )
            return

        step = trace.finish(
            "prompt",
            detail=final_prompt,
            items=["提示词：按用户原话，未套用技能模板"]
            + ([f"必须避免：{negative}"] if negative else [])
            + [f"画幅：{size}"],
        )
        yield _sse({"event": "step", "step": dict(step)})

        # ---- 5) 张数判定与并发调度 ----
        step = trace.start("schedule", STEPS[5][1], "按分析结果确定张数，为每张分配独立通道")
        yield _sse({"event": "step", "step": dict(step)})
        jobs = resolve_jobs(analysis, final_prompt)
        count_reason = str(analysis.get("count_reason") or "").strip()[:80]
        jobs, schedule_items = await _schedule_jobs(db, user.id, jobs, count_reason)
        step = trace.finish(
            "schedule",
            detail=f"并发提交 {len(jobs)} 个独立任务" if len(jobs) > 1 else "单张生成，占用 1 个账号通道",
            items=schedule_items,
        )
        yield _sse({"event": "step", "step": dict(step)})

        # ---- 6) 提交生图 ----
        step = trace.start("dispatch", STEPS[4][1])
        yield _sse({"event": "step", "step": dict(step)})
        run = SkillRun(
            id=new_id(),
            user_id=user.id,
            session_id=session.id,
            canvas_id=canvas_id or session.canvas_id,
            message_id=user_message.id,
            skill_id=SKILL_COMPOSE,
            status="dispatching",
            image_count=len(jobs),
            confidence=_confidence(analysis.get("confidence")),
            input={"content": text, "image_refs": [asset.id for asset in assets]},
            plan={
                "final_prompt": final_prompt,
                "image_count": len(jobs),
                "jobs": [{k: job[k] for k in ("index", "label", "custom")} for job in jobs],
                "negative": negative,
                "size": size,
                # R04 新增的三个契约字段（size 保留，向后兼容）
                "aspect": plan_data.get("aspect"),
                "schema_version": plan_data.get("schema_version", PLAN_SCHEMA_VERSION),
                "prompt_truncated": bool(plan_data.get("prompt_truncated")),
                "title": plan_data.get("title") or "",
                "subject": plan_data.get("subject") or "",
                "style_tags": list(plan_data.get("style_tags") or []),
                "reasoning": list(plan_data.get("reasoning") or []),
                "source": plan_data.get("source") or "relay",
                "skill_id": skill_id,
                "image_refs": [asset.id for asset in assets],
                "prompt_source": prompt_source,
                "analysis": {k: analysis.get(k) for k in ("summary", "intent", "subject", "style", "constraints", "missing")},
            },
            steps=list(trace.steps),
            options=[],
            task_ids=[],
        )
        db.add(run)
        await db.flush()

        # 最终提示词只在这里拼装一次：`negative` 折进尾部（上游没有独立负向参数），
        # R06 的「尾部含负向段」校验对象就是这段拼装后的文本
        assembled_prompt = plan_validator.assemble_dispatch_prompt(final_prompt, negative)

        try:
            plan_validator.assert_dispatchable(plan_data, assembled_prompt)
            tasks = await _dispatch(
                db,
                user,
                run,
                final_prompt=final_prompt,
                negative=negative,
                size=size,
                refs=[asset.id for asset in assets],
                # 双击 / 重发同一句需求时，60 秒内复用同一个幂等键；
                # 用 run.id 会让「每次都是新 run」，幂等形同虚设。
                idempotency_key=_dedupe_key(session.id, text, [asset.id for asset in assets]),
                model=model,
                jobs=jobs,
                keep=(session, user_message),
            )
        except AppError as exc:
            logger.warning("提交生图失败 run=%s: %s", run.id, exc.message)
            run.status = "failed"
            step = trace.finish("dispatch", status="failed", detail=exc.message)
            yield _sse({"event": "step", "step": dict(step)})
            run.steps = list(trace.steps)
            run.updated_at = utcnow()
            reply_sink = []
            async for chunk in _stream_reply(
                db,
                target,
                mode="failed",
                facts={"user_text": text, "reason": exc.message},
                fallback=exc.message,
                sink=reply_sink,
            ):
                yield chunk
            message = await _append_message(
                db, session.id, user.id, "assistant", reply_sink[0],
                attachments=[_compose_attachment(run, exc.message, status="failed")],
            )
            run.input = {**(run.input or {}), "result_message_id": message.id}
            await db.commit()
            yield _sse(
                {
                    "event": "result",
                    "result": _compose_result(
                        run, message, user_message.id, reply=exc.message, status="failed", error_code=exc.code.value
                    ),
                }
            )
            return

        run.status = "completed"
        run.task_ids = [item["id"] for item in tasks]
        dispatch_items = [
            f"任务 {item.get('index', i + 1)}"
            + (f"「{item['label']}」" if item.get("label") else "")
            + f" · #{str(item['id'])[:8]}"
            + (" · 复用刚提交的任务" if item.get("deduped") else " · 已进入生成队列")
            for i, item in enumerate(tasks)
        ]
        step = trace.finish(
            "dispatch",
            detail=f"已并发提交 {len(tasks)} 个生图任务" if len(tasks) > 1 else "已提交 1 个生图任务",
            items=dispatch_items,
        )
        yield _sse({"event": "step", "step": dict(step)})
        run.steps = list(trace.steps)
        run.updated_at = utcnow()

        # 面向用户的一句话：说清「画什么、几张、多久、去哪看」，不复述提示词
        title = str(plan_data.get("title") or "").strip()[:40]
        fallback_reply = (
            f"好的，开始画「{title}」"
            if title
            else "好的，按你的描述开始画"
        ) + f"，共 {len(tasks)} 张，大约 30–60 秒，结果会直接出现在下面。"
        # 任务已经在跑了：这时再写回复正文，不会拖慢出图
        reply_sink = []
        async for chunk in _stream_reply(
            db,
            target,
            mode="direct",
            facts={
                "user_text": text,
                "title": title,
                "subject": plan_data.get("subject") or analysis.get("subject") or "",
                "style_tags": list(plan_data.get("style_tags") or [])[:5],
                "aspect": plan_data.get("aspect") or "",
                "size": size,
                "decisions": [str(item) for item in (plan_data.get("reasoning") or [])][:4],
                "image_count": len(tasks),
                "has_reference_images": bool(assets),
            },
            fallback=fallback_reply,
            sink=reply_sink,
        ):
            yield chunk
        reply = reply_sink[0]
        message = await _append_message(
            db, session.id, user.id, "assistant", reply,
            attachments=[_compose_attachment(run, reply, status="completed", tasks=tasks)],
        )
        run.input = {**(run.input or {}), "result_message_id": message.id}
        await db.commit()
        yield _sse(
            {
                "event": "result",
                "result": {
                    **_compose_result(run, message, user_message.id, reply=reply, status="direct"),
                    "tasks": tasks,
                    "relay": {
                        "configured": target is not None,
                        "source": target.source if target else "local",
                        "provider": target.name if target else "本地模板",
                        "model": (target.model if target else "本地模板"),
                    },
                },
            }
        )


# --------------------------------------------------------------------------- #
# 结果 / 附件 / 提交
# --------------------------------------------------------------------------- #
def _compose_attachment(
    run: SkillRun,
    reply: str,
    *,
    status: str,
    tasks: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """assistant 消息上的 compose_run 快照（刷新后据此还原思考链路）。"""
    plan = run.plan or {}
    size = plan.get("size") or "1024x1024"
    return {
        "type": "compose_run",
        "run_id": run.id,
        "status": status,
        "reply": reply,
        # 原话随附件落库：未配置时用户点「用本地模板先试一次」要能原样重发
        "content": str((run.input or {}).get("content") or ""),
        "steps": list(run.steps or []),
        "final_prompt": plan.get("final_prompt") or "",
        "negative": plan.get("negative") or "",
        "size": size,
        # R04：新增三个契约字段（size 保留，向后兼容）
        "aspect": plan.get("aspect") or plan_validator.aspect_from_size(size),
        "schema_version": int(plan.get("schema_version") or PLAN_SCHEMA_VERSION),
        "prompt_truncated": bool(plan.get("prompt_truncated")),
        "skill_id": plan.get("skill_id") or "",
        "style_tags": list(plan.get("style_tags") or []),
        "source": plan.get("source") or "relay",
        "prompt_source": plan.get("prompt_source") or "relay",
        # 模板兜底（R05）与「用户显式选的本地模板」都算降级，前端都要提示
        "degraded": plan.get("prompt_source") in {"template", "template_fallback"},
        "options": list(run.options or []),
        "tasks": tasks or [],
        "task_ids": list(run.task_ids or []),
    }


def _compose_result(
    run: SkillRun,
    message: ChatMessage,
    user_message_id: str,
    *,
    reply: str,
    status: str,
    error_code: str | None = None,
) -> dict[str, Any]:
    """SSE result 与消息附件共用同一套字段，避免前后端两套结构。"""
    plan = run.plan or {}
    size = plan.get("size") or "1024x1024"
    return {
        "run_id": run.id,
        "message_id": message.id,
        "user_message_id": user_message_id,
        "status": status,
        "error_code": error_code,
        "reply": reply,
        "steps": list(run.steps or []),
        "options": list(run.options or []),
        "tasks": [],
        "final_prompt": plan.get("final_prompt") or "",
        "negative": plan.get("negative") or "",
        "size": size,
        # R04：新增三个契约字段（size 保留，向后兼容）
        "aspect": plan.get("aspect") or plan_validator.aspect_from_size(size),
        "schema_version": int(plan.get("schema_version") or PLAN_SCHEMA_VERSION),
        "prompt_truncated": bool(plan.get("prompt_truncated")),
        "skill_id": plan.get("skill_id") or "",
        "style_tags": list(plan.get("style_tags") or []),
        "source": plan.get("source") or "relay",
        "prompt_source": plan.get("prompt_source") or "relay",
        "degraded": plan.get("prompt_source") in {"template", "template_fallback"},
        "image_refs": plan.get("image_refs") or [],
    }


def _fallback_prompt(text: str, skills: list[design_skills.DesignSkill]) -> str:
    """模型没给出可用提示词时的**显式**兜底（会标记 prompt_source=template）。"""
    skill = skills[0] if skills else None
    base = text.strip()
    if skill:
        return f"{base}。{skill.prompt_scaffold}".replace("{主体}", base)[:_MAX_PROMPT]
    return f"{base}。画面主体清晰，构图完整，光线自然，细节锐利，高清质感。"[:_MAX_PROMPT]


def _template_plan(text: str, skills: list[design_skills.DesignSkill]) -> dict[str, Any]:
    """本地模板模式（用户显式选择、或未接中转站时）。"""
    skill = skills[0] if skills else None
    prompt = _fallback_prompt(text, skills)
    return {
        "title": "本地模板生成",
        "reasoning": ["未接中转站：不推断风格，直接套用技能骨架"],
        "final_prompt": prompt,
        "negative": skill.negative if skill else "",
        "size": "1024x1024",
        "skill_id": skill.id if skill else "",
        "skill_name": skill.name if skill else "",
    }


def _dedupe_key(session_id: str, content: str, refs: list[str]) -> str:
    """60 秒窗口内的幂等键：挡住双击与网络重试，又不影响用户过一会儿再生成一版。

    已知边界：跨分钟边界（12:00:59 与 12:01:01）会被算成两个窗口，
    同一句需求仍可能建两个任务。要彻底消除需要一张「请求指纹表」，
    对当前「防手抖双击」的目标来说不值得，这里刻意保留简单实现。
    """
    digest = hashlib.sha1(
        f"{session_id}|{content.strip()}|{','.join(refs)}".encode("utf-8")
    ).hexdigest()[:16]
    bucket = int(time.time() // 60)
    return f"compose:{digest}:{bucket}"


async def _dispatch(
    db: AsyncSession,
    user: User,
    run: SkillRun,
    *,
    final_prompt: str,
    negative: str,
    size: str,
    refs: list[str],
    idempotency_key: str,
    model: str | None = None,
    jobs: list[dict[str, Any]] | None = None,
    keep: tuple[Any, ...] = (),
) -> list[dict[str, Any]]:
    """按分析结果建 N 个**独立**任务并并发执行。

    - 有参考图 → 图生图（以第一张为底图）；没有 → 文生图；
    - 每张一个任务（n=1）：每个任务各自走一次网关，网关按「最少占用」为每次调用
      原子预留独立账号，容量不足明确失败，不复用同一账号；
    - `negative` 折进提示词尾部（上游 gpt-image 系列没有独立负向参数）；
    - 任一创建失败则回退整批预扣，所有任务建好以后才开始执行。

    拼装走 `plan_validator.assemble_dispatch_prompt()`（唯一来源），与
    `assert_dispatchable()` 校验的是同一段文本，避免「校验的和派发的不是一份」。
    """
    jobs = jobs or [{"index": 1, "label": "", "prompt": final_prompt, "custom": False}]
    batch = len(jobs) > 1
    from app.services import batch_service
    unit_cost = await generate_service.resolve_cost(db, "edit" if refs else "generate")
    await batch_service.preflight(db, user.id, len(jobs), unit_cost * len(jobs))
    base_asset = await asset_service.get_asset(db, user, refs[0]) if refs else None
    base_url = base_asset.url if base_asset else None
    # 先把 run 落盘：pre_deduct 余额不足会 rollback 整个会话，不能把 run 一起卷走
    await db.commit()

    payload: list[dict[str, Any]] = []
    first_error: AppError | None = None
    for job in jobs:
        prompt = plan_validator.assemble_dispatch_prompt(str(job["prompt"]), negative)
        key = f"{idempotency_key}:{job['index']}" if batch else idempotency_key
        extra: dict[str, Any] = {"compose_run_id": run.id, "negative": negative, "pool_batch_id": run.id, "pool_task_id": str(job["index"]), "pool_batch_total": len(jobs)}
        if batch:
            extra.update({"batch_index": job["index"], "batch_total": len(jobs), "batch_label": job["label"]})
        try:
            if base_url:
                task, is_new = await generate_service.create_edit_task(
                    db,
                    user.id,
                    prompt=prompt,
                    model=model or "gpt-image-2",
                    size=size,
                    base_image_url=base_url,
                    session_id=run.session_id,
                    canvas_id=run.canvas_id,
                    idempotency_key=key,
                    extra={**extra, "n": 1},
                )
            else:
                task, is_new = await generate_service.create_image_task(
                    db,
                    user.id,
                    prompt=prompt,
                    model=model or "gpt-image-2",
                    size=size,
                    quality="standard",
                    n=1,
                    session_id=run.session_id,
                    canvas_id=run.canvas_id,
                    idempotency_key=key,
                    extra=extra,
                )
            await db.commit()
        except AppError as exc:
            # pre_deduct 失败时会话已 rollback：把调用方还要用的对象重新载入
            for obj in (run, *keep):
                try:
                    await db.refresh(obj)
                except Exception:  # noqa: BLE001 - 对象未落库（极少见）时忽略
                    pass
            first_error = first_error or exc
            logger.warning("第 %s 张提交失败 run=%s: %s", job["index"], run.id, exc.message)
            break
        payload.append(
            {
                "id": task.id,
                "type": task.type,
                "status": task.status,
                "prompt": task.prompt,
                "cost": task.cost,
                "image_count": 1,
                "index": job["index"],
                "label": job["label"],
                # 幂等命中：复用了刚建过的任务，这次并没有真正重跑
                "deduped": not is_new,
                "_new": is_new,
            }
        )

    if first_error:
        from app.services import task_service
        for item in payload:
            if item["_new"]:
                refunded = await task_service.fail_and_refund(db, item["id"], first_error.code.value, "本批次未能完整提交，额度已退回")
                if refunded is not None and refunded.status == "failed":
                    # 退款任务未曾启动；释放原键，让同一方案重试能完整重建批次。
                    refunded.idempotency_key = f"refunded:{refunded.id}"
                    await db.commit()
        raise first_error
    if not payload:
        raise AppError(ErrorCode.UPSTREAM_ERROR, "没能提交生图任务")
    # 全部建好后一起起跑：N 个任务同时进网关，才是真正的并发
    for item in payload:
        if item.pop("_new"):
            _spawn_run(item["id"])
    return payload


_BACKGROUND: set[asyncio.Task[None]] = set()


def _spawn_run(task_id: str) -> None:
    """后台执行生成任务（SSE 生成器里拿不到 BackgroundTasks）。"""
    task = asyncio.create_task(generate_service.run_task(task_id))
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


async def confirm_compose(
    db: AsyncSession, user: User, run_id: str, option_id: str
) -> dict[str, Any]:
    """用户选定澄清方案后执行：用该方案自带的提示词建任务。"""
    run = (await db.execute(select(SkillRun).where(SkillRun.id == run_id))).scalar_one_or_none()
    if run is None:
        raise AppError(ErrorCode.NOT_FOUND, "这次分析已经失效，重新说一次需求就好")
    if run.user_id != user.id:
        raise AppError(ErrorCode.FORBIDDEN, "无权操作该记录")
    if run.skill_id != SKILL_COMPOSE:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这条记录不是生图需求，请从对应入口操作")
    if run.status == "completed" and run.task_ids:
        return {"run_id": run.id, "status": run.status, "task_ids": run.task_ids, "tasks": []}
    if run.status == "dispatching":
        raise AppError(ErrorCode.TASK_STATE_CONFLICT, "这份计划正在提交，请稍后查看")
    if run.status != "clarify":
        # voided（被新需求作废）/ failed / dispatching 都不允许再确认
        raise AppError(
            ErrorCode.VALIDATION_ERROR, "这次分析已经失效，重新说一次需求就好"
        )

    chosen = next((item for item in (run.options or []) if item.get("id") == option_id), None)
    if chosen is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个方案已经失效，重新说一次需求就好")

    final_prompt = str(chosen.get("prompt") or "").strip()
    if len(final_prompt) < 8:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个方案缺少提示词，重新说一次需求就好")

    plan = {**(run.plan or {})}
    plan["chosen_option_id"] = option_id
    # 选中的是「直接用我的原话」时如实标记，前端据此显示「按你写的这句生成」
    prompt_source = "verbatim" if option_id == VERBATIM_OPTION_ID else "relay"
    # 澄清路径同样要过契约归一（R04）与派发前硬约束（R06），否则「点选方案」会成为
    # 绕过校验的后门。技能初筛结果没有随 run 落库，用 plan 里已有的 skill_id 反查。
    plan = plan_validator.normalize_plan(
        {
            **plan,
            "final_prompt": final_prompt,
            "aspect": chosen.get("aspect") or plan.get("aspect"),
            "title": chosen.get("label") or plan.get("title"),
        },
        [],
        prompt_source=prompt_source,
    )
    plan["chosen_option_id"] = option_id
    plan["size"] = plan_validator.aspect_to_size(plan.get("aspect"))
    refs = [str(item) for item in (plan.get("image_refs") or []) if str(item)]

    assembled_prompt = plan_validator.assemble_dispatch_prompt(
        str(plan.get("final_prompt") or ""), str(plan.get("negative") or "")
    )
    plan_validator.assert_dispatchable(plan, assembled_prompt)

    # 张数：选中的方向自带的 image_count（澄清时已按分析结果写入），同一提示词出 N 版
    jobs = resolve_jobs(
        {"image_count": chosen.get("image_count") or 1}, str(plan.get("final_prompt") or "")
    )
    jobs, _ = await _schedule_jobs(db, user.id, jobs, "")
    plan["image_count"] = len(jobs)
    claim = await db.execute(
        update(SkillRun)
        .where(SkillRun.id == run.id, SkillRun.status == "clarify")
        .values(status="dispatching", updated_at=utcnow())
    )
    if claim.rowcount != 1:
        raise AppError(ErrorCode.TASK_STATE_CONFLICT, "这份计划正在提交或已失效，请刷新查看")
    run.plan = plan
    run.image_count = len(jobs)
    await db.commit()
    try:
        tasks = await _dispatch(
            db,
            user,
            run,
            final_prompt=str(plan.get("final_prompt") or ""),
            negative=str(plan.get("negative") or ""),
            size=plan["size"],
            refs=refs,
            # 幂等键必须随方案变化：同一 run 选不同方案是不同的产出
            idempotency_key=f"compose:{run.id}:{option_id}",
            jobs=jobs,
        )
    except AppError:
        # _dispatch 会先把 run 落盘：一张都没提交成功时退回 clarify，用户还能再点一次
        run.status = "clarify"
        run.updated_at = utcnow()
        await db.commit()
        raise
    run.status = "completed"
    run.task_ids = [item["id"] for item in tasks]
    await _sync_attachment(db, run, option_id)
    await db.commit()
    return {"run_id": run.id, "status": run.status, "task_ids": run.task_ids, "tasks": tasks}


async def _sync_attachment(db: AsyncSession, run: SkillRun, option_id: str) -> None:
    """把「已选择」回写到那条 assistant 消息的 compose_run 附件。"""
    message_id = str((run.input or {}).get("result_message_id") or "").strip()
    if not message_id:
        return
    message = (
        await db.execute(select(ChatMessage).where(ChatMessage.id == message_id))
    ).scalar_one_or_none()
    if message is None:
        return
    attachments = list(message.attachments or [])
    touched = False
    for index, item in enumerate(attachments):
        if not isinstance(item, dict) or item.get("type") != "compose_run":
            continue
        if str(item.get("run_id") or "") != run.id:
            continue
        attachments[index] = {
            **item,
            "status": "completed",
            "chosen_option_id": option_id,
            "task_ids": list(run.task_ids or []),
            "final_prompt": (run.plan or {}).get("final_prompt") or item.get("final_prompt"),
        }
        touched = True
    if touched:
        message.attachments = attachments


async def _append_message(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    role: str,
    content: str,
    attachments: list[Any] | None = None,
) -> ChatMessage:
    message = ChatMessage(
        id=new_id(),
        session_id=session_id,
        user_id=user_id,
        role=role,
        content=content,
        attachments=attachments or [],
    )
    db.add(message)
    await db.flush()
    return message
