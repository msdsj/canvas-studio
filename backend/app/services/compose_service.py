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
from app.services import (
    asset_service,
    design_skills,
    generate_service,
    prompt_service,
    relay_service,
)
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.compose_service")

SKILL_COMPOSE = "image_compose"
_ALLOWED_SIZES = {"1024x1024", "1536x1024", "1024x1536"}
_MAX_PROMPT = 3800

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
    """把模型给的方案收敛成前端可渲染的结构；没有 prompt 的方案直接丢弃。"""
    items = raw if isinstance(raw, list) else []
    options: list[dict[str, Any]] = []
    for position, item in enumerate(items[:3], start=1):
        if not isinstance(item, dict):
            continue
        prompt = str(item.get("prompt") or "").strip()
        if len(prompt) < 8:
            continue
        options.append(
            {
                "id": str(item.get("id") or chr(96 + position))[:8],
                "label": str(item.get("label") or f"方案 {position}").strip()[:20],
                "description": str(item.get("description") or "").strip()[:120],
                "prompt": prompt[:_MAX_PROMPT],
                "size": _normalize_size(item.get("size")),
                "image_count": 1,
            }
        )
    return options


async def _call_json(
    db: AsyncSession,
    user_id: str,
    messages: list[dict[str, Any]],
    *,
    temperature: float = 0.4,
    max_tokens: int = 1600,
    target: relay_service.RelayTarget | None = None,
) -> dict[str, Any]:
    """调中转站并要求 JSON；解析失败重试一次，仍失败则如实报错。

    绝不把「模型返回了一段没法解析的文本」当成计划去执行——那等于拿用户的额度
    去跑一个没人确认过的提示词。
    """
    attempts = 0
    last_error: str = ""
    while attempts < 2:
        attempts += 1
        payload = await relay_service.chat(
            db,
            user_id,
            messages
            if attempts == 1
            else [
                *messages,
                {"role": "user", "content": "上一次的回复不是合法 JSON。请只输出一个 JSON 对象，不要任何解释文字。"},
            ],
            json_mode=True,
            temperature=temperature,
            max_tokens=max_tokens,
            target=target,
        )
        parsed = _extract_json(payload["content"])
        if parsed is not None:
            return {**parsed, "_meta": payload}
        last_error = payload["content"][:200]
        logger.warning("编排返回非 JSON（第 %s 次）：%s", attempts, last_error)
    raise AppError(
        ErrorCode.UPSTREAM_ERROR,
        "中转站这次返回的格式不对（不是 JSON），重试一次或换一个模型",
    )


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
                analysis = await _call_json(
                    db,
                    user.id,
                    [
                        {"role": "system", "content": template},
                        {"role": "user", "content": user_prompt},
                    ],
                    target=target,
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
                        },
                    }
                )
                return
            thinking = [str(item) for item in (analysis.get("thinking") or []) if str(item).strip()][:5]
            step = trace.finish(
                "analyze",
                detail=str(analysis.get("summary") or "已读懂需求")[:160],
                items=thinking,
            )
            yield _sse({"event": "step", "step": dict(step)})

        # ---- 2) 歧义检查 ----
        step = trace.start("ambiguity", STEPS[1][1], "检查主体、用途、约束是否足以开画")
        yield _sse({"event": "step", "step": dict(step)})
        ambiguity = analysis.get("ambiguity") if isinstance(analysis.get("ambiguity"), dict) else {}
        options = _normalize_options(ambiguity.get("options"))
        is_ambiguous = bool(ambiguity.get("is_ambiguous")) and bool(options)
        missing = [str(item) for item in (analysis.get("missing") or []) if str(item).strip()]

        if is_ambiguous:
            question = str(ambiguity.get("question") or "").strip()[:200] or "这句我有两种理解，你要哪一种？"
            reason = str(ambiguity.get("reason") or "").strip()[:200]
            step = trace.finish(
                "ambiguity",
                status="blocked",
                detail=reason or "需求不够明确，先停下来问你",
                items=([f"还缺：{item}" for item in missing[:3]] or []) + ["未生成图片，也未扣生图额度"],
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
            detail="需求足够明确，可以进入方案推导" if not missing else f"需求基本明确，先按合理默认处理：{missing[0][:40]}",
            items=[f"已确认：{analysis.get('subject') or '主体'}"] if analysis.get("subject") else [],
        )
        yield _sse({"event": "step", "step": dict(step)})

        # ---- 3) 推导方案 + 4) 生成提示词 ----
        step = trace.start("reason", STEPS[2][1], "按技能库的版式与材质参数定构图、光线、色彩")
        yield _sse({"event": "step", "step": dict(step)})

        prompt_source = "template" if target is None else "relay"
        if target is None:
            plan_data = _template_plan(text, shortlisted)
            step = trace.finish(
                "reason",
                status="skipped",
                detail="本地模板：直接套用技能骨架，不做推导",
                items=[f"套用技能：{plan_data.get('skill_name') or '通用'}"],
            )
            yield _sse({"event": "step", "step": dict(step)})
        else:
            prompt_template = await prompt_service.load(db, "compose_prompt")
            # 技能链要能让用户看到「按什么规则选的」：先给出确定性初筛结果（这一步是
            # shortlist_skills 做的，与模型无关），命中与否都必须如实写进步骤文本，
            # 否则前端只能渲染一条没有来源的「已命中技能」。
            if shortlisted:
                shortlist_note = "初筛命中：" + "、".join(
                    f"{skill.name}（{skill.category}）" for skill in shortlisted[:5]
                )
            else:
                shortlist_note = "初筛未命中：按通用设计原则处理"
            skill_for_prompt = (
                "\n\n".join(design_skills.render_detail(skill.id) for skill in shortlisted)
                or "（本次没有命中特定技能，按通用设计原则处理）"
            )
            prompt_user = (
                f"用户原话：{text}\n\n"
                f"需求分析结论：\n{json.dumps({k: analysis.get(k) for k in ('summary', 'intent', 'subject', 'style', 'constraints', 'missing')}, ensure_ascii=False)}\n\n"
                f"{_describe_context(assets, selection)}\n\n"
                f"{shortlist_note}\n\n"
                f"可参考的技能骨架：\n{skill_for_prompt}\n\n"
                f"可选技能 id：{', '.join(skill.id for skill in shortlisted) or '无'}\n\n"
                "请输出 JSON。"
            )
            try:
                plan_data = await _call_json(
                    db,
                    user.id,
                    [
                        {"role": "system", "content": prompt_template},
                        {"role": "user", "content": prompt_user},
                    ],
                    temperature=0.55,
                    max_tokens=1400,
                    target=target,
                )
            except AppError as exc:
                step = trace.finish("reason", status="failed", detail=exc.message)
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
                        },
                    }
                )
                return
            reasoning = [str(item) for item in (plan_data.get("reasoning") or []) if str(item).strip()][:5]
            picked = design_skills.get_skill(str(plan_data.get("skill_id") or "").strip())
            # 初筛结论排在推理要点之前：用户先知道「系统给过它哪几把尺子」，再看它怎么选
            step = trace.finish(
                "reason",
                detail=str(plan_data.get("title") or "方案已定")[:60],
                items=[shortlist_note, *reasoning]
                + ([f"技能命中：{picked.name}（{picked.category}）"] if picked else []),
            )
            yield _sse({"event": "step", "step": dict(step)})

        final_prompt = str(plan_data.get("final_prompt") or "").strip()[:_MAX_PROMPT]
        negative = str(plan_data.get("negative") or "").strip()[:300]
        size = _normalize_size(plan_data.get("size"))
        skill_id = str(plan_data.get("skill_id") or "").strip()
        skill = design_skills.get_skill(skill_id)
        if skill is None:
            skill_id = ""
            skill = shortlisted[0] if shortlisted else None

        step = trace.start("prompt", STEPS[3][1], "把方案写成可直接交给图像模型的一段话")
        yield _sse({"event": "step", "step": dict(step)})

        # 模型没给出可用提示词：**不许拿用户原话顶替**（那正是「帮我弄好看点」被
        # 原样送去画图的根因），也不许扣额度。如实失败，让用户重试。
        if len(final_prompt) < 10:
            reason_text = "模型这次没有给出可用的提示词，重试一次或换一个模型"
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

        try:
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

        reply = f"已开始生成：{str(plan_data.get('title') or '按你的需求')[:40]}。提示词见下方，可复制或重新生成。"
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
        "size": plan.get("size") or "1024x1024",
        "skill_id": plan.get("skill_id") or "",
        "prompt_source": plan.get("prompt_source") or "relay",
        "degraded": plan.get("prompt_source") == "template",
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
        "size": plan.get("size") or "1024x1024",
        "skill_id": plan.get("skill_id") or "",
        "prompt_source": plan.get("prompt_source") or "relay",
        "degraded": plan.get("prompt_source") == "template",
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
    """
    prompt = final_prompt
    if negative:
        prompt = f"{final_prompt}\n\n画面中避免出现：{negative}"

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
    plan["final_prompt"] = final_prompt[:_MAX_PROMPT]
    plan["size"] = _normalize_size(chosen.get("size"), plan.get("size") or "1024x1024")
    plan["chosen_option_id"] = option_id
    plan["prompt_source"] = "relay"
    refs = [str(item) for item in (plan.get("image_refs") or []) if str(item)]

    run.plan = plan
    run.status = "dispatching"
    run.updated_at = utcnow()
    await db.flush()

    tasks = await _dispatch(
        db,
        user,
        run,
        final_prompt=plan["final_prompt"],
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
