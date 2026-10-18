"""Skills 工作流编排：把「需求 → 判定产出数量 → 执行」固化成可审计的状态机。

为什么要有这一层
----------------
用户说「把背景换白，然后把人物抠出来」时，平台必须产出 **2 张图**（改好的整图 +
透明素材）；只说「把背景换白」时只该产出 **1 张**。这个判断如果交给前端或让模型
自由发挥，就会出现「说了两张只给一张」「没说要抠却给了张透明图」这类不可预期行为。

因此这里用「声明式 Skill + 确定性规则 + 模型补充」三段式：

1. **声明式 Skill**：步骤、规则、守卫都写在 ``SKILLS`` 里，可被接口读取、可被审计；
2. **确定性规则**：数量线索、选区结构（整图类 / 素材类）、矛盾检测全部是纯函数，
   不依赖模型，模型挂了也能给出稳定结论；
3. **模型补充**：只用来理解语义、优化提示词、判断「我是否真的不确定」。
   **模型永远不能推翻用户明确说出的数量。**

三条编排铁律（对应产品需求）
--------------------------
- 用户明确说了数量 → 直接按该数量执行，不再追问；
- 系统判断明确 → 直接执行；
- 判断不明确或自相矛盾 → **停下来让用户选**，禁止猜。
"""
from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.chat import ChatSession
from app.models.skill import SkillRun
from app.models.user import User
from app.services import asset_service, config_service, generate_service
from app.services import edit_ops as ops_module
from app.services import prompt_service
from app.services.edit_handlers import (
    OUTPUT_SPRITE,
    EditHandler,
    load_handlers,
    render_catalog,
    resolve_handler,
)
from app.services.gateway_client import gateway_client
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.skills")

SKILL_IMAGE_INTENT = "image_edit_intent"


# --------------------------------------------------------------------------- #
# Skill 声明（可被 GET /api/chat/skills 读取，用于前端展示「编排规则」）
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class SkillStep:
    """一个编排步骤的声明。"""

    id: str
    title: str
    detail: str


@dataclass(frozen=True)
class SkillDef:
    """一个 Skill 的完整声明。"""

    id: str
    name: str
    description: str
    steps: tuple[SkillStep, ...]
    rules: tuple[str, ...] = field(default_factory=tuple)

    def to_public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "steps": [
                {"id": s.id, "title": s.title, "detail": s.detail} for s in self.steps
            ],
            "rules": list(self.rules),
        }


SKILLS: dict[str, SkillDef] = {
    SKILL_IMAGE_INTENT: SkillDef(
        id=SKILL_IMAGE_INTENT,
        name="画布编辑需求分析",
        description="解析用户一句话，判定本次要产出 1 张还是 2 张，并决定是直接执行还是先确认。",
        steps=(
            SkillStep("parse", "读取需求", "读取用户原话与画布选区，归一化坐标"),
            SkillStep("decide", "判定产出", "结合数量线索与选区结构，判定 1 张 / 2 张"),
            SkillStep("route", "编排决策", "直接执行 / 先向用户确认，二选一"),
            SkillStep("compose", "整理指令", "把每个区域改写成可直接执行的提示词"),
            SkillStep("dispatch", "提交生成", "按判定结果创建任务并开始生成"),
        ),
        rules=(
            "用户明确说了数量（如「两张」「只要一张」）→ 按用户说的数量直接执行",
            "系统判断明确（改图 + 抠图 = 2 张；单一场景 = 1 张）→ 直接执行",
            "判断不明确、或用户说的数量与结构判断矛盾 → 停下来让用户选",
            "模型只能补充语义与提示词，不能推翻用户明确说出的数量",
        ),
    ),
}


# --------------------------------------------------------------------------- #
# 确定性规则
# --------------------------------------------------------------------------- #
# 数量线索：排除「2 个区域」这类在说选区的表述
_COUNT_TWO = re.compile(
    r"(?:两|二|2)\s*(?:张|个|幅|版|份)(?!\s*(?:区域|选区|地方|位置|框))|"
    r"\b(?:two|2)\s*(?:images?|pics?|versions?|outputs?)\b",
    re.IGNORECASE,
)
_COUNT_ONE = re.compile(
    r"(?:一|1|单)\s*(?:张|个|幅|版|份)(?!\s*(?:区域|选区|地方|位置|框))|"
    r"\b(?:one|1|single)\s*(?:image|pic|version|output)\b",
    re.IGNORECASE,
)

_CUT_WORDS = ("抠", "去背景", "去掉背景", "去底", "透明背景", "提取出来", "摘出来", "贴纸")
_TRANSPARENT_WORDS = ("挖空", "掏空", "留空", "变透明", "透明化")
_REMOVE_WORDS = ("去掉", "移除", "去除", "抹掉", "消除", "擦除")
_ENHANCE_WORDS = ("变清晰", "更清晰", "提高画质", "画质增强", "修复模糊", "去噪", "高清")
_EDIT_WORDS = (
    "改", "换", "修", "调", "加", "变", "背景", "风格", "颜色", "文字", "光影", "材质",
) + _CUT_WORDS + _TRANSPARENT_WORDS + _REMOVE_WORDS
_GENERATE_WORDS = ("画一", "画个", "画张", "生成", "来一张", "出图", "做一张", "设计一个", "创作")
_AMBIGUOUS_WORDS = ("或者", "还是", "要不要", "不确定", "随便", "都行", "看你", "你定", "都给我")


