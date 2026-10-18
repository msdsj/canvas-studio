"""纯生图全链路编排：需求分析 → 歧义澄清 → 方案推导 → 最终提示词 → 提交生图。

和 `skills.stream_analysis` 的分工
----------------------------------
- `skills.stream_analysis`：**画布框选编辑**（有 regions），要按区域拆指令、判定 1/2 张；
- 本模块：**从零生成 / 带参考图生成**（侧边栏的主链路），核心是「先想清楚再花钱」。

三条铁律
--------
1. **歧义必须停**：需求不明确时只出方案、不建任务、不扣生图额度；
2. **提示词必须是模型产出的**：建任务用 `final_prompt`，绝不用用户原话顶替
   （用户原话只作为模型输入）。模型返回不可用时如实失败，不静默降级；
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
)
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
)


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


def _extract_json(text: str) -> dict[str, Any] | None:
    """从模型回复里稳健抽取 JSON（容忍围栏、前后说明）。"""
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


class _Trace:
    """步骤轨迹：支持 items（推理要点）与 detail（一句话结论）。"""

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
    ) -> dict[str, Any]:
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


def _normalize_options(raw: Any) -> list[dict[str, Any]]:
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
            "image_count": 1,
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


def _verbatim_option(text: str, size: str = "1024x1024") -> dict[str, Any]:
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
        "image_count": 1,
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
    """把参考图 / 选区写成人话喂给模型（不传像素，只传事实）。"""
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


def _skill_block(text: str) -> tuple[str, list[design_skills.DesignSkill]]:
    """技能清单：初筛命中给完整骨架，未命中给全量目录。"""
    hits = shortlist_skills(text)
    if hits:
        detail = "\n\n".join(design_skills.render_detail(skill.id) for skill in hits)
        return f"## 可能适用的设计技能（初筛）\n\n{detail}", hits
    return (
        "## 设计技能目录（没有明显命中，按需参考）\n\n"
        + "\n".join(f"- {skill.id}｜{skill.name}｜{skill.description}" for skill in design_skills.SKILLS[:20]),
        [],
    )


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
    allow_degraded: bool = False,
    model: str | None = None,
) -> AsyncIterator[str]:
    """SSE：把全链路思考实时吐给前端，最后给出结论（澄清 / 已提交 / 未配置）。"""
    trace = _Trace()
    text = (content or "").strip()
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
            db, session.id, user.id, "user", text, attachments=attachments
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
        if target is None and not allow_degraded:
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
                "还没有配置 AI 中转站，我先停在这里。填好地址、Key 和模型后，这句需求我就能直接分析并出图。",
                attachments=[
                    {
                        "type": "compose_run",
                        "run_id": "",
                        "status": "unconfigured",
                        "reply": "还没有配置 AI 中转站，我先停在这里。",
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
        skill_block, shortlisted = _skill_block(text)
        user_prompt = (
            f"用户原话：{text}\n\n"
            f"{_describe_context(assets, selection)}\n\n"
            f"{skill_block}\n\n"
            "请按系统要求输出 JSON。"
        )

        if target is None:
            # 用户显式选择「本地模板先试一次」：不调模型，步骤如实标注
            analysis: dict[str, Any] = {
                "summary": text[:60],
                "intent": "img2img" if assets else "text2img",
                "subject": "",
                "style": "",
                "constraints": [],
                "missing": [],
                "thinking": ["未接中转站：按用户原话 + 本地技能模板拼装提示词", "不做语义推断，避免替你决定画面"],
                "ambiguity": {"is_ambiguous": False, "reason": "本地模式不判定歧义", "question": "", "options": []},
                "_meta": {"model": "本地模板", "provider": "本地模板", "source": "local"},
            }
            step = trace.finish(
                "analyze",
                status="skipped",
                detail="本地模板模式（未接中转站，不做语义分析）",
                items=analysis["thinking"],
            )
            yield _sse({"event": "step", "step": dict(step)})
        else:
            try:
                analysis, _outcome, _repairs = await _call_json(
                    db,
                    user.id,
                    [
                        {"role": "system", "content": template},
                        {"role": "user", "content": user_prompt},
                    ],
                    target=target,
                    stage="analyze",
                )
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
            step = trace.finish(
                "analyze",
                detail=str(analysis.get("summary") or "已读懂需求")[:160],
                items=thinking,
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
        # 本地模板模式是用户显式确认过的降级（"先试一次"），此时不再用模型口径拦他
        local_mode = target is None
        actionable = _prompt_is_actionable(analysis, text)
        needs_choice = is_ambiguous or (not actionable and not local_mode)

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
            options = _normalize_options(ambiguity.get("options"))
            options = [*options, _verbatim_option(text)]
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
            message = await _append_message(
                db, session.id, user.id, "assistant", question,
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

        # ---- 3) 方案：原话直用 / 本地兜底 ----
        step = trace.start("reason", STEPS[2][1], "确认画幅与技能骨架")
        yield _sse({"event": "step", "step": dict(step)})

        if local_mode:
            # 用户已确认的本地兜底：模板拼提示词（唯一一条会"改写"的路径，且是显式确认的）
            prompt_source = "template"
            plan_data = _template_plan(text, shortlisted)
            step = trace.finish(
                "reason",
                status="skipped",
                detail="本地模板：直接套用技能骨架，不做推导",
                items=[f"套用技能：{plan_data.get('skill_name') or '通用'}"],
            )
            yield _sse({"event": "step", "step": dict(step)})
        else:
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
        # 契约归一：无论 verbatim 还是本地模板，都收敛成 ComposePlan 形状（R04）。
        # - verbatim：用户原话直用（长度上限走派发兜底 3800，不受契约 800 约束，C2）
        # - template：按技能骨架拼装，并补齐 aspect / negative / style_tags（R06）
        # 归一后仍不合法会**自动退到模板兜底**，不阻塞建任务（R05）
        plan_data = plan_validator.normalize_plan(
            plan_data, shortlisted, prompt_source=prompt_source
        )
        final_prompt = str(plan_data.get("final_prompt") or "").strip()
        negative = str(plan_data.get("negative") or "").strip()
        # size 是 aspect 的派生字段（C1）：只从 aspect 推，避免两个字段各说一套
        size = plan_validator.aspect_to_size(plan_data.get("aspect"))
        skill_id = str(plan_data.get("skill_id") or "").strip()
        skill = design_skills.get_skill(skill_id)
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
            items=[f"技能：{skill.name}" if skill else "技能：通用设计原则"]
            + ([f"必须避免：{negative}"] if negative else [])
            + [f"画幅：{size}"],
        )
        yield _sse({"event": "step", "step": dict(step)})

        # ---- 5) 提交生图 ----
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
            image_count=1,
            confidence=_confidence(analysis.get("confidence")),
            input={"content": text, "image_refs": [asset.id for asset in assets]},
            plan={
                "final_prompt": final_prompt,
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
            )
        except AppError as exc:
            logger.warning("提交生图失败 run=%s: %s", run.id, exc.message)
            run.status = "failed"
            step = trace.finish("dispatch", status="failed", detail=exc.message)
            yield _sse({"event": "step", "step": dict(step)})
            run.steps = list(trace.steps)
            run.updated_at = utcnow()
            message = await _append_message(
                db, session.id, user.id, "assistant", exc.message,
                attachments=[_compose_attachment(run, exc.message, status="failed")],
            )
            run.input = {**(run.input or {}), "result_message_id": message.id}
            await db.commit()
            yield _sse(
                {
                    "event": "result",
                    "result": _compose_result(
                        run, message, user_message.id, reply=exc.message, status="failed"
                    ),
                }
            )
            return

        run.status = "completed"
        run.task_ids = [item["id"] for item in tasks]
        step = trace.finish("dispatch", detail=f"已提交 {len(tasks)} 个生图任务")
        yield _sse({"event": "step", "step": dict(step)})
        run.steps = list(trace.steps)
        run.updated_at = utcnow()

        reply = f"已开始生成：{str(plan_data.get('title') or '按你的需求')[:40]}。"
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
) -> dict[str, Any]:
    """SSE result 与消息附件共用同一套字段，避免前后端两套结构。"""
    plan = run.plan or {}
    size = plan.get("size") or "1024x1024"
    return {
        "run_id": run.id,
        "message_id": message.id,
        "user_message_id": user_message_id,
        "status": status,
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
) -> list[dict[str, Any]]:
    """按最终提示词建任务。

    - 有参考图 → 图生图（以第一张为底图）；
    - 没有参考图 → 文生图；
    - `negative` 折进提示词尾部（上游 gpt-image 系列没有独立负向参数）。

    拼装走 `plan_validator.assemble_dispatch_prompt()`（唯一来源），与
    `assert_dispatchable()` 校验的是同一段文本，避免「校验的和派发的不是一份」。
    """
    prompt = plan_validator.assemble_dispatch_prompt(final_prompt, negative)

    created: list[Any] = []
    if refs:
        asset = await asset_service.get_asset(db, user, refs[0])
        task, is_new = await generate_service.create_edit_task(
            db,
            user.id,
            prompt=prompt,
            model=model or "gpt-image-2",
            size=size,
            base_image_url=asset.url,
            session_id=run.session_id,
            canvas_id=run.canvas_id,
            idempotency_key=idempotency_key,
            extra={"compose_run_id": run.id, "n": 1, "negative": negative},
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
            idempotency_key=idempotency_key,
            extra={"compose_run_id": run.id, "negative": negative},
        )
    created.append((task, is_new))
    await db.commit()

    payload: list[dict[str, Any]] = []
    for task, is_new in created:
        if is_new:
            _spawn_run(task.id)
        payload.append(
            {
                "id": task.id,
                "type": task.type,
                "status": task.status,
                "prompt": task.prompt,
                "cost": task.cost,
                "image_count": 1,
                # 幂等命中：复用了刚建过的任务，这次并没有真正重跑
                "deduped": not is_new,
            }
        )
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

    run.plan = plan
    run.status = "dispatching"
    run.updated_at = utcnow()
    await db.flush()

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
    )
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
