"""Validate model-authored outputs against the current owned selection."""
from __future__ import annotations

import math
from typing import Any

from app.services.edit_handlers import OUTPUT_SPRITE, EditHandler
from app.utils.errors import AppError, ErrorCode

MAX_OUTPUTS = 12


def invalid(message: str) -> AppError:
    return AppError(ErrorCode.UPSTREAM_FORMAT_ERROR, f"图片需求计划不可执行：{message}，请重新描述或重试")


def validate_model_plan(raw: dict[str, Any], selection: dict[str, Any], handlers: dict[str, EditHandler]) -> dict[str, Any]:
    """No keyword inference or fabricated operations: validate model decisions only."""
    if not isinstance(raw, dict):
        raise invalid("分析结果格式错误")
    reason = str(raw.get("reason") or "").strip()[:400]
    try:
        confidence = float(raw.get("confidence", 0.8))
    except (ValueError, TypeError):
        raise invalid("缺少有效的需求判断")
    if not math.isfinite(confidence):
        raise invalid("置信度无效")
    confirmation = bool(raw.get("needs_confirmation")) or confidence < 0.5
    raw_jobs = raw.get("jobs")
    if not isinstance(raw_jobs, list) or not 1 <= len(raw_jobs) <= MAX_OUTPUTS:
        raise invalid(f"需要提供 1–{MAX_OUTPUTS} 项独立产出")
    if type(raw.get("image_count")) is not int or raw["image_count"] != len(raw_jobs):
        raise invalid("产出数量与任务清单不一致")
    regions = {item["index"]: item for item in selection["regions"]}
    jobs: list[dict[str, Any]] = []
    for index, source in enumerate(raw_jobs, 1):
        if not isinstance(source, dict):
            raise invalid("任务格式错误")
        kind = source.get("output_kind")
        if not isinstance(kind, str) or kind not in {"composite", "sprite", "generate"}:
            raise invalid("产出类型无效")
        if not isinstance(source.get("prompt"), str):
            raise invalid("任务缺少有效的执行指令")
        prompt = source["prompt"].strip()
        if not 4 <= len(prompt) <= 3800:
            raise invalid("任务缺少完整执行指令或指令过长")
        raw_ops = source.get("ops", [])
        if not isinstance(raw_ops, list):
            raise invalid("区域指令格式错误")
        ops: list[dict[str, Any]] = []
        for op in raw_ops:
            if not isinstance(op, dict):
                raise invalid("区域指令格式错误")
            region_index = op.get("region_index")
            item = regions.get(region_index) if type(region_index) is int else None
            if item is None:
                raise invalid("引用了不存在的选区编号")
            handler_id = op.get("handler")
            if not isinstance(handler_id, str) or handler_id not in handlers:
                raise invalid("引用了不可用的图像能力")
            handler = handlers[handler_id]
            if (handler.output == OUTPUT_SPRITE) != (kind == "sprite"):
                raise invalid("区域能力和产出类型不一致")
            if op.get("prompt") is not None and not isinstance(op["prompt"], str):
                raise invalid("区域指令格式错误")
            instruction = (op.get("prompt") or prompt).strip()
            if len(instruction) > 3800:
                raise invalid("区域指令过长")
            ops.append({"index": region_index, "region": item["region"], "path": item.get("path"), "handler": handler_id, "prompt": instruction, "intensity": "rebuild" if op.get("intensity") == "rebuild" else "fine"})
        if kind == "generate" and ops:
            raise invalid("新图任务不能同时声明局部编辑")
        if kind == "sprite" and len(ops) != 1:
            raise invalid("每份独立素材需绑定一个选区")
        if kind == "composite" and regions and not ops:
            raise invalid("局部修改没有绑定选区")
        if kind != "generate" and not selection.get("asset_id"):
            raise AppError(ErrorCode.VALIDATION_ERROR, "请先选中需要修改的原图")
        use_reference = source.get("use_reference", bool(selection.get("asset_id"))) if kind == "generate" else True
        if not isinstance(use_reference, bool):
            raise invalid("参考图使用方式无效")
        if use_reference and not selection.get("asset_id"):
            raise invalid("任务需要参考图但尚未提供原图")
        jobs.append({"index": index, "label": str(source.get("label") or f"产出 {index}")[:60], "prompt": prompt, "output_kind": kind, "ops": ops, "region_indexes": [op["index"] for op in ops], "handler": ops[0]["handler"] if ops else "generate" if kind == "generate" else "restyle", "preserve_outside": kind == "composite" and bool(ops), "use_reference": use_reference})
    options = []
    raw_options = raw.get("options") if isinstance(raw.get("options"), list) else []
    for option in raw_options[:3]:
        if not isinstance(option, dict):
            continue
        try:
            alternative = validate_model_plan({**option, "needs_confirmation": False, "confidence": 1, "options": []}, selection, handlers)
        except AppError:
            continue
        options.append({"id": f"option{len(options) + 1}", "label": str(option.get("label") or f"方案 {len(options) + 1}")[:60], "description": str(option.get("description") or alternative["reason"])[:200], "image_count": alternative["image_count"], "plan": {"jobs": alternative["jobs"], "ops": alternative["ops"], "intent": alternative["intent"], "variants": 1}})
    kinds = {job["output_kind"] for job in jobs}
    intent = "generate" if kinds == {"generate"} else "cutout" if kinds == {"sprite"} else "edit" if kinds == {"composite"} else "mixed"
    observations = raw.get("observations") if isinstance(raw.get("observations"), list) else []
    return {"intent": intent, "image_count": len(jobs), "jobs": jobs, "ops": [op for job in jobs for op in job["ops"]], "confidence": min(1, max(0, confidence)), "reason": reason or f"按用户需求拆分为 {len(jobs)} 项独立产出", "question": str(raw.get("question") or "请补充你希望各项产出如何处理")[:300] if confirmation else "", "needs_confirmation": confirmation, "requires_image": False, "model_used": True, "variants": 1, "observations": [item[:240] for item in observations if isinstance(item, str)][:6], "options": options}