def detect_explicit_count(text: str) -> int | None:
    """从原话里读出用户明确要求的产出数量；没提返回 None。"""
    if _COUNT_TWO.search(text):
        return 2
    if _COUNT_ONE.search(text):
        return 1
    return None


def detect_handler(text: str, available: set[str]) -> str | None:
    """按关键词推断能力（仅作输入辅助，最终仍以注册表校验）。"""
    value = text or ""
    for handler, words in (
        ("cutout", _CUT_WORDS),
        ("transparent", _TRANSPARENT_WORDS),
        ("remove", _REMOVE_WORDS),
        ("enhance", _ENHANCE_WORDS),
    ):
        if handler in available and any(word in value for word in words):
            return handler
    return None


def _has_any(text: str, words: tuple[str, ...]) -> bool:
    return any(word in text for word in words)


def classify_structure(
    message: str,
    regions: list[dict[str, Any]],
    handlers: dict[str, EditHandler],
    *,
    has_image: bool,
) -> dict[str, Any]:
    """纯函数：按选区结构与文案判断本次的产出构成。

    返回 ``{intent, image_count, composite, sprites, confidence, reason}``，
    其中 ``composite`` 表示是否需要一张「改好的整图」，``sprites`` 是素材区域列表。
    """
    available = set(handlers)
    sprite_regions: list[dict[str, Any]] = []
    composite_regions: list[dict[str, Any]] = []

    for item in regions:
        handler_id = str(item.get("handler") or "").strip()
        if not handler_id:
            handler_id = detect_handler(str(item.get("prompt") or ""), available) or ""
        handler = resolve_handler(handlers, handler_id or None)
        if handler.output == OUTPUT_SPRITE:
            sprite_regions.append({**item, "handler": handler.id})
        else:
            composite_regions.append({**item, "handler": handler.id})

    if regions:
        if sprite_regions and composite_regions:
            return {
                "intent": "mixed",
                "image_count": 1 + len(sprite_regions),
                "composite": True,
                "sprites": sprite_regions,
                "confidence": 0.88,
                "reason": f"{len(composite_regions)} 处需要改图、{len(sprite_regions)} 处需要抠成素材",
            }
        if sprite_regions:
            return {
                "intent": "cutout",
                "image_count": max(1, len(sprite_regions)),
                "composite": False,
                "sprites": sprite_regions,
                "confidence": 0.86,
                "reason": f"{len(sprite_regions)} 处只需要抠成透明素材",
            }
        return {
            "intent": "edit",
            "image_count": 1,
            "composite": True,
            "sprites": [],
            "confidence": 0.9,
            "reason": f"{len(composite_regions)} 处修改合并成一张整图",
        }

    # 没有选区：只能靠文案判断
    wants_cut = _has_any(message, _CUT_WORDS + _TRANSPARENT_WORDS)
    wants_edit = _has_any(message, _EDIT_WORDS)
    if wants_cut and wants_edit:
        return {
            "intent": "mixed",
            "image_count": 2,
            "composite": True,
            "sprites": [],
            "confidence": 0.72,
            "reason": "需求里同时出现了「改图」和「抠图」两件事",
        }
    if wants_cut:
        return {
            "intent": "cutout",
            "image_count": 1,
            "composite": False,
            "sprites": [],
            "confidence": 0.78,
            "reason": "只需要把主体抠成透明素材",
        }
    if has_image:
        return {
            "intent": "edit",
            "image_count": 1,
            "composite": True,
            "sprites": [],
            "confidence": 0.8,
            "reason": "对当前图片做单一场景修改",
        }
    if _has_any(message, _GENERATE_WORDS):
        return {
            "intent": "generate",
            "image_count": 1,
            "composite": False,
            "sprites": [],
            "confidence": 0.85,
            "reason": "没有参考图，按描述生成一张新图",
        }
    return {
        "intent": "edit",
        "image_count": 1,
        "composite": True,
        "sprites": [],
        "confidence": 0.55,
        "reason": "没有选区也没有明确的生成线索",
    }


# --------------------------------------------------------------------------- #
# 步骤轨迹
# --------------------------------------------------------------------------- #
class _Trace:
    """记录每一步的状态与耗时，最终随结果一起返回并落库。"""

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
        }
        self.steps.append(payload)
        return payload

    def finish(
        self,
        step_id: str,
        *,
        status: str = "done",
        detail: str | None = None,
        title: str | None = None,
    ) -> dict[str, Any]:
        started = self._started.pop(step_id, None)
        elapsed = int((time.perf_counter() - started) * 1000) if started else 0
        for step in reversed(self.steps):
            if step["id"] == step_id:
                step["status"] = status
                step["elapsed_ms"] = elapsed
                if detail is not None:
                    step["detail"] = detail
                if title is not None:
                    step["title"] = title
                return step
        step = {
            "id": step_id,
            "title": title or step_id,
            "detail": detail or "",
            "status": status,
            "elapsed_ms": elapsed,
        }
        self.steps.append(step)
        return step


