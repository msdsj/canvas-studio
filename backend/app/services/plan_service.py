"""LLM 意图分析服务：把「用户原话 + 框选区域」解析为结构化编辑计划。

这是平台「智能」的入口——用户不需要懂能力枚举，只需要说人话：

    用户：把左边这个人换成穿红裙的，然后把右下角的猫抠成贴纸
    → ops: [{1, restyle, "把该人物换成正红色连衣裙…"}, {2, cutout, ""}]

关键设计：**能力清单由注册表动态注入提示词**。管理员在后台新增一种能力后，
LLM 立刻就知道它存在，无需修改本模块任何代码。
"""
from __future__ import annotations

import json
import re
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import config_service
from app.services import edit_ops as ops_module
from app.services import param_service, prompt_service, text_llm
from app.services.edit_handlers import (
    EditHandler,
    load_handlers,
    render_catalog,
    resolve_handler,
)
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.plan_service")

# 意图分析默认模型（可被系统配置 INTENT_PLANNER_MODEL 覆盖）
DEFAULT_MODEL = "gpt-4o-mini"
# 单次分析的最大区域数
_MAX_REGIONS = ops_module.MAX_OPS

_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)
_INTENSITIES = {"fine", "rebuild"}


def _extract_json(text: str) -> dict[str, Any] | None:
    """从模型回复中稳健地抽取 JSON 对象（容忍围栏、前后缀说明文字）。"""
    if not text:
        return None
    candidates: list[str] = []
    fenced = _JSON_FENCE.search(text)
    if fenced:
        candidates.append(fenced.group(1))
    candidates.append(text)
    start = text.find("{")
    end = text.rfind("}")
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


def _normalize_regions(raw: Any) -> list[dict[str, Any]]:
    """归一化前端传入的区域列表 → ``[{index, region}]``（坐标已夹取）。"""
    items = raw if isinstance(raw, list) else ([raw] if isinstance(raw, dict) else [])
    regions: list[dict[str, Any]] = []
    for position, item in enumerate(items[: _MAX_REGIONS], start=1):
        if not isinstance(item, dict):
            continue
        source = item.get("region") if isinstance(item.get("region"), dict) else item
        cleaned = ops_module.clean_region(source)
        if cleaned is None:
            continue
        try:
            index = int(item.get("index", position))
        except (TypeError, ValueError):
            index = position
        regions.append({"index": index, "region": cleaned})
    return regions


def _build_user_message(
    message: str,
    regions: list[dict[str, Any]],
    history: list[dict[str, Any]] | None = None,
    canvas: dict[str, Any] | None = None,
) -> str:
    """拼装用户消息：对话上下文 + 画布操作信息 + 区域清单 + 原始需求。

    这是「标准化需求解析模板」的落地：模型每次都能看到同样的四段结构，
    输出才能稳定成 JSON，后端才敢直接拿去拆任务。
    """
    chunks: list[str] = []

    # ① 对话上下文（只取最近 6 轮，避免把提示词撑爆；越近越相关）
    if history:
        lines: list[str] = []
        for item in history[-6:]:
            if not isinstance(item, dict):
                continue
            role = "用户" if str(item.get("role")) == "user" else "助手"
            content = str(item.get("content") or "").strip().replace("\n", " ")
            if content:
                lines.append(f"- {role}：{content[:300]}")
        if lines:
            chunks.append("对话上下文（最近 6 条，供理解指代）：\n" + "\n".join(lines))

    # ② 画布操作信息：选中图片 / 选区 / 操作类型
    if canvas:
        facts: list[str] = []
        if canvas.get("image_id"):
            facts.append(f"- 选中图片 ID：{canvas['image_id']}")
        if canvas.get("image_size"):
            size = canvas["image_size"]
            if isinstance(size, dict):
                facts.append(f"- 原图尺寸：{size.get('width')}×{size.get('height')}")
        if canvas.get("op_type"):
            facts.append(f"- 画布操作类型：{canvas['op_type']}")
        if canvas.get("selection_count") is not None:
            facts.append(f"- 选区数量：{canvas['selection_count']}")
        if facts:
            chunks.append("画布操作信息：\n" + "\n".join(facts))

    if regions:
        lines = [
            f"- 区域{item['index']}：x={item['region']['x']}, y={item['region']['y']}, "
            f"w={item['region']['w']}, h={item['region']['h']}（归一化坐标，左上为原点）"
            for item in regions
        ]
        chunks.append("用户已框选的区域：\n" + "\n".join(lines))
    else:
        chunks.append("用户没有框选任何区域，本次需求作用于整张图片。")
    chunks.append(f"用户需求：{message.strip()}")
    chunks.append(
        "任务约束：\n"
        "- 必须拆解为可执行的生图/修图子任务，一个独立产出对应一条 op；\n"
        "- 「先抠图再换背景」这类复合需求必须拆成多条，不要合并；\n"
        "- 每条 op 的 prompt 必须自带完整上下文（改哪里、改成什么、保持什么不变）；\n"
        "- 只输出 JSON，不要解释文字。"
    )
    return "\n\n".join(chunks)


