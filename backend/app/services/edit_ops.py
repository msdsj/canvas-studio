"""编辑操作模型（Intent DSL 的落地形态）与产出预估。

一次编辑请求 = 一组有序的「操作」``EditOp``，每个操作回答三个问题：
**改哪里**（归一化选区）、**怎么改**（能力 id）、**改成什么**（该区域的指令）。

本模块负责：
1. 把来自前端 / LLM / 旧版接口的多种输入形态**归一化**为统一的操作列表；
2. 结合能力注册表**预估产出**（前端可提前告诉用户会得到几张什么图）；
3. 生成人类可读的操作摘要（用于回复文案与日志）。
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any

from app.services.edit_handlers import (
    OUTPUT_COMPOSITE,
    OUTPUT_SPRITE,
    EditHandler,
    resolve_handler,
)
from app.utils.logging import get_logger

logger = get_logger("app.edit_ops")

# 归一化坐标夹取范围（防止越界导致合成时读到图外像素）
_MIN_SIDE = 0.005
# 单个请求的操作数上限（与前端框选上限一致）
MAX_OPS = 12

_INTENSITIES = {"fine", "rebuild"}


@dataclass
class EditOp:
    """一条编辑操作。"""

    region: dict[str, float]
    """归一化选区 ``{x, y, w, h}``（相对原图宽高，0-1）。"""

    path: list[dict[str, float]] | None = None
    """自由选区（套索）的多边形顶点（归一化）。有值时掩码按多边形裁切，而非包围盒。"""

    handler: str = "restyle"
    """能力 id（见 edit_handlers 注册表）。"""

    prompt: str = ""
    """该区域的修改指令（本地能力可为空）。"""

    intensity: str = "fine"
    """编辑强度：fine=精细修改（保结构）；rebuild=重新生成（可换主体）。"""

    index: int = 0
    """序号（从 1 开始，与前端编号红框一致）。"""

    def to_dict(self) -> dict[str, Any]:
        """序列化为可存储 / 可传输的 dict。"""
        return {
            "index": self.index,
            "region": self.region,
            "path": self.path,
            "handler": self.handler,
            "prompt": self.prompt,
            "intensity": self.intensity,
        }


def clean_region(raw: Any) -> dict[str, float] | None:
    """校验并夹取归一化选区；非法返回 None。"""
    if not isinstance(raw, dict):
        return None
    if not all(key in raw for key in ("x", "y", "w", "h")):
        return None
    try:
        x = min(1.0, max(0.0, float(raw["x"])))
        y = min(1.0, max(0.0, float(raw["y"])))
        w = min(1.0 - x, max(_MIN_SIDE, float(raw["w"])))
        h = min(1.0 - y, max(_MIN_SIDE, float(raw["h"])))
    except (TypeError, ValueError):
        return None
    return {k: round(v, 6) for k, v in (("x", x), ("y", y), ("w", w), ("h", h))}


def clean_path(raw: Any) -> list[dict[str, float]] | None:
    """校验并归一化自由选区多边形。

    只接受 3 个以上顶点的多边形；坐标夹取到 0-1，并去掉连续重复点
    （重复点会让 Pillow 的 polygon 在某些版本上退化）。点数过多时抽稀到
    200 个以内——掩码精度对点数不敏感，但点数爆炸会拖慢渲染。
    """
    if not isinstance(raw, list) or len(raw) < 3:
        return None
    points: list[dict[str, float]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        try:
            x = min(1.0, max(0.0, float(item["x"])))
            y = min(1.0, max(0.0, float(item["y"])))
        except (KeyError, TypeError, ValueError):
            continue
        point = {"x": round(x, 5), "y": round(y, 5)}
        if points and points[-1] == point:
            continue
        points.append(point)
    if len(points) < 3:
        return None
    if len(points) > 200:
        step = len(points) / 200
        points = [points[int(i * step)] for i in range(200)]
    return points


def selection_fingerprint(regions: Any) -> str:
    """选区指纹：几何 + 能力 + 区域提示词的稳定摘要。

    用途：判断「这份计划还是不是针对当前选区算的」。前端用同一算法计算，
    两边不一致就说明选区/指令已经变了，旧计划必须作废而不是继续执行。

    提示词必须纳入：它直接进入上游指令，改了提示词却沿用旧计划，
    用户确认的就不再是「他看到的那份方案」。
    """
    items = regions if isinstance(regions, list) else []
    parts: list[str] = []
    for position, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            continue
        region = item.get("region") if isinstance(item.get("region"), dict) else item
        try:
            index = int(item.get("index") or position)
            x = round(float(region["x"]), 3)
            y = round(float(region["y"]), 3)
            w = round(float(region["w"]), 3)
            h = round(float(region["h"]), 3)
        except (KeyError, TypeError, ValueError):
            continue
        path = item.get("path")
        shape = f"p{len(path)}" if isinstance(path, list) and len(path) >= 3 else "r"
        prompt = str(item.get("prompt") or "").strip()
        parts.append(f"{index}:{x},{y},{w},{h}:{shape}:{str(item.get('handler') or '')}:{prompt}")
    canonical = "|".join(parts)
    # FNV-1a 32bit：跨语言（Python / JS）结果一致，无需依赖加密库
    value = 0x811C9DC5
    for byte in canonical.encode("utf-8"):
        value ^= byte
        value = (value * 0x01000193) & 0xFFFFFFFF
    return f"{value:08x}"


def normalize_ops(
    raw_ops: Any,
    *,
    legacy_regions: Any = None,
    handlers: dict[str, EditHandler] | None = None,
    default_prompt: str = "",
) -> list[EditOp]:
    """把多种输入形态归一化为 ``EditOp`` 列表。

    支持三种来源（按优先级）：
    1. **结构化操作**：``[{region, handler|action, prompt, intensity}, ...]``
    2. **旧版几何选区**：``[{x,y,w,h}, ...]`` → 全部按兜底能力处理（向后兼容）
    3. **无选区**：返回空列表（调用方按「全图编辑」处理）

    :param raw_ops: 结构化操作（前端或 LLM 产出）
    :param legacy_regions: 旧版 ``edit_region``（纯几何列表）
    :param handlers: 能力注册表（用于校验 handler 合法性）
    :param default_prompt: 操作未带指令时的兜底指令
    """
    ops: list[EditOp] = []
    source = raw_ops if isinstance(raw_ops, list) else []
    for item in source:
        if not isinstance(item, dict):
            continue
        region = clean_region(item.get("region") or item)
        if region is None:
            continue
        handler_id = str(item.get("handler") or item.get("action") or "").strip()
        if handlers:
            handler = resolve_handler(handlers, handler_id or None)
            handler_id = handler.id
        elif not handler_id:
            handler_id = "restyle"
        intensity = str(item.get("intensity") or "fine").strip().lower()
        ops.append(
            EditOp(
                region=region,
                handler=handler_id,
                prompt=str(item.get("prompt") or "").strip() or default_prompt,
                intensity=intensity if intensity in _INTENSITIES else "fine",
                index=len(ops) + 1,
            )
        )

    if ops:
        return ops[:MAX_OPS]

    # 向后兼容：旧版纯几何选区 → 全部按兜底能力处理
    legacy = legacy_regions if isinstance(legacy_regions, list) else (
        [legacy_regions] if isinstance(legacy_regions, dict) else []
    )
    for item in legacy:
        region = clean_region(item)
        if region is None:
            continue
        ops.append(
            EditOp(
                region=region,
                handler="restyle",
                prompt=default_prompt,
                index=len(ops) + 1,
            )
        )
    return ops[:MAX_OPS]


def group_by_handler(
    ops: list[EditOp], handlers: dict[str, EditHandler]
) -> "OrderedDict[str, list[EditOp]]":
    """按能力分组（保持首次出现顺序，便于产出顺序稳定）。"""
    grouped: OrderedDict[str, list[EditOp]] = OrderedDict()
    for op in ops:
        handler = resolve_handler(handlers, op.handler)
        grouped.setdefault(handler.id, []).append(op)
    return grouped


@dataclass
class OutputPreview:
    """产出预估条目（供前端在提交前告知用户会得到什么）。"""

    handler: str
    label: str
    kind: str
    count: int
    region_indexes: list[int] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "handler": self.handler,
            "label": self.label,
            "kind": self.kind,
            "count": self.count,
            "region_indexes": self.region_indexes,
        }


def estimate_outputs(ops: list[EditOp], handlers: dict[str, EditHandler]) -> list[OutputPreview]:
    """预估本次请求的产出清单（整图类在前，独立素材类在后）。"""
    previews: list[OutputPreview] = []
    for handler_id, group in group_by_handler(ops, handlers).items():
        handler = resolve_handler(handlers, handler_id)
        count = len(group) if handler.per_region else 1
        previews.append(
            OutputPreview(
                handler=handler.id,
                label=handler.label,
                kind=handler.output,
                count=count,
                region_indexes=[op.index for op in group],
            )
        )
    previews.sort(key=lambda item: 0 if item.kind == OUTPUT_COMPOSITE else 1)
    return previews


def composite_regions(ops: list[EditOp], handlers: dict[str, EditHandler]) -> list[dict[str, float]]:
    """取出所有「整图类」操作涉及的区域（供选区外像素保真的合成使用）。"""
    regions: list[dict[str, float]] = []
    for op in ops:
        handler = resolve_handler(handlers, op.handler)
        if handler.output == OUTPUT_COMPOSITE:
            regions.append(op.region)
    return regions


def upstream_ops(ops: list[EditOp], handlers: dict[str, EditHandler]) -> list[EditOp]:
    """取出需要调用上游的整图类操作。"""
    from app.services.edit_handlers import ENGINE_UPSTREAM

    result: list[EditOp] = []
    for op in ops:
        handler = resolve_handler(handlers, op.handler)
        if handler.engine == ENGINE_UPSTREAM and handler.output == OUTPUT_COMPOSITE:
            result.append(op)
    return result


def sprite_ops(ops: list[EditOp], handlers: dict[str, EditHandler]) -> list[EditOp]:
    """取出需要本地抠图产出独立素材的操作。"""
    return [
        op for op in ops if resolve_handler(handlers, op.handler).output == OUTPUT_SPRITE
    ]


def build_instruction(ops: list[EditOp], handlers: dict[str, EditHandler]) -> str:
    """把一组操作合并为上游可读的分点指令（区域编号与红框编号严格对应）。"""
    parts: list[str] = []
    for op in ops:
        handler = resolve_handler(handlers, op.handler)
        prompt = op.prompt.strip()
        if handler.prompt_prefix:
            prompt = f"{handler.prompt_prefix}{(' ' + prompt) if prompt else ''}"
        if not prompt:
            prompt = handler.description
        parts.append(f"【区域{op.index}】{prompt}")
    return "\n".join(parts)


def summarize_ops(ops: list[EditOp], handlers: dict[str, EditHandler]) -> str:
    """生成人类可读的操作摘要，如「区域1 改样式；区域2、3 抠出为透明素材」。"""
    parts: list[str] = []
    for handler_id, group in group_by_handler(ops, handlers).items():
        handler = resolve_handler(handlers, handler_id)
        indexes = "、".join(str(op.index) for op in group)
        parts.append(f"区域{indexes} {handler.label}")
    return "；".join(parts)


def previews_to_text(previews: list[OutputPreview]) -> str:
    """产出预估的中文描述（用于回复文案）。"""
    if not previews:
        return ""
    chunks: list[str] = []
    for item in previews:
        kind = "完整修改图" if item.kind == OUTPUT_COMPOSITE else "透明背景素材"
        chunks.append(f"{kind} × {item.count}" if item.count > 1 else kind)
    return "、".join(chunks)