# --------------------------------------------------------------------------- #
# 选区归一化
# --------------------------------------------------------------------------- #
def normalize_selection(selection: Any) -> dict[str, Any]:
    """把前端选区整理成内部结构（区域坐标 + 多边形 + 资产 id）。"""
    data = selection if isinstance(selection, dict) else {}
    raw_regions = data.get("regions")
    items = raw_regions if isinstance(raw_regions, list) else []
    regions: list[dict[str, Any]] = []
    for position, item in enumerate(items[: ops_module.MAX_OPS], start=1):
        if not isinstance(item, dict):
            continue
        source = item.get("region") if isinstance(item.get("region"), dict) else item
        region = ops_module.clean_region(source)
        if region is None:
            continue
        regions.append(
            {
                "index": int(item.get("index") or position),
                "region": region,
                "path": ops_module.clean_path(item.get("path")),
                "prompt": str(item.get("prompt") or "").strip(),
                "handler": str(item.get("handler") or "").strip(),
            }
        )
    return {
        "asset_id": str(data.get("asset_id") or "").strip() or None,
        # 掩码资产必须一起带走：确认时才重放计划，掩码丢了就等于用户没涂过。
        "mask_asset_id": str(data.get("mask_asset_id") or "").strip() or None,
        "target_id": str(data.get("target_id") or "").strip() or None,
        "revision": int(data.get("revision") or 0),
        "has_doodle": bool(data.get("has_doodle")),
        "width": int(data.get("width") or 0),
        "height": int(data.get("height") or 0),
        "regions": regions,
    }


# --------------------------------------------------------------------------- #
# 模型补充
# --------------------------------------------------------------------------- #
def _extract_json(text: str) -> dict[str, Any] | None:
    """从模型回复里稳健抽取 JSON（容忍围栏与前后说明）。"""
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.DOTALL)
    candidates = [fence.group(1)] if fence else []
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


def _extract_content(result: Any) -> str:
    if not isinstance(result, dict):
        return ""
    try:
        choices = result.get("choices") or []
        if not choices:
            return ""
        return str((choices[0].get("message") or {}).get("content") or "")
    except (AttributeError, IndexError, TypeError):
        return ""


async def _ask_model(
    db: AsyncSession,
    message: str,
    selection: dict[str, Any],
    handlers: dict[str, EditHandler],
) -> dict[str, Any] | None:
    """让中转站模型补充语义与提示词；失败返回 None（规则结论仍然有效）。"""
    template = await prompt_service.load(db, "skill_image_intent")
    system_prompt = prompt_service.render(template, catalog=render_catalog(handlers))
    lines: list[str] = []
    if selection["regions"]:
        for item in selection["regions"]:
            region = item["region"]
            shape = "自由选区" if item.get("path") else "矩形选区"
            lines.append(
                f"- 区域{item['index']}（{shape}，x={region['x']}, y={region['y']}, "
                f"w={region['w']}, h={region['h']}）：{item['prompt'] or '（未描述）'}"
            )
    else:
        lines.append("- 用户没有框选区域。")
    user_message = (
        "画布上"
        + ("已选中一张图片。" if selection["asset_id"] else "没有选中图片。")
        + "\n已框选区域：\n"
        + "\n".join(lines)
        + f"\n用户原话：{message}"
    )
    model = str(await config_service.get_value(db, "INTENT_PLANNER_MODEL", "")).strip() or "gpt-4o-mini"
    try:
        result = await gateway_client.llm_completions(
            {
                "model": model,
                "messages": [
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_message},
                ],
                "stream": False,
                "temperature": 0.1,
                "response_format": {"type": "json_object"},
            }
        )
    except AppError as exc:
        logger.warning("需求分析模型不可用：%s", exc.code)
        return None
    except Exception:  # noqa: BLE001 - 模型故障不得阻断编排
        logger.exception("需求分析模型异常")
        return None
    if isinstance(result, dict) and result.get("demo"):
        return None
    return _extract_json(_extract_content(result))


def _merge_model(
    base: dict[str, Any],
    model: dict[str, Any] | None,
    handlers: dict[str, EditHandler],
) -> dict[str, Any]:
    """把模型结论并入规则结论。

    约束：模型可以提升「需要确认」的门槛、补充提示词与能力，
    **不能把用户明确说出的数量改掉**（由调用方保证 base 已锁定数量）。
    """
    merged = dict(base)
    if not model:
        merged["model_used"] = False
        return merged
    merged["model_used"] = True

    confidence = model.get("confidence")
    try:
        value = float(confidence)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        value = None
    if value is not None:
        # 取「规则」与「模型」里更低的那个：模型不能把规则发现的模糊性抹掉，
        # 否则「帮我弄好看点」这种低置信输入会被一句 0.9 的自信结论直接放行。
        base_conf = float(base.get("confidence") or 0)
        merged["confidence"] = round(min(1.0, max(0.0, min(base_conf, value))), 2)

    if model.get("needs_confirmation") is True:
        merged["needs_confirmation"] = True
    reason = str(model.get("reason") or "").strip()
    if reason:
        merged["reason"] = reason
    question = str(model.get("question") or "").strip()
    if question:
        merged["question"] = question
    intent = str(model.get("intent") or "").strip().lower()
    if intent in {"edit", "cutout", "mixed", "generate", "chat"} and not base.get("explicit_count"):
        merged["intent"] = intent

    prompts: dict[int, dict[str, str]] = {}
    raw_prompts = model.get("prompts")
    if isinstance(raw_prompts, list):
        for item in raw_prompts:
            if not isinstance(item, dict):
                continue
            try:
                index = int(item.get("region_index"))
            except (TypeError, ValueError):
                continue
            handler = str(item.get("handler") or "").strip()
            if handler:
                handler = resolve_handler(handlers, handler).id
            prompts[index] = {
                "handler": handler,
                "prompt": str(item.get("prompt") or "").strip(),
            }
    merged["model_prompts"] = prompts
    return merged