def _fallback_plan(
    message: str, regions: list[dict[str, Any]], handlers: dict[str, EditHandler]
) -> dict[str, Any]:
    """解析失败时的兜底计划：所有区域按兜底能力处理，指令取用户原话。"""
    fallback = resolve_handler(handlers, None)
    ops: list[dict[str, Any]] = []
    if regions:
        for item in regions:
            ops.append(
                {
                    "region_index": item["index"],
                    "region": item["region"],
                    "handler": fallback.id,
                    "prompt": message.strip(),
                    "intensity": "fine",
                }
            )
    return {"reply": "已按你的描述处理（未能进一步拆分区域）", "ops": ops}


def _resolve_ops(
    raw_ops: Any,
    regions: list[dict[str, Any]],
    handlers: dict[str, EditHandler],
    message: str,
) -> tuple[list[dict[str, Any]], list[int], bool]:
    """把模型给出的 op 列表落到真实坐标上，并校验能力合法性。

    :return: ``(ops, dropped_indexes, fabricated)``

    ``fabricated=True`` 表示模型给出的 op **全部无效**、这里用兜底能力补了一份。
    这种情况必须让上层知道——否则会把「系统自己编的计划」当成「AI 的理解」展示给
    用户，用户付费执行的将是一份从未被理解过的方案。
    """
    by_index = {item["index"]: item["region"] for item in regions}
    ordered = sorted(regions, key=lambda item: item["index"])
    resolved: list[dict[str, Any]] = []
    dropped: list[int] = []
    if not isinstance(raw_ops, list):
        return resolved, dropped, False
    for position, raw in enumerate(raw_ops, start=1):
        if not isinstance(raw, dict):
            continue
        try:
            index = int(raw.get("region_index", position))
        except (TypeError, ValueError):
            index = position
        region = by_index.get(index)
        if region is None:
            # 模型臆造了不存在的区域编号：无框选时作用于全图，有框选时**丢弃并记录**
            if regions:
                logger.warning("意图分析返回了不存在的区域编号 %s，已丢弃", index)
                dropped.append(index)
                continue
            region = {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}
            index = 0
        handler = resolve_handler(handlers, str(raw.get("handler") or "").strip() or None)
        intensity = str(raw.get("intensity") or "fine").strip().lower()
        resolved.append(
            {
                "region_index": index,
                "region": region,
                "handler": handler.id,
                "prompt": str(raw.get("prompt") or "").strip(),
                "intensity": intensity if intensity in _INTENSITIES else "fine",
            }
        )
    if not resolved and ordered:
        # 全部被丢弃：**不静默补位**。用兜底能力把数量凑回去，等于伪造一份计划。
        logger.warning("意图分析给出的 op 全部无效，降级为手动填写")
        return [], dropped, True
    return resolved[: ops_module.MAX_OPS], dropped, False


