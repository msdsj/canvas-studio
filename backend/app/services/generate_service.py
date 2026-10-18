"""生成编排服务：生图 / 编辑任务的创建与后台执行。

- 幂等去重、并发上限、预扣→上游→确认/回滚统一在此收口；
- 上游由网关负责（含 Demo 降级）；结果落资产库；
- 编辑任务按「AI 意图分析 + gpt-image-2 逐任务处理」编排：
  所有图片处理（包括抠图）都由 gpt-image-2 完成，后端不做本地图片处理。

新流程（skill: image-edit-flow）
------------------------------
1. 用户标记 → 涂鸦 + 框选 + 填写需求
2. 对话分析 → 完善提示词，判断需要几张图
3. gpt-image-2 → 逐任务调用，所有处理都由 GPT 完成
4. 返回结果 → 不做任何本地后处理
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.generation import GenerationTask
from app.services import (
    asset_service,
    config_service,
    cutout_service,
    gateway_client as gw_module,
    storage_service,
    task_service,
)
from app.services import edit_handlers as handlers_module
from app.services import edit_ops as ops_module
from app.services import edit_prompt_service
from app.services.edit_handlers import (
    ENGINE_UPSTREAM,
    OUTPUT_COMPOSITE,
    OUTPUT_SPRITE,
    EditHandler,
    load_handlers,
    resolve_handler,
)
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger
from app.utils.ids import new_id

logger = get_logger("app.generate_service")


async def resolve_cost(db: AsyncSession, task_type: str, quality: str = "standard") -> int:
    """按类型/质量解析单价。"""
    prices = await config_service.prices(db)
    if task_type == "edit":
        return int(prices["edit"])
    if quality == "hd":
        return int(prices["image_hd"])
    return int(prices["image_standard"])


async def create_image_task(
    db: AsyncSession,
    user_id: str,
    *,
    prompt: str,
    model: str,
    size: str,
    quality: str,
    n: int,
    session_id: str | None,
    canvas_id: str | None,
    idempotency_key: str,
    extra: dict[str, Any] | None = None,
) -> tuple[GenerationTask, bool]:
    """创建文生图任务（幂等）。"""
    # 一次出 N 张就按 N 张计费：只按质量档计价会让「一次要 4 张」变成白送。
    unit = await resolve_cost(db, "generate", quality)
    cost = unit * max(1, min(int(n or 1), 4))
    params = {"model": model, "size": size, "quality": quality, "n": n}
    if extra:
        params.update(extra)
    return await task_service.create_or_get(
        db, user_id, idempotency_key, "generate", prompt, params, cost, session_id, canvas_id
    )


async def create_edit_task(
    db: AsyncSession,
    user_id: str,
    *,
    prompt: str,
    model: str,
    size: str,
    base_image_url: str,
    session_id: str | None,
    canvas_id: str | None,
    idempotency_key: str,
    mask_url: str | None = None,
    edit_region: dict[str, float] | None = None,
    edit_ops: list[dict[str, Any]] | None = None,
    edit_mode: str | None = None,
    edit_intensity: str | None = None,
    extra: dict[str, Any] | None = None,
) -> tuple[GenerationTask, bool]:
    """创建编辑任务（幂等）。

    计费规则：**所有编辑操作都走上游图像模型（gpt-image-2）并按编辑单价计费**，
    包括抠图与透明化。平台只做选区计算与文件封装，不做任何本地像素处理。
    一次提交只调用一次上游（多区域合并为一条带编号的指令），因此只计一次编辑单价。

    :param edit_ops: 结构化编辑操作（能力注册表驱动的 Intent DSL）
    :param edit_region: 旧版纯几何选区（向后兼容，等价于全部按兜底能力处理）
    """
    handlers = await load_handlers(db)
    normalized_ops = ops_module.normalize_ops(
        edit_ops, legacy_regions=edit_region, handlers=handlers, default_prompt=prompt
    )
    # 自由选区（套索/画笔）的多边形要在**入参这一步**就补回到操作上，
    # 否则落库的 params["ops"] 只剩包围盒，执行时无论如何都还原不出真实轮廓。
    _attach_paths(normalized_ops, edit_ops)
    # 计费 = 编辑单价 × 上游调用次数 × 每张的版本数。
    # variants（用户要「两张」时走这条路）会真的让上游出 N 张，
    # 只按调用次数收钱等于平台自己贴一次成本。
    sprite_count = sum(
        1
        for op in normalized_ops
        if resolve_handler(handlers, op.handler).output == OUTPUT_SPRITE
    )
    composite_count = len(normalized_ops) - sprite_count
    calls = (1 if composite_count > 0 else 0) + sprite_count
    variants = max(1, min(int((extra or {}).get("n") or 1), 4))
    cost = await resolve_cost(db, "edit") * max(1, calls) * variants

    params: dict[str, Any] = {
        "model": model,
        "size": size,
        "quality": "standard",
        "n": 1,
        "base_image_url": base_image_url,
    }
    if mask_url:
        params["mask_url"] = mask_url
    if normalized_ops:
        params["ops"] = [op.to_dict() for op in normalized_ops]
        params["region"] = [op.region for op in normalized_ops]
        params["outputs"] = [
            item.to_dict() for item in ops_module.estimate_outputs(normalized_ops, handlers)
        ]
    if edit_mode:
        params["edit_mode"] = edit_mode
    if edit_intensity:
        params["edit_intensity"] = edit_intensity
    if extra:
        params.update(extra)
    return await task_service.create_or_get(
        db, user_id, idempotency_key, "edit", prompt, params, cost, session_id, canvas_id
    )


def _decode_b64(data: str) -> bytes:
    """解码 base64（容忍 data URL 前缀）。"""
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    return base64.b64decode(data)


def to_png(raw: bytes) -> bytes:
    """把任意上游图片字节归一化为 PNG（平台对外统一 PNG 输出）。

    - 已是 PNG 则原样返回，避免无谓重编码导致体积膨胀；
    - JPEG/WEBP 等转 PNG 时保留 alpha 通道（有透明则 RGBA，否则 RGB）；
    - 解码失败时退回原始字节，保证任务不因转码而失败。
    """
    try:
        with Image.open(io.BytesIO(raw)) as img:
            if (img.format or "").upper() == "PNG":
                return raw
            has_alpha = img.mode in ("RGBA", "LA", "P")
            out = img.convert("RGBA" if has_alpha else "RGB")
            buf = io.BytesIO()
            out.save(buf, format="PNG", optimize=True)
            return buf.getvalue()
    except Exception:  # noqa: BLE001 - 转码失败不阻断主流程
        logger.warning("图片转 PNG 失败，使用原始字节")
        return raw


def _local_bytes(url: str) -> tuple[bytes, str]:
    """把本地存储 URL 读取为字节。"""
    rel = asset_service.local_path_from_url(url)
    if not rel:
        raise AppError(ErrorCode.VALIDATION_ERROR, "仅支持本地存储的参考图")
    path = Path(storage_service.storage_root()) / rel
    if not path.exists():
        raise AppError(ErrorCode.NOT_FOUND, "参考图文件不存在")
    return path.read_bytes(), path.suffix.lstrip(".") or "png"


async def run_task(task_id: str) -> None:
    """后台执行生成任务（独立会话）。"""
    async with AsyncSessionLocal() as db:
        task = (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one_or_none()
        if task is None or task.status != "running":
            return

        await task_service.mark_progress(db, task_id, 30)
        await db.commit()

        try:
            if task.type == "edit":
                result = await _run_edit_task(db, task)
            else:
                raw = await _call_generate(task)
                result = {"images": _result_bytes(raw), "demo": bool(raw.get("demo"))}
        except AppError as exc:
            await task_service.fail_and_refund(db, task_id, exc.code.value, exc.message)
            logger.warning("任务 %s 失败: %s", task_id, exc.message)
            return
        except Exception:  # noqa: BLE001
            # 异常串里带 httpx 内网 URL / 类名，绝不落库给用户看，只进日志
            await task_service.fail_and_refund(
                db, task_id, ErrorCode.UPSTREAM_ERROR.value, "图片没生成出来，额度已经退回"
            )
            logger.exception("任务 %s 异常", task_id)
            return

        demo = bool(result.get("demo"))
        images: list[bytes] = result.get("images") or []
        if not images:
            await task_service.fail_and_refund(
                db, task_id, ErrorCode.UPSTREAM_ERROR.value, "这次没有生成出图片，额度已退回"
            )
            return

        urls: list[str] = []
        total = len(images)
        for index, raw in enumerate(images, start=1):
            # 平台统一 PNG 输出：无论来源是上游、本地抠图还是合成，落库前一律归一化为 PNG
            normalized = to_png(raw)
            # to_png 在解码失败时会原样返回原始字节——这里必须拦住，
            # 否则损坏的图会以「已完成」的身份落库，用户看到的是破图。
            if not normalized.startswith(b"\x89PNG\r\n\x1a\n"):
                await task_service.fail_and_refund(
                    db, task_id, ErrorCode.UPSTREAM_ERROR.value, "返回的图片已损坏，额度已退回"
                )
                return
            filename = "result.png" if total == 1 else f"result-{index}.png"
            asset = await asset_service.create_from_bytes(
                db,
                task.user_id,
                normalized,
                kind="generated",
                filename=filename,
                content_type="image/png",
                prompt=task.prompt,
                is_demo=demo,
                generation_task_id=task.id,
            )
            urls.append(asset.url)

        await task_service.succeed(db, task_id, urls, demo=demo)


async def _run_edit_task(db: AsyncSession, task: GenerationTask) -> dict[str, Any]:
    """图片编辑执行：按「整图类 / 素材类」拆分调用上游。

    产出契约（与产品口径一致）：
    - 整图类区域（改样式/挖空/去物/增强）合并为 **1 次调用**，带并集掩码，产出 1 张修改图；
    - 素材类区域（抠图）**每个区域各 1 次调用**，各带自己的掩码，产出 N 张透明素材；
    - 顺序固定「先整图、后素材」，与前端预览的产出顺序一致。

    每次调用都带三件套：
    ① 纯原图（唯一像素来源，不画任何标记，避免标记被画进结果）；
    ② 引导图（只标出本次要改的区域，编号与指令一致）；
    ③ 标准 inpainting 掩码（仅目标区域透明 → 上游被物理约束在这一块内作画）。
    """
    base_url = task.params.get("base_image_url")
    if not base_url:
        raise AppError(ErrorCode.VALIDATION_ERROR, "缺少参考图")

    base_bytes, _ext = _local_bytes(str(base_url))
    handlers = await load_handlers(db)
    raw_ops = task.params.get("ops") or []
    parsed_ops = ops_module.normalize_ops(
        raw_ops,
        legacy_regions=task.params.get("region"),
        handlers=handlers,
        default_prompt=task.prompt,
    )
    # 自由选区（套索/画笔）的真实轮廓只存在于原始 payload 里，归一化时会被丢掉；
    # 掩码与引导图需要它才不至于退化成矩形，这里按几何把 path 补回去。
    _attach_paths(parsed_ops, raw_ops)
    global_prompt = str(task.params.get("optimized_prompt") or task.prompt or "").strip()
    variants = max(1, min(int(task.params.get("n") or 1), 4))

    thinking: list[str] = ["收到图片与选区，正在读你的需求…"]
    await _push_thinking(db, task, thinking)
    await task_service.mark_progress(db, task.id, 35)

    # 没有结构化选区（老接口 / 纯整图编辑）：一次调用，按原图 + 全局指令执行
    if not parsed_ops:
        thinking.append("这次没有选区，按整图修改提交")
        await _push_thinking(db, task, thinking)
        result = await _call_whole_image(task, base_bytes, global_prompt, variants)
        thinking.append("生成完成，正在整理结果…")
        await _push_thinking(db, task, thinking)
        return {"images": _result_bytes(result), "demo": bool(result.get("demo"))}

    composite_ops = [
        op
        for op in parsed_ops
        if resolve_handler(handlers, op.handler).output != OUTPUT_SPRITE
    ]
    sprite_ops = [
        op
        for op in parsed_ops
        if resolve_handler(handlers, op.handler).output == OUTPUT_SPRITE
    ]
    calls = (1 if composite_ops else 0) + len(sprite_ops)
    thinking.append(
        f"拆成 {calls} 次处理：{len(composite_ops)} 处整图修改、{len(sprite_ops)} 处独立素材"
    )
    await _push_thinking(db, task, thinking)

    images: list[bytes] = []
    demo = False
    failures: list[int] = []

    # ① 整图类：合并成一次调用（省时省钱，且多处修改风格一致）
    if composite_ops:
        instruction = ops_module.build_instruction(composite_ops, handlers)
        prompt = _compose_prompt(global_prompt, instruction, sprite=False)
        try:
            result = await _call_edit_ops(
                task, base_bytes, composite_ops, prompt, variants=variants
            )
            demo = demo or bool(result.get("demo"))
            images.extend(_result_bytes(result)[:variants])
            thinking.append("整图修改完成")
        except Exception:  # noqa: BLE001 - 单段失败不拖垮其它区域
            logger.exception("整图修改调用失败 task=%s", task.id)
            failures.extend(op.index for op in composite_ops)
            thinking.append("整图修改这段没成功")
        await _push_thinking(db, task, thinking)
        await task_service.mark_progress(db, task.id, 60)

    # ② 素材类：每个区域单独一次调用（并发上限由配置夹取）
    if sprite_ops:
        concurrency = 3
        try:
            concurrency = int(
                await config_service.get_value(db, "EDIT_CONCURRENCY", 3) or 3
            )
        except Exception:  # noqa: BLE001 - 配置异常用默认值
            concurrency = 3
        semaphore = asyncio.Semaphore(max(1, min(concurrency, 6)))

        async def run_sprite(op: ops_module.EditOp) -> tuple[int, bytes | None, bool]:
            async with semaphore:
                handler = resolve_handler(handlers, op.handler)
                prompt = _compose_prompt(global_prompt, ops_module.build_instruction([op], handlers), sprite=True)
                if handler.prompt_prefix:
                    prompt = f"{handler.prompt_prefix}\n{prompt}"
                try:
                    # 素材类**不用全局掩码**：这次调用只处理这一个区域，
                    # 用前端那张「所有选区并集」的掩码会把别的区域也一起交给上游。
                    result = await _call_edit_ops(
                        task, base_bytes, [op], prompt, variants=1, use_uploaded_mask=False
                    )
                    found = _result_bytes(result)
                    return op.index, (found[0] if found else None), bool(result.get("demo"))
                except Exception:  # noqa: BLE001 - 单区域失败不影响其它区域
                    logger.exception("素材区域 %s 调用失败 task=%s", op.index, task.id)
                    return op.index, None, False

        outcomes = await asyncio.gather(*(run_sprite(op) for op in sprite_ops))
        for index, raw, is_demo in outcomes:
            demo = demo or is_demo
            if raw:
                images.append(raw)
            else:
                failures.append(index)
        thinking.append("素材处理完成")
        await _push_thinking(db, task, thinking)

    if failures:
        thinking.append(f"区域 {'、'.join(str(i) for i in failures)} 没成功")
        await _push_thinking(db, task, thinking)

    if not images:
        raise AppError(ErrorCode.UPSTREAM_ERROR, "这次没有生成出图片，额度已退回")

    thinking.append("生成完成，正在整理结果…")
    await _push_thinking(db, task, thinking)
    return {"images": images, "demo": demo}


def _compose_prompt(global_prompt: str, instruction: str, *, sprite: bool) -> str:
    """拼装单次调用的上游指令：全局约束 + 本次区域指令 + 执行注意。"""
    head = "\n".join(part for part in (global_prompt, instruction) if part).strip()
    if sprite:
        tail = (
            "只输出红框/选区内的主体，纯透明背景（alpha 通道），"
            "主体内容、细节、颜色、光影与原图完全一致；不重绘、不美化、不加背景或阴影；"
            "不要画出红框、编号或任何标注。"
        )
    else:
        tail = (
            "第一张 image 是唯一的像素来源；第二张 image 只标出要改的位置，"
            "严格忽略其中的红框、编号与涂鸦，不得把任何标注绘制到结果中；"
            "只修改 mask 透明区域，mask 外的像素保持原样，衔接处自然过渡。"
        )
    return f"{head}\n{tail}" if head else tail


async def _call_whole_image(
    task: GenerationTask, base_bytes: bytes, prompt: str, variants: int
) -> dict[str, Any]:
    """无选区的整图编辑：原图 + 指令，一次调用。"""
    files: list[tuple[str, tuple[str, bytes, str]]] = [
        ("image", ("base.png", base_bytes, "image/png")),
    ]
    form = {
        "prompt": prompt or "按照描述修改这张图片",
        "model": task.params.get("model", "gpt-image-2"),
        "size": task.params.get("size", "1024x1024"),
        "quality": task.params.get("quality", "standard"),
        "n": variants,
        "response_format": "b64_json",
    }
    return await gw_module.gateway_client.image_edits(files, form)


async def _call_edit_ops(
    task: GenerationTask,
    base_bytes: bytes,
    ops: list[ops_module.EditOp],
    prompt: str,
    *,
    variants: int = 1,
    use_uploaded_mask: bool = True,
) -> dict[str, Any]:
    """一次上游调用：纯原图 + 本次区域引导图 + 本次区域并集掩码。

    :param use_uploaded_mask: 是否允许使用前端上行的并集掩码。
        整图类调用用 True（多处选区一次重绘，前端掩码包含画笔/套索的真实形状）；
        **素材类（per-region）必须用 False**——每个区域各调用一次，
        拿全局并集掩码等于让上游把其它区域也一起处理，
        产出会从「这一块主体」变成「整张图去掉其它区域」。
    """
    mask_bytes, mask_source = _resolve_mask_bytes(
        task, base_bytes, ops, use_uploaded_mask=use_uploaded_mask
    )
    logger.info(
        "编辑掩码来源=%s task=%s 区域数=%d", mask_source, task.id, len(ops)
    )
    files: list[tuple[str, tuple[str, bytes, str]]] = [
        ("image", ("base.png", base_bytes, "image/png")),
        ("image", ("edit-guide.png", _render_ops_guide(base_bytes, ops), "image/png")),
        ("mask", ("mask.png", mask_bytes, "image/png")),
    ]
    form = {
        "prompt": prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "size": task.params.get("size", "1024x1024"),
        "quality": task.params.get("quality", "standard"),
        "n": max(1, min(variants, 4)),
        "response_format": "b64_json",
    }
    return await gw_module.gateway_client.image_edits(files, form)


def _resolve_mask_bytes(
    task: GenerationTask,
    base_bytes: bytes,
    ops: list[ops_module.EditOp],
    *,
    use_uploaded_mask: bool = True,
) -> tuple[bytes, str]:
    """解析本次调用要用的 inpainting 掩码，并返回来源（uploaded / generated）。

    优先使用前端上行的并集掩码：前端把矩形、套索多边形、画笔笔迹合成一张图，
    形状精度远高于后端按包围盒重算的版本（矩形化的掩码会让上游把整块区域重绘，
    这正是「画笔/套索选得再准也没用」的根因）。

    读取或解析失败时**不报错**，而是回退到自动生成的掩码：
    掩码是内部实现细节，不该因为一个附件损坏就让整单编辑失败。
    """
    if use_uploaded_mask:
        mask_url = task.params.get("mask_url")
        if mask_url:
            uploaded = _load_uploaded_mask(str(mask_url), base_bytes)
            if uploaded is not None:
                return uploaded, "uploaded"
    return _render_ops_mask(base_bytes, ops), "generated"


def _load_uploaded_mask(mask_url: str, base_bytes: bytes) -> bytes | None:
    """读取前端上行的掩码并归一化到原图尺寸（透明=可编辑，不透明=保留）。

    :return: PNG 字节；URL 无法解析 / 文件缺失 / 图片损坏时返回 None（由调用方回退）
    """
    try:
        raw, _ext = _local_bytes(mask_url)
        with Image.open(io.BytesIO(raw)) as source:
            mask = source.convert("RGBA")
        with Image.open(io.BytesIO(base_bytes)) as base:
            target_size = base.size
        if mask.size != target_size:
            # 上游要求 mask 与底图同尺寸；尺寸不一致时以底图为准重采样
            mask = mask.resize(target_size, Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        mask.save(buffer, format="PNG")
        return buffer.getvalue()
    except Exception:  # noqa: BLE001 - 掩码不可用不应阻断编辑
        logger.warning("前端掩码不可用，回退到自动生成掩码 mask_url=%s", mask_url, exc_info=True)
        return None


def _region_key(region: dict[str, Any]) -> str:
    """选区几何指纹（与 ``clean_region`` 的取整精度一致），用于回填 path 时对齐。"""
    return ",".join(f"{float(region.get(key) or 0.0):.6f}" for key in ("x", "y", "w", "h"))


def _attach_paths(
    ops: list[ops_module.EditOp], raw_ops: Any
) -> None:
    """把原始操作里的自由选区多边形补回到规范化操作上。

    ``normalize_ops`` 只保留包围盒，套索 / 画笔的真实轮廓会在归一化时丢失，
    自动生成的掩码因此退化成矩形（上游会把整块矩形区域重绘）。
    前端上行的掩码缺失时（接口直连、素材类单区域调用）就靠这里恢复精度。

    按**几何指纹**对齐而不是按数组下标：``normalize_ops`` 会过滤非法项并截断，
    下标并不保证一一对应，按顺序回填可能把 A 的轮廓安到 B 上。
    """
    if not isinstance(raw_ops, list):
        return
    by_region: dict[str, list[dict[str, float]]] = {}
    for item in raw_ops:
        if not isinstance(item, dict):
            continue
        path = ops_module.clean_path(item.get("path"))
        region = ops_module.clean_region(item.get("region") or item)
        if not path or region is None:
            continue
        by_region[_region_key(region)] = path
    if not by_region:
        return
    for op in ops:
        op.path = by_region.get(_region_key(op.region))


def _op_points(op: ops_module.EditOp, width: int, height: int) -> list[tuple[int, int]]:
    """选区顶点（像素坐标）：自由选区按多边形，矩形按四角。"""
    if op.path:
        return [
            (
                max(0, min(width - 1, round(point["x"] * (width - 1)))),
                max(0, min(height - 1, round(point["y"] * (height - 1)))),
            )
            for point in op.path
        ]
    x, y, w, h = cutout_service.region_to_pixels(op.region, width, height)
    return [(x, y), (x + w - 1, y), (x + w - 1, y + h - 1), (x, y + h - 1)]


def _render_ops_mask(base_bytes: bytes, ops: list[ops_module.EditOp]) -> bytes:
    """并集掩码：所有待编辑区域透明，其余不透明（标准 inpainting 语义）。"""
    image = Image.open(io.BytesIO(base_bytes)).convert("RGBA")
    width, height = image.size
    alpha = Image.new("L", (width, height), 255)
    draw = ImageDraw.Draw(alpha)
    for op in ops:
        draw.polygon(_op_points(op, width, height), fill=0)
    image.putalpha(alpha)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _render_ops_guide(base_bytes: bytes, ops: list[ops_module.EditOp]) -> bytes:
    """引导图：原图 + 本次区域的描边与编号（只标本次，不标其它区域）。"""
    image = Image.open(io.BytesIO(base_bytes)).convert("RGB")
    width, height = image.size
    draw = ImageDraw.Draw(image)
    line_width = max(3, round(min(width, height) / 220))
    for op in ops:
        points = _op_points(op, width, height)
        if len(points) < 3:
            continue
        closed = points + [points[0]]
        # 白色外层打底 + 红色内层：浅色/深色/花色背景都清晰
        draw.line(closed, fill=(255, 255, 255), width=line_width * 3, joint="curve")
        draw.line(closed, fill=(220, 38, 38), width=line_width, joint="curve")
        xs = [point[0] for point in points]
        ys = [point[1] for point in points]
        x, y = min(xs), min(ys)
        w, h = max(xs) - x + 1, max(ys) - y + 1
        _draw_label_badge(draw, op.index, x, y, w, h, width, height, line_width)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


async def _push_thinking(
    db: AsyncSession,
    task: GenerationTask,
    steps: list[str],
    extra: dict[str, Any] | None = None,
) -> None:
    """把思考过程写回任务参数。

    用显式 UPDATE 而不是「改属性 + commit」：任务对象可能由另一个会话加载，
    ORM 的脏检查在这种情况下会静默跳过，导致只有第一步能落库。
    """
    params = {**(task.params or {}), **(extra or {}), "thinking": steps}
    try:
        await db.execute(
            update(GenerationTask).where(GenerationTask.id == task.id).values(params=params)
        )
        await db.commit()
        task.params = params
    except Exception:  # noqa: BLE001 - 记录思考过程失败不影响生成
        logger.exception("写入思考过程失败 task=%s", task.id)
        await db.rollback()


async def _analyze_edit_intent(
    task: GenerationTask,
    ops: list[ops_module.EditOp],
    handlers: dict[str, EditHandler],
    global_prompt: str,
    concurrency: int,
) -> dict[int, tuple[bytes | None, bool]]:
    """并发调用上游：每个区域一次独立请求（各自带该区域的 inpainting 掩码）。

    单区域失败不影响其它区域（该项返回 None），是否整体失败由调用方判定。
    并发数由 ``EDIT_CONCURRENCY`` 控制并夹取到 1~6，避免打爆上游号池。
    """
    if not ops:
        return {}
    limit = max(1, min(int(concurrency or 1), 6))
    semaphore = asyncio.Semaphore(limit)

    async def run_one(op: ops_module.EditOp) -> tuple[int, bytes | None, bool]:
        async with semaphore:
            try:
                result = await _call_edit_region(task, op, handlers, global_prompt)
                raw_images = _result_bytes(result)
                return op.index, (raw_images[0] if raw_images else None), bool(result.get("demo"))
            except Exception:  # noqa: BLE001 - 单区域失败不拖垮整单
                logger.exception("区域 %s 上游调用失败", op.index)
                return op.index, None, False

    outcomes = await asyncio.gather(*(run_one(op) for op in ops))
    return {index: (raw, demo) for index, raw, demo in outcomes}


async def _call_edit_region(
    task: GenerationTask,
    op: ops_module.EditOp,
    handlers: dict[str, EditHandler],
    global_prompt: str,
) -> dict[str, Any]:
    """单区域编辑调用。

    - ``image``：**纯原图**（不画红框，避免标记被画进结果）；
    - ``mask``：标准 inpainting 掩码，仅该区域透明 —— 这是「只改选中区域」的真正约束；
    - ``prompt``：全局模板 + 该区域指令。
    """
    base_url = task.params.get("base_image_url")
    base_bytes, _ = _local_bytes(str(base_url))

    instruction = ops_module.build_instruction([op], handlers)
    prompt = f"{global_prompt}\n{instruction}" if global_prompt else instruction
    prompt = (
        f"{prompt}\n"
        "第一张 image 是唯一的像素来源；第二张 image 只是选区/涂鸦参考图。"
        "严格忽略参考图中的红框、编号和涂鸦，不得把任何标注绘制到结果中；"
        "只修改 mask 透明区域，mask 外的像素保持原样。"
    )

    files: list[tuple[str, tuple[str, bytes, str]]] = [
        # 第一张 image 必须是像素来源的纯底图：不画任何标记，避免标记被画进结果
        ("image", ("base.png", base_bytes, "image/png")),
        # 引导图：只标出本次要改的这一个区域（多区域拆分调用时不会互相干扰）
        ("image", ("edit-guide.png", _render_region_guide(base_bytes, op), "image/png")),
        # 标准 inpainting 掩码：仅该区域透明 → 上游被物理约束在这一块内作画
        ("mask", ("mask.png", _render_edit_mask(base_bytes, op), "image/png")),
    ]
    form = {
        "prompt": prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "size": task.params.get("size", "1024x1024"),
        "quality": task.params.get("quality", "standard"),
        "n": max(1, min(int(task.params.get("n", 1) or 1), 4)),
        "response_format": "b64_json",
    }
    return await gw_module.gateway_client.image_edits(files, form)


def _result_bytes(result: dict[str, Any]) -> list[bytes]:
    """从网关返回中提取所有图片的原始字节。"""
    out: list[bytes] = []
    for item in result.get("data") or []:
        b64 = item.get("b64_json") or item.get("b64")
        if b64:
            out.append(_decode_b64(b64))
    return out


async def _call_generate(task: GenerationTask) -> dict[str, Any]:
    """调用网关文生图。"""
    payload = {
        "prompt": task.prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "n": int(task.params.get("n", 1)),
        "size": task.params.get("size", "1024x1024"),
        "quality": task.params.get("quality", "standard"),
        "response_format": "b64_json",
    }
    return await gw_module.gateway_client.image_generations(payload)


async def _analyze_edit_intent(
    db: AsyncSession,
    task: GenerationTask,
    ops: list[ops_module.EditOp],
    handlers: dict[str, EditHandler],
) -> dict[str, Any]:
    """调用对话中转站分析用户的编辑意图。

    输入：用户标记的多个区域及其需求描述
    输出：结构化的任务列表，每个任务包含完善后的提示词和区域索引

    返回格式：
    {
        "tasks": [
            {
                "type": "edit" | "cutout",
                "prompt": "完善后的详细提示词",
                "region_index": 1,
                "description": "简短说明"
            }
        ],
        "total_images": 2
    }
    """
    # 构建用户需求描述
    regions_desc = []
    for index, op in enumerate(ops, start=1):
        handler = resolve_handler(handlers, op.handler)
        regions_desc.append(
            f"区域{index}（{handler.label}）：{op.prompt.strip() or '（未描述）'}"
        )

    user_message = "用户在一张图片上标记了以下区域并描述了需求：\n\n" + "\n".join(regions_desc)

    system_prompt = """你是图片编辑需求分析专家。用户在一张图片上标记了多个区域并描述了需求。