# --------------------------------------------------------------------------- #
# 计划组装
# --------------------------------------------------------------------------- #
def _build_ops(
    regions: list[dict[str, Any]],
    decision: dict[str, Any],
    handlers: dict[str, EditHandler],
    message: str,
    *,
    drop_sprites: bool = False,
) -> list[dict[str, Any]]:
    """把选区 + 模型提示词组装成可执行的 ops。"""
    model_prompts: dict[int, dict[str, str]] = decision.get("model_prompts") or {}
    available = set(handlers)
    source = regions or [
        {
            "index": 1,
            "region": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0},
            "path": None,
            "prompt": message,
            "handler": "",
        }
    ]
    ops: list[dict[str, Any]] = []
    for item in source:
        handler_id = item.get("handler") or ""
        hint = model_prompts.get(item["index"], {})
        handler_id = handler_id or hint.get("handler") or detect_handler(item.get("prompt") or message, available) or ""
        handler = resolve_handler(handlers, handler_id or None)
        if drop_sprites and handler.output == OUTPUT_SPRITE:
            continue
        prompt = hint.get("prompt") or item.get("prompt") or message
        ops.append(
            {
                "region": item["region"],
                "path": item.get("path"),
                "handler": handler.id,
                "prompt": str(prompt).strip(),
                "intensity": "fine",
            }
        )
    return ops


def _build_options(
    decision: dict[str, Any],
    selection: dict[str, Any],
    handlers: dict[str, EditHandler],
    message: str,
) -> list[dict[str, Any]]:
    """需要确认时给出的两套方案（数量 + 产出构成都不同）。"""
    ops_full = _build_ops(selection["regions"], decision, handlers, message)
    ops_single = _build_ops(
        selection["regions"], decision, handlers, message, drop_sprites=True
    ) or ops_full
    return [
        {
            "id": "single",
            "label": "只出 1 张修改图",
            "description": "保留原构图，只改你标出的区域，不做额外导出",
            "image_count": 1,
            "plan": {"ops": ops_single, "variants": 1, "intent": "edit"},
        },
        {
            "id": "double",
            "label": "出 2 张：修改图 + 透明素材",
            "description": "先给你改好的整图，再把标记区域抠成透明 PNG",
            "image_count": 2,
            "plan": {"ops": ops_full, "variants": 2 if len(ops_full) <= 1 else 1, "intent": "mixed"},
        },
    ]


def _reply_text(decision: dict[str, Any], selection: dict[str, Any]) -> str:
    """给用户看的一句结论（不复述内部字段名）。"""
    count = decision["image_count"]
    reason = decision.get("reason") or ""
    if decision.get("requires_image"):
        return "这件事需要一张底图：先在画布上选中一张图片，或用「上传」放一张进来。"
    if decision.get("needs_confirmation"):
        return decision.get("question") or f"有两种做法，产出数量不一样，你选一个我再开始。"
    if count >= 2:
        return f"这次要产出 {count} 张：{reason}。我按这个方案直接开始。"
    return f"这次产出 1 张：{reason}。我按这个方案直接开始。"


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def _sse(payload: dict[str, Any]) -> str:
    """把一条事件编码成 SSE 帧（`data: <json>\\n\\n`）。

    为什么必须在服务端编码：`StreamingResponse` 只接受 `str`/`bytes`。
    直接 `yield` 一个 dict 会被当成 dict 迭代出它的 **key**（"event"、"step"…），
    前端收到的是一堆裸单词、没有 `data:` 前缀 → 解析不出任何事件，
    表现为「点发送后一直转圈、步骤流始终为空」。编码只在这一处做，避免各处走样。
    """
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