async def plan_edit(
    db: AsyncSession,
    *,
    message: str,
    regions: Any = None,
    model: str | None = None,
    handlers: dict[str, EditHandler] | None = None,
    history: list[dict[str, Any]] | None = None,
    canvas: dict[str, Any] | None = None,
    user_id: str | None = None,
) -> dict[str, Any]:
    """把自然语言需求解析为结构化编辑计划。

    :param message: 用户原话
    :param regions: 已框选区域（``[{index, region:{x,y,w,h}}]`` 或纯 ``[{x,y,w,h}]``）
    :param model: 覆盖意图分析模型
    :param history: 最近的对话消息（``[{role, content}]``），用于理解指代
    :param canvas: 画布上下文（选中图片 id、尺寸、操作类型）
    :return: ``{reply, ops, tasks, outputs, summary, params, demo}``
    """
    text = (message or "").strip()
    if not text:
        raise AppError(ErrorCode.VALIDATION_ERROR, "请先描述你想怎么改")

    catalog_handlers = handlers or await load_handlers(db)
    normalized_regions = _normalize_regions(regions)

    template = await prompt_service.load(db, "intent_planner")
    system_prompt = prompt_service.render(
        template, catalog=render_catalog(catalog_handlers)
    )

    configured_model = str(await config_service.get_value(db, "LLM_MODEL", "")).strip()
    model_name = (
        model
        or configured_model
        or str(await config_service.get_value(db, "INTENT_PLANNER_MODEL", DEFAULT_MODEL)).strip()
        or DEFAULT_MODEL
    )
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": _build_user_message(text, normalized_regions, history, canvas)},
        ],
        "stream": False,
        "temperature": 0.2,
    }

    demo = False
    content = ""

    # 两条链路（用户中转站 → 网关兜底）由 text_llm 统一裁决；
    # 之前这里只走网关，导致「中转站连接正常、AI 分析却报不可用」。
    try:
        completion = await text_llm.complete(
            db,
            user_id,
            payload["messages"],
            json_mode=True,
            temperature=0.2,
            max_tokens=1600,
            model=model_name,
            error_hint=(
                "意图分析服务暂时不可用：请到「AI 中转站」检查连接（网关地址 / Key / 模型），"
                "测试通过后再试；也可以先用「框选 + 逐区域填写指令」的方式。"
            ),
        )
        content = completion.content
        demo = completion.demo
    except AppError as exc:
        logger.warning("意图分析调用失败：%s %s", exc.code, exc.message)
        raise

    parsed = _extract_json(content)
    plan_source = "model"
    if parsed is None:
        logger.warning("意图分析返回内容无法解析为 JSON，走兜底计划：%s", content[:200])
        parsed = _fallback_plan(text, normalized_regions, catalog_handlers)
        plan_source = "fallback"
        demo = True

    reply = str(parsed.get("reply") or "").strip()
    resolved_ops, dropped_indexes, fabricated = _resolve_ops(
        parsed.get("ops"), normalized_regions, catalog_handlers, text
    )
    if fabricated:
        # 模型给了结果但一条都用不上：明确标记为 fallback，前端据此**不得自动回填**
        plan_source = "fallback"
        demo = True

    # 复用统一的 op 模型做产出预估与摘要
    edit_ops = ops_module.normalize_ops(resolved_ops, handlers=catalog_handlers)
    previews = ops_module.estimate_outputs(edit_ops, catalog_handlers)
    summary = ops_module.summarize_ops(edit_ops, catalog_handlers)

    thinking = [
        f"读取到 {len(normalized_regions)} 个选区，校验坐标范围",
        "识别每个选区的操作类型：局部修改、抠图或其它能力",
        f"规划产出：{ops_module.previews_to_text(previews) or '按整图需求处理'}",
    ]
    if dropped_indexes:
        thinking.append(f"有 {len(dropped_indexes)} 个区域编号对不上，已丢弃")
    if plan_source != "model":
        thinking.append("这次没能可靠理解需求，建议手动选择每个区域的处理方式")

    # 结构化子任务：每条 op 就是一个独立产出，带上它自己的执行参数。
    # 前端据此在画布上一次性铺出 N 张占位卡（而不是等第一张回来才建第二张）。
    source_size = None
    if isinstance(canvas, dict) and isinstance(canvas.get("image_size"), dict):
        try:
            source_size = (
                int(canvas["image_size"].get("width")),
                int(canvas["image_size"].get("height")),
            )
        except (TypeError, ValueError):
            source_size = None
    base_params = param_service.infer(
        text,
        kind="edit" if resolved_ops else "generate",
        source_image=source_size,
    )
    tasks: list[dict[str, Any]] = []
    for position, op in enumerate(resolved_ops, start=1):
        handler = catalog_handlers.get(op["handler"])
        params: dict[str, Any] = {
            "size": base_params["size"],
            "aspect": base_params["aspect"],
            "quality": base_params["quality"],
            "style_strength": base_params["style_strength"],
        }
        if handler is not None and handler.output == "sprite":
            # 抠图产出的是透明素材，尺寸跟随主体而不是画幅
            params.update({"size": "auto", "aspect": "主体原比例", "transparent": True})
        tasks.append(
            {
                "index": position,
                "region_index": op["region_index"],
                "region": op["region"],
                "handler": op["handler"],
                "label": (handler.label if handler is not None else f"任务 {position}")[:40],
                "instruction": op["prompt"] or (handler.label if handler is not None else text),
                "params": params,
            }
        )

    return {
        "reply": reply or (summary or "已理解你的需求"),
        "ops": resolved_ops,
        "tasks": tasks,
        "task_count": len(tasks),
        "params": base_params,
        "outputs": [item.to_dict() for item in previews],
        "summary": summary,
        "demo": demo,
        # 关键：前端只能对 plan_source=model 的结果自动回填，fallback 一律不采信
        "plan_source": plan_source,
        # 模型给的结果是否全部无效、被兜底逻辑替代（前端据此进「补充描述」态，而不是弹 toast）
        "fabricated": fabricated,
        "dropped_indexes": dropped_indexes,
        "region_count": len(normalized_regions),
        "selection_fingerprint": ops_module.selection_fingerprint(normalized_regions),
        "thinking": thinking,
        "model": model_name,
    }


def _extract_content(result: Any) -> str:
    """从 OpenAI 风格响应中提取助手文本。"""
    if not isinstance(result, dict):
        return ""
    try:
        choices = result.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") or {}
        return str(message.get("content") or "")
    except (AttributeError, IndexError, TypeError):
        return ""