你的任务：
1. 分析每个区域的真实需求
2. 为每个需求生成详细的、适合 gpt-image-2 的提示词
3. 判断需要生成几张独立的图片

注意：
- 抠图需求：提示词应该是"精确抠出红色框选和涂鸦标记的区域，生成透明背景的PNG图片"
- 修改需求：提示词应该保持原图布局，只修改指定区域，其他地方不变
- 换背景、改文字、改颜色都属于 edit 类型
- 提取、抠图、去背景属于 cutout 类型

返回 JSON 格式：
{
  "tasks": [
    {
      "type": "edit" | "cutout",
      "prompt": "详细提示词",
      "region_index": 区域编号（从1开始）,
      "description": "简短说明"
    }
  ],
  "total_images": 数量
}"""

    try:
        result = await gw_module.gateway_client.llm_completions({
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_message}
            ],
            "response_format": {"type": "json_object"}
        })

        content = result["choices"][0]["message"]["content"]
        analysis = json.loads(content)
        logger.info("对话分析完成：%d 个任务", len(analysis.get("tasks", [])))
        return analysis

    except Exception as exc:  # noqa: BLE001
        logger.warning("对话分析失败: %s，降级为用户原始提示词", exc)
        # 降级：为每个 op 生成一个简单任务
        return {
            "tasks": [
                {
                    "type": "cutout" if resolve_handler(handlers, op.handler).output == OUTPUT_SPRITE else "edit",
                    "prompt": op.prompt.strip() or f"处理区域{index}",
                    "region_index": index,
                    "description": op.prompt.strip() or "用户需求"
                }
                for index, op in enumerate(ops, start=1)
            ],
            "total_images": len(ops)
        }


async def _call_edit_with_mask(
    task: GenerationTask,
    mask_bytes: bytes,
    prompt: str,
) -> dict[str, Any]:
    """调用 gpt-image-2 处理单个区域（带 mask 约束）。

    参数：
    - task: 任务对象（包含 base_image_url 和 guide_url）
    - mask_bytes: 该区域的 mask（透明 = 要修改，不透明 = 保留）
    - prompt: 完善后的提示词
    """
    base_url = task.params.get("base_image_url")
    base_bytes, ext = _local_bytes(str(base_url))
    mime = "image/png" if ext.lower() == "png" else f"image/{ext}"

    files: list[tuple[str, tuple[str, bytes, str]]] = []

    # 优先使用用户标注图（带涂鸦和红框）
    guide_url = task.params.get("guide_url")
    if guide_url:
        guide_bytes, guide_ext = _local_bytes(str(guide_url))
        guide_mime = "image/png" if guide_ext.lower() == "png" else f"image/{guide_ext}"
        files.append(("image", (f"marked.{guide_ext}", guide_bytes, guide_mime)))
        logger.info("使用用户标注图 (%d bytes)", len(guide_bytes))
    else:
        files.append(("image", (f"base.{ext}", base_bytes, mime)))
        logger.warning("未提供标注图，使用原图")

    # 添加 mask
    files.append(("mask", ("mask.png", mask_bytes, "image/png")))

    form = {
        "prompt": prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "size": task.params.get("size", "1024x1024"),
        "response_format": "b64_json",
    }

    return await gw_module.gateway_client.image_edits(files, form)


async def _call_edit(
    task: GenerationTask,
    *,
    handlers: dict[str, EditHandler] | None = None,
    ops: list[ops_module.EditOp] | None = None,
    global_prompt: str = "",
) -> dict[str, Any]:
    """把「带标注的底图 + 分点提示词」**一次**提交上游。

    用户的模型很简单：框选/涂鸦标出要改的地方 → 这张标注过的图 + 提示词一起发给 GPT。
    所以这里不做按区域拆分调用：**一次编辑 = 一次请求**。

    核心策略（适配 GPT-4 vision 能力）：
    - ``image`` ①：**用户标注后的完整图片**（原图 + 涂鸦 + 红框），这是 GPT 理解「改哪里」的关键
    - ``image`` ②（可选）：纯净原图作为像素参考
    - ``mask``：标准 inpainting 掩码（需要修改的区域透明，确保精确控制编辑范围）
    - ``prompt``：分点指令 + 约束说明

    **重要**：用户的涂鸦和红框标记必须保留在第一张图片中，否则 AI 完全不知道要改哪里！
    """
    base_url = task.params.get("base_image_url")
    if not base_url:
        raise AppError(ErrorCode.VALIDATION_ERROR, "缺少参考图")
    base_bytes, ext = _local_bytes(base_url)
    mime = "image/png" if ext.lower() == "png" else f"image/{ext}"

    files: list[tuple[str, tuple[str, bytes, str]]] = []

    # 第一张图：用户标注后的完整图片（带涂鸦、红框、编号）
    # 这是 GPT 理解用户意图的唯一视觉输入，必须包含所有标记！
    guide_url = task.params.get("guide_url")
    if guide_url:
        guide_bytes, guide_ext = _local_bytes(str(guide_url))
        guide_mime = "image/png" if guide_ext.lower() == "png" else f"image/{guide_ext}"
        files.append(("image", (f"edit-guide.{guide_ext}", guide_bytes, guide_mime)))
        logger.info("已加载用户标注图（%d bytes），包含涂鸦和红框标记", len(guide_bytes))
    else:
        # 降级：没有 guide 图时使用原图
        files.append(("image", (f"base.{ext}", base_bytes, mime)))
        logger.warning("未提供用户标注图，使用原图（可能导致 AI 无法识别编辑位置）")

    # 第二张图（可选）：纯净原图作为像素来源参考
    # 部分中转站支持多图输入，第一张看标记位置，第二张取原始像素
    # files.append(("image", (f"base-clean.{ext}", base_bytes, mime)))

    # 生成标准 inpainting mask：物理约束编辑范围
    if ops and handlers:
        upstream_regions = [
            op.region for op in ops
            if resolve_handler(handlers, op.handler).engine == ENGINE_UPSTREAM
        ]
        if upstream_regions:
            mask_bytes = _render_union_mask(base_bytes, upstream_regions)
            files.append(("mask", ("mask.png", mask_bytes, "image/png")))
            logger.info("已生成编辑 mask：%d 个区域合并", len(upstream_regions))

    # 构建增强提示词
    if ops and handlers:
        instruction = ops_module.build_instruction(ops, handlers)
        base_instruction = f"{global_prompt}\n{instruction}" if global_prompt else instruction
        prompt = (
            f"{base_instruction}\n\n"
            "重要说明：\n"
            "1. 图片中的红色边框和编号标记了需要修改的位置，编号对应上述各区域的需求描述\n"
            "2. 用户的涂鸦（画笔标记）指示了具体要修改的内容或区域边界\n"
            "3. **仅修改标记的区域**，未标记区域保持完全不变\n"
            "4. **不要将红色边框、编号或涂鸦痕迹绘制到最终结果中**，这些只是给你的视觉指令\n"
            "5. 修改区域与原图的衔接处需要自然过渡"
        )
    else:
        prompt = task.prompt

    form = {
        "prompt": prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "size": task.params.get("size", "1024x1024"),
        "response_format": "b64_json",
    }
    return await gw_module.gateway_client.image_edits(files, form)


def _render_edit_mask(base_bytes: bytes, op: ops_module.EditOp) -> bytes:
    """生成标准 inpainting 掩码：**待编辑区域透明**，其余区域不透明。

    这是「只改选中区域」的真正约束手段。OpenAI `images/edits` 的语义是
    「透明区域 = 要修改，不透明区域 = 保留」。

    此前传给上游的是**不透明的红框标记图**——按标准语义等于告诉上游「整张图都要改」，
    修改位置完全不可控，这正是「框选不精确」的根因。
    """
    image = Image.open(io.BytesIO(base_bytes)).convert("RGBA")
    width, height = image.size
    alpha = Image.new("L", (width, height), 255)  # 255 = 不透明 = 保留
    x, y, w, h = cutout_service.region_to_pixels(op.region, width, height)
    ImageDraw.Draw(alpha).rectangle([x, y, x + w - 1, y + h - 1], fill=0)  # 0 = 透明 = 编辑
    image.putalpha(alpha)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _render_union_mask(base_bytes: bytes, regions: list[dict[str, Any]]) -> bytes:
    """生成多个区域的并集 mask：所有区域合并为一个透明区域。

    用于一次性编辑多个区域时，将所有需要修改的位置合并到一个 mask 中。
    这样上游只需要处理一次请求，就能同时修改多个标记区域。

    :param base_bytes: 原图字节
    :param regions: 归一化区域列表 [{x, y, w, h}, ...]
    :return: PNG 格式的 mask 图片（需要修改的区域透明，其余不透明）
    """
    image = Image.open(io.BytesIO(base_bytes)).convert("RGBA")
    width, height = image.size
    alpha = Image.new("L", (width, height), 255)  # 255 = 不透明 = 保留
    draw = ImageDraw.Draw(alpha)

    for region in regions:
        x, y, w, h = cutout_service.region_to_pixels(region, width, height)
        draw.rectangle([x, y, x + w - 1, y + h - 1], fill=0)  # 0 = 透明 = 编辑

    image.putalpha(alpha)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _render_region_guide(base_bytes: bytes, op: ops_module.EditOp) -> bytes:
    """生成「只标出该区域」的引导图：原图 + 编号红框 + 序号徽章。

    与前端整图引导图的区别：拆分调用时若带上「标了所有区域」的引导图，
    上游会以为其它区域也要改。因此这里按区域单独生成。
    """
    image = Image.open(io.BytesIO(base_bytes)).convert("RGB")
    width, height = image.size
    draw = ImageDraw.Draw(image)
    line_width = max(3, round(min(width, height) / 220))
    x, y, w, h = cutout_service.region_to_pixels(op.region, width, height)
    box = (x, y, x + w - 1, y + h - 1)
    # 白色外层打底 + 红色内层：浅色/深色/花色背景都清晰
    draw.rectangle(box, outline=(255, 255, 255), width=line_width * 3)
    draw.rectangle(box, outline=(220, 38, 38), width=line_width)
    _draw_label_badge(draw, op.index, x, y, w, h, width, height, line_width)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _draw_label_badge(
    draw: Any,
    label: int,
    x: int,
    y: int,
    w: int,
    h: int,
    canvas_width: int,
    canvas_height: int,
    line_width: int,
) -> None:
    """在框内顶部绘制编号徽章（与前端画布上的编号一致）。"""
    font_size = max(
        14,
        min(round(h * 0.26), round(w * 0.14), round(min(canvas_width, canvas_height) / 40)),
    )
    try:
        font = ImageFont.truetype("Arial.ttf", font_size)
    except Exception:  # noqa: BLE001 - 字体缺失时退回位图字体，不影响功能
        font = ImageFont.load_default()
    text = str(label)
    bbox = draw.textbbox((0, 0), text, font=font)
    text_width = bbox[2] - bbox[0]
    box_w = max(text_width + font_size * 0.62, font_size * 1.45)
    box_h = font_size * 1.38
    gap = max(2, round(line_width * 0.8))
    box_y = y + gap if h >= box_h * 2 else y - box_h / 2
    box_x = max(x, min(x + max(0, w - box_w), x + w / 2 - box_w / 2))
    draw.rounded_rectangle(
        (box_x, box_y, box_x + box_w, box_y + box_h),
        radius=min(box_h / 2, 10),
        fill=(220, 38, 38),
        outline=(255, 255, 255),
        width=max(2, round(line_width * 0.7)),
    )
    draw.text(
        (box_x + box_w / 2, box_y + box_h / 2),
        text,
        font=font,
        fill=(255, 255, 255),
        anchor="mm",
    )


def _paste_region(
    base_bytes: bytes, edited_bytes: bytes, region: dict[str, Any]
) -> bytes:
    """把上游结果的该区域贴回底图：区域外逐像素保留底图，内缘羽化过渡。

    即使上游忽略掩码、把整张图重绘了，这里也能保证选区外的像素严格不变。
    """
    try:
        base = Image.open(io.BytesIO(base_bytes)).convert("RGB")
        edited = Image.open(io.BytesIO(edited_bytes)).convert("RGB")
        if edited.size != base.size:
            edited = edited.resize(base.size, Image.LANCZOS)
        width, height = base.size
        x, y, w, h = cutout_service.region_to_pixels(region, width, height)
        soft = Image.new("L", (width, height), 0)
        ImageDraw.Draw(soft).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
        soft = soft.filter(ImageFilter.GaussianBlur(max(2, min(w, h) // 40)))
        inside = Image.new("L", (width, height), 0)
        ImageDraw.Draw(inside).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
        mask = ImageChops.multiply(soft, inside)
        out = Image.composite(edited, base, mask)
        buffer = io.BytesIO()
        out.save(buffer, format="PNG")
        return buffer.getvalue()
    except Exception:  # noqa: BLE001 - 贴回失败时保留底图，不影响其余区域
        logger.exception("区域贴回失败，保留底图")
        return base_bytes


def _has_transparency(image_bytes: bytes) -> bool:
    """判断图片是否真的带透明像素。

    很多第三方中转站会把上游返回的 PNG 重新编码，**丢掉 alpha 通道**，
    于是「抠图」拿到的是带背景的不透明图。这里据此决定是否本地兜底。
    """
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            if img.mode not in ("RGBA", "LA", "P"):
                return False
            low, _high = img.convert("RGBA").getchannel("A").getextrema()
            return low < 250
    except Exception:  # noqa: BLE001 - 读不出来就当作没有透明
        return False


def _crop_to_region(
    image_bytes: bytes,
    region: dict[str, Any],
    *,
    target_size: tuple[int, int] | None = None,
) -> bytes:
    """把上游返回的整图裁到选区范围（素材类产出用：只保留框选内容）。

    上游返回的永远是整图尺寸，素材必须裁到用户框选的范围才符合预期。
    """
    image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    if target_size and image.size != target_size:
        image = image.resize(target_size, Image.Resampling.LANCZOS)

    # Coordinates are always defined against the original image. If the
    # provider returned a different size, it was aligned before cropping.
    width, height = image.size
    x, y, w, h = cutout_service.region_to_pixels(region, width, height)
    crop = image.crop((x, y, x + w, y + h))
    # Preserve provider alpha and trim only transparent borders. A flattened
    # response remains a bounded crop until the explicit fallback policy runs.
    if image.getchannel("A").getextrema() != (255, 255):
        bbox = crop.getchannel("A").point(lambda value: 255 if value > 8 else 0).getbbox()
        if bbox:
            crop = crop.crop(bbox)
    buffer = io.BytesIO()
    crop.save(buffer, format="PNG")
    return buffer.getvalue()


def _align_image_bytes(image_bytes: bytes, target_size: tuple[int, int]) -> bytes:
    """Resize a provider response to the original image dimensions."""
    with Image.open(io.BytesIO(image_bytes)) as source:
        image = source.convert("RGBA")
        if image.size != target_size:
            image = image.resize(target_size, Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()


def _region_change_checks(
    base_bytes: bytes,
    result_bytes: bytes,
    regions: list[dict[str, Any]],
    *,
    indexes: list[int] | None = None,
) -> list[dict[str, Any]] | None:
    """逐区域检测生成结果是否发生实质修改（灰度均差超过阈值视为已修改）。"""
    if not regions:
        return None
    base = Image.open(io.BytesIO(base_bytes)).convert("L")
    edited = Image.open(io.BytesIO(result_bytes)).convert("L")
    if edited.size != base.size:
        edited = edited.resize(base.size, Image.LANCZOS)
    width, height = base.size
    diff = ImageChops.difference(base, edited)
    checks: list[dict[str, Any]] = []
    for position, region in enumerate(regions, start=1):
        x, y, w, h = cutout_service.region_to_pixels(region, width, height)
        crop = diff.crop((x, y, x + w, y + h))
        small = crop.resize((min(64, max(1, w)), min(64, max(1, h))))
        pixels = list(small.getdata())
        mean = sum(pixels) / max(1, len(pixels))
        index = indexes[position - 1] if indexes and position <= len(indexes) else position
        checks.append({"index": index, "changed": bool(mean > 5.0), "mean": round(mean, 2)})
    return checks


def _composite_onto(
    base_bytes: bytes, edited_bytes: bytes, regions: list[dict[str, Any]]
) -> bytes:
    """把编辑结果与原图按选区合成：所有选区外像素严格保留原图（100% 不变），选区内缘羽化过渡。"""
    if not regions:
        return edited_bytes
    try:
        with Image.open(io.BytesIO(base_bytes)) as source:
            base_has_alpha = "A" in source.getbands() or source.mode in ("LA", "P")
            base = source.convert("RGBA" if base_has_alpha else "RGB")
        with Image.open(io.BytesIO(edited_bytes)) as source:
            edited = source.convert("RGBA" if base_has_alpha or "A" in source.getbands() else "RGB")
        if edited.size != base.size:
            edited = edited.resize(base.size, Image.LANCZOS)
        width, height = base.size
        # 逐区域生成 mask（区域外严格 0），再用 max 合并为并集
        mask = Image.new("L", (width, height), 0)
        for region in regions:
            x, y, w, h = cutout_service.region_to_pixels(region, width, height)
            soft = Image.new("L", (width, height), 0)
            ImageDraw.Draw(soft).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
            soft = soft.filter(ImageFilter.GaussianBlur(max(2, min(w, h) // 40)))
            inside = Image.new("L", (width, height), 0)
            ImageDraw.Draw(inside).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
            mask = ImageChops.lighter(mask, ImageChops.multiply(soft, inside))
        out = Image.composite(edited, base, mask)
        buf = io.BytesIO()
        out.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001 - 合成失败时优先保证选区外像素不被污染
        logger.exception("编辑结果合成失败，保留原图以满足选区外像素保真")
        return base_bytes


def _apply_transparent(image_bytes: bytes, regions: list[dict[str, Any]]) -> bytes:
    """在整图内把给定区域就地变为透明（尺寸不变，区域外严格不变，内缘羽化）。"""
    if not regions:
        return image_bytes
    img = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    width, height = img.size
    # keep alpha：区域并集内 0（透明）；先模糊（边缘过渡）再把并集外恢复为 255（严格不变）
    keep = Image.new("L", (width, height), 255)
    inside_all = Image.new("L", (width, height), 0)
    min_side = min(width, height)
    for region in regions:
        x, y, w, h = cutout_service.region_to_pixels(region, width, height)
        min_side = min(min_side, w, h)
        ImageDraw.Draw(keep).rectangle([x, y, x + w - 1, y + h - 1], fill=0)
        ImageDraw.Draw(inside_all).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
    keep = keep.filter(ImageFilter.GaussianBlur(max(1, min_side // 60)))
    keep = Image.composite(keep, Image.new("L", (width, height), 255), inside_all)
    # 选区外严格保留原图已有 alpha；选区内才应用透明化 mask。
    original_alpha = img.getchannel("A")
    img.putalpha(ImageChops.multiply(original_alpha, keep))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


async def save_upload_as_asset(
    db: AsyncSession, user_id: str, filename: str, content_type: str, data: bytes, prompt: str = ""
):
    """把上传的参考图登记为资产（编辑流程使用）。"""
    return await asset_service.create_from_bytes(
        db, user_id, data, kind="uploaded", filename=filename, content_type=content_type, prompt=prompt
    )


def new_idempotency_key() -> str:
    """生成幂等键（缺失请求头时兜底）。"""
    return new_id()