async def stream_analysis(
    *,
    user: User,
    session_id: str,
    content: str,
    selection: Any,
    canvas_id: str | None,
    auto_execute: bool = True,
) -> AsyncIterator[str]:
    """执行 Skill 并把每一步实时吐出来（SSE 事件流）。

    事件类型（均为 `data: {json}` 帧）：
    - ``{"event":"step","step":{...}}`` 步骤状态变化（含 running）
    - ``{"event":"result","result":{...}}`` 最终结果（含 run_id / options / tasks）
    """
    skill = SKILLS[SKILL_IMAGE_INTENT]
    trace = _Trace()
    normalized = normalize_selection(selection)
    text = (content or "").strip()

    async with AsyncSessionLocal() as db:
        session = (
            await db.execute(select(ChatSession).where(ChatSession.id == session_id))
        ).scalar_one_or_none()
        if session is None or session.user_id != user.id:
            raise AppError(ErrorCode.NOT_FOUND, "会话不存在")

        user_message = await _append_message(db, session.id, user.id, "user", text)
        await db.commit()

        handlers = await load_handlers(db)

        # 1) 读取需求
        step = trace.start("parse", skill.steps[0].title)
        yield _sse({"event": "step", "step": dict(step)})
        region_count = len(normalized["regions"])
        has_image = bool(normalized["asset_id"])
        parse_detail = (
            f"读到 {region_count} 个选区" if region_count else "没有选区，按整图理解"
        ) + ("，已选中底图" if has_image else "，未选中底图")
        step = trace.finish("parse", detail=parse_detail)
        yield _sse({"event": "step", "step": dict(step)})

        # 2) 判定产出（先规则，再模型补充）
        step = trace.start("decide", skill.steps[1].title)
        yield _sse({"event": "step", "step": dict(step)})

        explicit = detect_explicit_count(text)
        structure = classify_structure(text, normalized["regions"], handlers, has_image=has_image)
        base: dict[str, Any] = {
            "intent": structure["intent"],
            "image_count": structure["image_count"],
            "confidence": structure["confidence"],
            "reason": structure["reason"],
            "needs_confirmation": False,
            "question": "",
            "explicit_count": explicit,
            "composite": structure["composite"],
            "sprites": structure["sprites"],
            "requires_image": False,
        }

        # 需要底图却没有底图：不要猜，直接告诉用户先选图
        if base["intent"] in {"edit", "cutout", "mixed"} and not has_image:
            base["requires_image"] = True
            base["needs_confirmation"] = False

        # 只有涂鸦、没有框选，且意图是抠图：抠哪一块只能靠涂鸦猜，必须问
        if (
            normalized.get("has_doodle")
            and not normalized["regions"]
            and structure["intent"] == "cutout"
            and has_image
        ):
            base["needs_confirmation"] = True
            base["question"] = "你是要「只把涂鸦这块抠成透明素材」，还是「在整图上只改这块」？"

        # 数量线索与结构判断的关系
        if explicit is not None and not base["requires_image"]:
            if explicit == 1 and structure["image_count"] > 1:
                # 自相矛盾：说一张，却既要改图又要素材 → 必须问
                base["needs_confirmation"] = True
                base["image_count"] = 1
                base["question"] = "你提到「一张」，但需求里同时要改图和抠素材，一张放不下。要哪一种？"
                base["reason"] = "数量与需求结构冲突"
            elif explicit == 2 and structure["image_count"] == 1:
                # 用户要多张、结构只有一件事 → 出两个版本，尊重用户
                base["image_count"] = 2
                base["variants"] = 2
                base["reason"] = "按你指定的 2 张，生成两个版本"
            else:
                base["image_count"] = max(explicit, structure["image_count"]) if structure["image_count"] > 1 else explicit
        base.setdefault("variants", 1)

        # 模糊表述：没有明确数量时，宁可问一句
        ambiguous_hit = False
        if explicit is None and _has_any(text, _AMBIGUOUS_WORDS):
            ambiguous_hit = True
            base["needs_confirmation"] = True
            base["question"] = "这句有两种做法，你要哪一种？"

        model_result = await _ask_model(db, text, normalized, handlers)
        decision = _merge_model(base, model_result, handlers)
        # 模型不能推翻用户明确说出的数量
        if explicit is not None:
            decision["image_count"] = base["image_count"]
            decision["variants"] = base.get("variants", 1)
        if decision.get("confidence", 0) < 0.5 and not decision.get("requires_image"):
            decision["needs_confirmation"] = True
            decision.setdefault("question", "我不太确定你要的是哪一种，选一个我马上开始。")
        # 结构判断本身就模糊（例如「帮我弄好看点」）：模型再自信也不能直接放行。
        # 用户明确说了数量的情况除外——那属于「用户自己拍板」，按铁律直接执行。
        if (
            explicit is None
            and structure["confidence"] < 0.6
            and not decision.get("requires_image")
        ):
            decision["needs_confirmation"] = True
            decision.setdefault(
                "question", "这句我听不出要改哪里、改成什么样，你要的是哪一种？"
            )

        step = trace.finish(
            "decide",
            detail=f"判定 {decision['image_count']} 张 · {decision['reason']}",
        )
        yield _sse({"event": "step", "step": dict(step)})

        # 3) 编排决策
        step = trace.start("route", skill.steps[2].title)
        yield _sse({"event": "step", "step": dict(step)})
        if decision.get("requires_image"):
            route = "needs_image"
            route_detail = "缺少底图，等待用户选中图片"
        elif decision.get("needs_confirmation"):
            route = "confirm"
            route_detail = "结论不唯一，交给用户选择"
        elif auto_execute:
            route = "direct"
            route_detail = "结论明确，直接执行"
        else:
            route = "preview"
            route_detail = "只给方案，等待用户确认"
        step = trace.finish("route", detail=route_detail)
        yield _sse({"event": "step", "step": dict(step)})

        # 4) 整理指令
        step = trace.start("compose", skill.steps[3].title)
        yield _sse({"event": "step", "step": dict(step)})
        ops = _build_ops(normalized["regions"], decision, handlers, text)
        options = (
            _build_options(decision, normalized, handlers, text)
            if decision.get("needs_confirmation")
            else []
        )
        compose_detail = f"整理了 {len(ops)} 条区域指令" if ops else "整图指令已就绪"
        step = trace.finish("compose", detail=compose_detail)
        yield _sse({"event": "step", "step": dict(step)})

        plan = {
            "intent": decision["intent"],
            "image_count": decision["image_count"],
            "variants": int(decision.get("variants") or 1),
            "ops": ops,
            "asset_id": normalized["asset_id"],
            "target_id": normalized.get("target_id"),
            "selection_revision": int(normalized.get("revision") or 0),
            "selection_fingerprint": ops_module.selection_fingerprint(normalized["regions"]),
            "size": _guess_size(normalized),
        }
        # 产出明细（分组）：前端按组展示「1 张修改图 + 2 张素材」，
        # 而不是只给一个总数——总数会让用户误以为 3 张都是同一种东西。
        try:
            previews = ops_module.estimate_outputs(
                ops_module.normalize_ops(ops, handlers=handlers), handlers
            )
            outputs = [item.to_dict() for item in previews]
        except Exception:  # noqa: BLE001 - 预估失败不影响主流程
            logger.exception("产出预估失败")
            outputs = []
        # 命中的是哪条编排规则（用于前端展示判定依据，证明没有偏离预设）
        if decision.get("requires_image"):
            rule_hit = "needs_image"
        elif explicit is not None:
            rule_hit = "explicit_count"
        elif ambiguous_hit:
            rule_hit = "ambiguous"
        else:
            rule_hit = "structure"
        run = SkillRun(
            id=new_id(),
            user_id=user.id,
            session_id=session.id,
            canvas_id=canvas_id or session.canvas_id,
            message_id=user_message.id,
            skill_id=skill.id,
            status=route,
            image_count=int(decision["image_count"]),
            confidence=int(round(float(decision.get("confidence") or 0) * 100)),
            input={"content": text, "selection": normalized},
            plan=plan,
            steps=list(trace.steps),
            options=options,
            task_ids=[],
        )
        db.add(run)
        await db.flush()

        tasks: list[dict[str, Any]] = []
        # 5) 提交生成
        if route in {"direct", "preview"}:
            step = trace.start("dispatch", skill.steps[4].title)
            yield _sse({"event": "step", "step": dict(step)})
            if route == "direct":
                try:
                    tasks = await _dispatch(db, user, run, plan, ops)
                except AppError as exc:
                    # 提交失败（额度不足 / 并发任务已满 / 上游不可用）必须**在流里说清楚**。
                    # 之前这里直接抛出，SSE 会被拦腰切断：前端只看到"分析中"然后无限等待，
                    # 用户既不知道失败原因，也拿不到可重试的入口。
                    logger.warning("编排提交失败 run=%s: %s %s", run.id, exc.code, exc.message)
                    run.status = "failed"
                    step = trace.finish(
                        "dispatch",
                        detail=exc.message,
                        status="failed",
                    )
                    yield _sse({"event": "step", "step": dict(step)})
                    run.steps = list(trace.steps)
                    run.updated_at = utcnow()
                    await db.commit()
                    await _append_message(
                        db,
                        session.id,
                        user.id,
                        "assistant",
                        exc.message,
                        attachments=[
                            {
                                "type": "skill_run",
                                "run_id": run.id,
                                "skill": skill.to_public(),
                                "status": "failed",
                                "steps": list(trace.steps),
                                "image_count": run.image_count,
                                "confidence": run.confidence,
                                "reason": decision.get("reason") or "",
                                "options": [],
                                "requires_image": False,
                                "task_ids": [],
                                "rule_hit": rule_hit,
                                "outputs": outputs,
                                "selection_revision": plan["selection_revision"],
                                "selection_fingerprint": plan.get("selection_fingerprint"),
                                "target_id": plan.get("target_id"),
                                "canvas_id": run.canvas_id,
                            }
                        ],
                    )
                    await db.commit()
                    yield _sse(
                        {
                            "event": "result",
                            "result": {
                                "run_id": run.id,
                                "message_id": "",
                                "user_message_id": user_message.id,
                                "skill": skill.to_public(),
                                "status": "failed",
                                "image_count": run.image_count,
                                "confidence": run.confidence,
                                "reason": decision.get("reason") or "",
                                "reply": exc.message,
                                "steps": list(trace.steps),
                                "options": [],
                                "tasks": [],
                                "requires_image": False,
                                "demo": False,
                                "rule_hit": rule_hit,
                                "outputs": outputs,
                                "error_code": exc.code,
                                "selection_revision": plan["selection_revision"],
                                "selection_fingerprint": plan.get("selection_fingerprint"),
                                "target_id": plan.get("target_id"),
                                "canvas_id": run.canvas_id,
                            },
                        }
                    )
                    return
                run.status = "completed"
                run.task_ids = [item["id"] for item in tasks]
                step = trace.finish(
                    "dispatch",
                    detail=f"已提交 {len(tasks)} 个生成任务" if tasks else "没有可提交的任务",
                    status="done" if tasks else "skipped",
                )
            else:
                step = trace.finish("dispatch", detail="等待用户确认后提交", status="skipped")
            yield _sse({"event": "step", "step": dict(step)})
        else:
            trace.finish("dispatch", detail="尚未提交", status="skipped")

        run.steps = list(trace.steps)
        run.updated_at = utcnow()
        await db.commit()

        assistant = await _append_message(
            db,
            session.id,
            user.id,
            "assistant",
            _reply_text(decision, normalized),
            attachments=[
                {
                    "type": "skill_run",
                    "run_id": run.id,
                    "skill": skill.to_public(),
                    "status": run.status,
                    "steps": list(trace.steps),
                    "image_count": run.image_count,
                    "confidence": run.confidence,
                    "reason": decision.get("reason") or "",
                    "options": options,
                    "requires_image": bool(decision.get("requires_image")),
                    "task_ids": run.task_ids,
                    "rule_hit": rule_hit,
                    "outputs": outputs,
                    "selection_revision": plan["selection_revision"],
                    "selection_fingerprint": plan.get("selection_fingerprint"),
                    "target_id": plan.get("target_id"),
                    "canvas_id": run.canvas_id,
                }
            ],
        )
        await db.commit()

        # 记下这条 assistant 消息的 id：确认方案后要把它的附件快照回写成
        # 「已完成 + 选了哪个方案」，否则刷新页面会看到一张还能再点的确认卡，
        # 用户会以为刚才那次确认根本没生效。存在 run.input 里，不动表结构。
        run.input = {**(run.input or {}), "result_message_id": assistant.id}
        await db.commit()

        yield _sse(
            {
                "event": "result",
                "result": {
                    "run_id": run.id,
                    "message_id": assistant.id,
                    "user_message_id": user_message.id,
                    "skill": skill.to_public(),
                    "status": run.status,
                    "image_count": run.image_count,
                    "confidence": run.confidence,
                    "reason": decision.get("reason") or "",
                    "reply": assistant.content,
                    "steps": list(trace.steps),
                    "options": options,
                    "tasks": tasks,
                    "requires_image": bool(decision.get("requires_image")),
                    "demo": not bool(decision.get("model_used")),
                    "rule_hit": rule_hit,
                    "outputs": outputs,
                    "selection_revision": plan["selection_revision"],
                    "selection_fingerprint": plan.get("selection_fingerprint"),
                    "target_id": plan.get("target_id"),
                    "canvas_id": run.canvas_id,
                },
            }
        )


async def confirm_run(
    db: AsyncSession,
    user: User,
    run_id: str,
    option_id: str,
    selection_fingerprint: str = "",
) -> dict[str, Any]:
    """用户选定方案后执行（服务端凭 run_id 重建任务，不信任前端回传的计划）。

    :param selection_fingerprint: 客户端按**当前**选区重算的指纹。
        必须由客户端算并回传——拿服务端存的值和它自己比等于永远通过，
        用户在确认前又挪了选区/改了指令，旧计划就会被错误执行。
        为空表示调用方没有做校验（仅内部调用），此时退化为用存库选区自检。
    """
    run = (
        await db.execute(select(SkillRun).where(SkillRun.id == run_id))
    ).scalar_one_or_none()
    if run is None:
        raise AppError(ErrorCode.NOT_FOUND, "这次分析记录已失效，重新说一次需求就好")
    if run.user_id != user.id:
        raise AppError(ErrorCode.FORBIDDEN, "无权操作该记录")
    if run.status == "completed" and run.task_ids:
        # 幂等：重复点确认不重复建任务。顺手补一次附件回写，
        # 让历史数据（改动前确认的那些）刷新后也能显示「已选择」。
        await _sync_result_attachment(
            db, run, str((run.plan or {}).get("chosen_option_id") or "") or None
        )
        await db.commit()
        return {"run_id": run.id, "status": run.status, "task_ids": run.task_ids, "tasks": []}

    options = run.options or []
    chosen = next((item for item in options if item.get("id") == option_id), None)
    if chosen is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个方案已经失效，重新说一次需求就好")

    # 计划必须仍然对应当前选区：选区在确认前被改过，旧结论就不能再执行
    expected = str((run.plan or {}).get("selection_fingerprint") or "")
    provided = str(selection_fingerprint or "").strip()
    if provided:
        actual = provided
    else:
        stored_selection = (run.input or {}).get("selection") or {}
        actual = ops_module.selection_fingerprint(stored_selection.get("regions"))
    if expected and actual != expected:
        raise AppError(
            ErrorCode.TASK_STATE_CONFLICT,
            "选区在确认前变了，这次分析已经作废，重新说一次需求就好",
        )

    plan = {**(run.plan or {})}
    option_plan = chosen.get("plan") or {}
    if option_plan.get("ops") is not None:
        plan["ops"] = option_plan["ops"]
    plan["variants"] = int(option_plan.get("variants") or plan.get("variants") or 1)
    plan["intent"] = option_plan.get("intent") or plan.get("intent")
    plan["image_count"] = int(chosen.get("image_count") or plan.get("image_count") or 1)
    # 记下选了哪个方案：附件回写要用它，幂等重放时也靠它避免把 A 改写成 B
    plan["chosen_option_id"] = option_id

    tasks = await _dispatch(db, user, run, plan, plan.get("ops") or [])
    run.status = "completed"
    run.task_ids = [item["id"] for item in tasks]
    run.image_count = plan["image_count"]
    run.plan = plan
    run.updated_at = utcnow()
    await _sync_result_attachment(db, run, option_id)
    await db.commit()
    return {
        "run_id": run.id,
        "status": run.status,
        "task_ids": run.task_ids,
        "tasks": tasks,
    }


async def _sync_result_attachment(
    db: AsyncSession, run: SkillRun, option_id: str | None = None
) -> None:
    """把「已确认」写回那条 assistant 消息的 skill_run 附件快照。

    附件是分析当时的快照，确认后如果不回写，刷新页面看到的仍然是
    ``status=confirm`` + ``task_ids=[]`` 的旧状态 —— 卡片又变成可点，
    用户会以为刚才那次确认没生效（真实费用是安全的，但信任感是崩的）。

    :param option_id: 用户选定的方案 id；为 None 时（幂等重放且没记录过）
        只回写状态与任务，不覆盖已有的 ``chosen_option_id``，避免把 A 改写成 B。

    只在方法内部延迟导入 ChatMessage：`chat_service` 反向依赖本模块，
    顶层导入会形成循环。
    """
    from app.models.chat import ChatMessage

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
        if not isinstance(item, dict) or item.get("type") != "skill_run":
            continue
        if str(item.get("run_id") or "") != run.id:
            continue
        updated = {
            **item,
            "status": "completed",
            "task_ids": list(run.task_ids or []),
            "image_count": int(run.image_count),
        }
        if option_id:
            updated["chosen_option_id"] = option_id
        attachments[index] = updated
        touched = True
    if not touched:
        return
    # JSON 列必须整体重新赋值，原地改 dict 不会被 SQLAlchemy 标记为脏
    message.attachments = attachments


async def _dispatch(
    db: AsyncSession,
    user: User,
    run: SkillRun,
    plan: dict[str, Any],
    ops: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """按计划创建生成任务并立即开始执行。"""
    intent = str(plan.get("intent") or "edit")
    variants = max(1, min(int(plan.get("variants") or 1), 4))
    selection = (run.input or {}).get("selection") or {}
    asset_id = plan.get("asset_id") or selection.get("asset_id")
    canvas_id = run.canvas_id
    session_id = run.session_id
    content = str((run.input or {}).get("content") or "")

    created: list[Any] = []
    if intent == "generate" or not asset_id:
        task, is_new = await generate_service.create_image_task(
            db,
            user.id,
            prompt=content,
            model="gpt-image-2",
            size=str(plan.get("size") or "1024x1024"),
            quality="standard",
            n=variants,
            session_id=session_id,
            canvas_id=canvas_id,
            idempotency_key=new_id(),
            extra={"skill_run_id": run.id},
        )
        created.append((task, is_new))
    else:
        asset = await asset_service.get_asset(db, user, str(asset_id))
        # 画笔/套索掩码：上游只重绘掩码区域。掩码丢了会变成整图重绘，
        # 所以这里必须把 mask_asset_id 一并解析成可访问的 url 传下去。
        mask_url: str | None = None
        mask_asset_id = str(selection.get("mask_asset_id") or "").strip()
        if mask_asset_id:
            mask_asset = await asset_service.get_asset(db, user, mask_asset_id)
            mask_url = mask_asset.url
        task, is_new = await generate_service.create_edit_task(
            db,
            user.id,
            prompt=content,
            model="gpt-image-2",
            size=str(plan.get("size") or "1024x1024"),
            base_image_url=asset.url,
            mask_url=mask_url,
            session_id=session_id,
            canvas_id=canvas_id,
            idempotency_key=new_id(),
            edit_ops=ops,
            extra={"n": variants, "skill_run_id": run.id},
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
                "image_count": plan.get("image_count") or 1,
            }
        )
    return payload


_BACKGROUND: set[asyncio.Task[None]] = set()


def _spawn_run(task_id: str) -> None:
    """后台执行生成任务（流式响应里拿不到 BackgroundTasks，这里自己管引用）。"""
    task = asyncio.create_task(generate_service.run_task(task_id))
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)


def _guess_size(selection: dict[str, Any]) -> str:
    """按底图比例挑一个上游支持的尺寸（缺省 1024x1024）。"""
    width = int(selection.get("width") or 0)
    height = int(selection.get("height") or 0)
    if width <= 0 or height <= 0:
        return "1024x1024"
    ratio = width / height
    if ratio > 1.2:
        return "1536x1024"
    if ratio < 0.83:
        return "1024x1536"
    return "1024x1024"


async def _append_message(
    db: AsyncSession,
    session_id: str,
    user_id: str,
    role: str,
    content: str,
    attachments: list[Any] | None = None,
):
    """直接写消息（避免与 chat_service 形成循环导入）。"""
    from app.models.chat import ChatMessage

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


def list_skills() -> list[dict[str, Any]]:
    """对外暴露 Skill 声明（前端据此展示编排规则，证明执行未偏离）。"""
    return [skill.to_public() for skill in SKILLS.values()]
