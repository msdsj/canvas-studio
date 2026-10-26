"""生成编排服务：生图 / 编辑任务的创建与后台执行。

- 幂等去重、并发上限、预扣→上游→确认/回滚统一在此收口；
- 上游由网关负责，真实规划任务禁止 Demo 降级，结果落资产库；
- 编辑任务按「AI 意图分析 + GPT Image 逐任务处理」编排；
- 选区和标注只作为模型输入，最终图片直接使用模型产物。

新流程（skill: image-edit-flow）
------------------------------
1. 用户标记 → 涂鸦 + 框选 + 填写需求
2. 对话分析 → 完善提示词，判断需要几张图
3. gpt-image-2 → 逐任务调用，所有处理都由 GPT 完成
4. 校验模型结果 → 保存资产、确认额度；失败则退款
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFont
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.generation import GenerationTask
from app.services import (
    asset_service,
    config_service,
    gateway_client as gw_module,
    queue_service,
    storage_service,
    task_service,
)
from app.services import edit_ops as ops_module
from app.services.edit_handlers import (
    OUTPUT_COMPOSITE,
    OUTPUT_SPRITE,
    EditHandler,
    load_handlers,
    resolve_handler,
)
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger
from app.utils.ids import new_id
from app.utils import offload

logger = get_logger("app.generate_service")


async def resolve_cost(db: AsyncSession, task_type: str, quality: str = "standard") -> int:
    """按类型/质量解析单价。"""
    prices = await config_service.prices(db)
    if task_type == "edit":
        return int(prices["edit"])
    if quality == "hd":
        return int(prices["image_hd"])
    return int(prices["image_standard"])


_EXECUTION_PARAMS = frozenset({
    "model", "size", "quality", "n", "base_image_url", "mask_url", "ops",
    "region", "outputs", "edit_mode", "edit_intensity", "optimized_prompt",
})


def _task_metadata(extra: dict[str, Any] | None) -> dict[str, Any]:
    """追踪字段可扩展，计费和执行参数只由规范化后的显式输入决定。"""
    return {key: value for key, value in (extra or {}).items() if key not in _EXECUTION_PARAMS}


def _image_count(value: Any) -> int:
    try:
        return max(1, min(int(value or 1), 4))
    except (ValueError, TypeError, OverflowError) as exc:
        raise AppError(ErrorCode.VALIDATION_ERROR, "图片数量必须为有效整数") from exc


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
    team: Any | None = None,
) -> tuple[GenerationTask, bool]:
    """创建文生图任务（幂等）。`team` 非空时扣团队共享额度池。"""
    count = _image_count(n)
    normalized_quality = str(quality).strip().lower()
    if normalized_quality not in {"standard", "hd"}:
        raise AppError(ErrorCode.VALIDATION_ERROR, "不支持的图片质量，请选择标准或高清")
    # 计价与上游执行使用同一份参数，params/extra 无法覆盖已计费的数量或质量。
    params = {
        **_task_metadata(extra),
        "model": model, "size": size, "quality": normalized_quality, "n": count,
    }
    cost = await resolve_cost(db, "generate", params["quality"]) * params["n"]
    return await task_service.create_or_get(
        db,
        user_id,
        idempotency_key,
        "generate",
        prompt,
        params,
        cost,
        session_id,
        canvas_id,
        team=team,
    )


async def create_edit_task(
    db: AsyncSession,
    user_id: str,
    *,
    prompt: str,
    model: str,
    size: str,
    quality: str = "standard",
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
    team: Any | None = None,
) -> tuple[GenerationTask, bool]:
    """创建编辑任务（幂等）。

    所有编辑先调用配置的图像模型，按实际产出和版本数计费。
    选区、标注图和掩码只作为模型输入，最终图片直接使用模型返回结果。
    经LLM规划的每项独立产出为一个n=1任务；保留旧版多操作接口。

    :param edit_ops: 结构化编辑操作（能力注册表驱动的 Intent DSL）
    :param edit_region: 旧版纯几何选区（向后兼容，等价于全部按兜底能力处理）
    """
    handlers = await load_handlers(db)
    normalized_ops = ops_module.normalize_ops(
        edit_ops, legacy_regions=edit_region, handlers=handlers, default_prompt=prompt
    )
    if str(edit_mode or "").strip().lower() == "transparent":
        for op in normalized_ops:
            op.handler = "transparent"
            if not op.prompt:
                op.prompt = "将选区挖空为真正透明的像素"
    # 自由选区（套索/画笔）的多边形要在**入参这一步**就补回到操作上，
    # 否则落库的 params["ops"] 只剩包围盒，执行时无论如何都还原不出真实轮廓。
    _attach_paths(normalized_ops, edit_ops)
    # 兼容旧接口通过 extra 传版本数，但在合并前归一化，并以同一值执行和计价。
    variants = _image_count((extra or {}).get("n"))
    # 整图编辑按版本数生成，独立素材每个区域由图像模型各生成一张。
    sprite_count = sum(
        1
        for op in normalized_ops
        if resolve_handler(handlers, op.handler).output == OUTPUT_SPRITE
    )
    composite_count = len(normalized_ops) - sprite_count
    outputs = (variants if composite_count > 0 else 0) + sprite_count
    if not normalized_ops:
        outputs = variants
    cost = await resolve_cost(db, "edit") * outputs

    params: dict[str, Any] = {
        **_task_metadata(extra),
        "model": model,
        "size": size,
        "quality": quality,
        "n": variants,
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
    return await task_service.create_or_get(
        db,
        user_id,
        idempotency_key,
        "edit",
        prompt,
        params,
        cost,
        session_id,
        canvas_id,
        team=team,
    )


def _decode_b64(data: str) -> bytes:
    """解码 base64（容忍 data URL 前缀）。"""
    if data.startswith("data:"):
        data = data.split(",", 1)[-1]
    return base64.b64decode(data)


def _model_image_details(raw: bytes) -> tuple[str, str] | None:
    """Validate provider output and return its original format's filename and MIME type."""
    try:
        with Image.open(io.BytesIO(raw)) as img:
            image_format = (img.format or "").upper()
            img.verify()
    except Exception:  # noqa: BLE001 - 转码失败不阻断主流程
        logger.warning("图像模型返回的图片无法读取")
        return None
    formats = {"PNG": ("png", "image/png"), "JPEG": ("jpg", "image/jpeg"), "WEBP": ("webp", "image/webp")}
    return formats.get(image_format)


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
    """后台执行入口：先排队拿并发位，再真正打上游。

    **顺序很重要**：一定要在开数据库会话之前排队。
    如果先 `AsyncSessionLocal()` 再等信号量，每个排队任务都会占住一条连接；
    连接池只有 4 条时，排队任务会把池子吃干，真正在跑的任务反而拿不到连接，
    整个系统直接死锁。所以这里先拿位子、再开库。

    排队期间**不碰数据库**（进度停在初始值，前端按 `/api/generate/queue`
    显示全局排队水位），拿到位子后由 `_execute_task` 从 10% 起步。
    队列满时直接失败退款，不让协程无限堆积。
    """
    try:
        async with queue_service.slot(task_id) as ahead:
            await _execute_task(task_id, queued=ahead > 1)
    except AppError as exc:
        # 队列满 / 等待期间被取消：走失败退款，避免额度被预扣挂着
        async with AsyncSessionLocal() as db:
            fresh = await db.get(GenerationTask, task_id)
            if fresh is not None and fresh.status == "running":
                await task_service.fail_and_refund(db, task_id, exc.code.value, exc.message)
        logger.warning("任务 %s 未能执行：%s", task_id, exc.message)
    except Exception:  # noqa: BLE001
        async with AsyncSessionLocal() as db:
            fresh = await db.get(GenerationTask, task_id)
            if fresh is not None and fresh.status == "running":
                await task_service.fail_and_refund(
                    db, task_id, ErrorCode.UPSTREAM_ERROR.value, "图片没生成出来，额度已经退回"
                )
        logger.exception("任务 %s 队列调度异常", task_id)


async def _execute_task(task_id: str, queued: bool = False) -> None:
    """后台执行生成任务（独立会话）。`queued=True` 表示经历过后台排队。"""
    async with AsyncSessionLocal() as db:
        task = (
            await db.execute(select(GenerationTask).where(GenerationTask.id == task_id))
        ).scalar_one_or_none()
        if task is None or task.status != "running":
            return

        # 排过队的任务从 10% 起步（30% 留给真正开始调上游的那一刻）
        await task_service.mark_progress(db, task_id, 10 if queued else 30)
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
        if demo:
            await task_service.fail_and_refund(db, task_id, ErrorCode.UPSTREAM_ERROR.value, "图片任务必须由真实图像模型完成，额度已退回")
            return
        images: list[bytes] = result.get("images") or []
        if not images:
            await task_service.fail_and_refund(
                db, task_id, ErrorCode.UPSTREAM_ERROR.value, "这次没有生成出图片，额度已退回"
            )
            return

        urls: list[str] = []
        total = len(images)

        async def persist(index: int, raw: bytes) -> str | None:
            """验证模型图片并原样落库（含缩略图）。返回 url，失败返回 None。

            整段都是同步重活：Pillow 校验、生成缩略图、写两个文件。
            一单多图时这些操作串起来能占住事件循环好几秒，必须挪出循环。
            """
            details = await offload.run_sync(_model_image_details, raw)
            if details is None:
                return None
            extension, mime = details
            filename = f"result.{extension}" if total == 1 else f"result-{index}.{extension}"
            asset = await asset_service.create_from_bytes(
                db,
                task.user_id,
                raw,
                kind="generated",
                filename=filename,
                content_type=mime,
                prompt=task.prompt,
                is_demo=demo,
                generation_task_id=task.id,
            )
            return asset.url

        for index, raw in enumerate(images, start=1):
            url = await persist(index, raw)
            if url is None:
                await task_service.fail_and_refund(
                    db, task_id, ErrorCode.UPSTREAM_ERROR.value, "返回的图片已损坏，额度已退回"
                )
                return
            urls.append(url)

        await task_service.succeed(db, task_id, urls, demo=demo)


async def _run_edit_task(db: AsyncSession, task: GenerationTask) -> dict[str, Any]:
    """图片编辑执行：按「整图类 / 素材类」拆分调用上游。

    产出契约（与产品口径一致）：
    - 整图类区域（改样式/挖空/去物/增强）合并为 **1 次调用**，带并集掩码，产出 1 张修改图；
    - 素材类区域（抠图）**每个区域各 1 次调用**，各带自己的掩码，产出 N 张透明素材；
    - 顺序固定「先整图、后素材」，与前端预览的产出顺序一致。

    每次调用都向模型发送：
    ① 纯原图（唯一像素来源，不画任何标记，避免标记被画进结果）；
    ② 引导图（只标出本次要改的区域，编号与指令一致）；
    ③ 标准 inpainting 掩码（向模型表达需要修改的范围）。
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
        images = _result_bytes(result)[:variants]
        if str(task.params.get("edit_mode") or "").strip().lower() == "transparent":
            for image in images:
                _require_transparent_output(image)
        thinking.append("生成完成，正在整理结果…")
        await _push_thinking(db, task, thinking)
        return {"images": images, "demo": bool(result.get("demo"))}

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
            # The image model owns the final pixels; masks constrain its edit request.
            generated = _result_bytes(result)[:variants]
            if any(op.handler == "transparent" for op in composite_ops):
                for image in generated:
                    _require_transparent_output(image)
            images.extend(generated)
            thinking.append("整图修改完成")
        except AppError:
            raise
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
                    result = await _call_region_cutout(task, base_bytes, op, prompt)
                    found = _result_bytes(result)
                    if not found:
                        raise AppError(ErrorCode.UPSTREAM_ERROR, "未返回素材图片")
                    _require_transparent_output(found[0])
                    return op.index, found[0], bool(result.get("demo"))
                except AppError:
                    raise
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


async def _call_region_cutout(
    task: GenerationTask, base_bytes: bytes, op: ops_module.EditOp, prompt: str
) -> dict[str, Any]:
    """Send the original image and selected region to GPT Image for a transparent cutout."""
    guide_bytes = _render_ops_guide(base_bytes, [op])
    selection_mask = _render_ops_mask(base_bytes, [op])
    with Image.open(io.BytesIO(selection_mask)) as opened:
        mask = opened.convert("RGBA")
    # The selected subject is preserved; the model can remove everything outside it.
    mask.putalpha(ImageChops.invert(mask.getchannel("A")))
    mask_buffer = io.BytesIO()
    mask.save(mask_buffer, format="PNG")
    files: list[tuple[str, tuple[str, bytes, str]]] = [
        ("image", ("base.png", base_bytes, "image/png")),
        ("image", ("edit-guide.png", guide_bytes, "image/png")),
        ("mask", ("cutout-mask.png", mask_buffer.getvalue(), "image/png")),
    ]
    form = {
        **_pool_metadata(task),
        "prompt": prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "size": "1024x1024",
        "quality": "standard",
        "n": 1,
        "response_format": "b64_json",
        "background": "transparent",
        "output_format": "png",
    }
    return await gw_module.gateway_client.image_edits(files, form)


def _require_transparent_output(provider_bytes: bytes) -> None:
    """Reject an opaque cutout result instead of silently running local segmentation."""
    if not _has_transparency(provider_bytes):
        raise AppError(
            ErrorCode.UPSTREAM_ERROR,
            "图像模型没有返回透明背景结果，额度已退回，请重试",
        )


def _pool_metadata(task):
    return {
        key: task.params[key]
        for key in ("pool_batch_id", "pool_task_id", "pool_batch_total", "pool_strict")
        if key in task.params
    }


def _compose_prompt(global_prompt: str, instruction: str, *, sprite: bool) -> str:
    """拼装单次调用的上游指令：全局约束 + 本次区域指令 + 执行注意。"""
    head = "\n".join(part for part in (global_prompt, instruction) if part).strip()
    if sprite:
        tail = (
            "这张图里只有一个主体，请把它完整抠出来做成独立素材："
            "主体内容、细节、颜色、光影与原图完全一致，不重绘、不美化、不添加背景或阴影。"
            "输出纯透明背景的 PNG（真正的 alpha 通道），"
            "**不要用灰白棋盘格图案来表示透明**，也不要画出红框、编号或任何标注。"
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
        **_pool_metadata(task),
        "prompt": prompt or "按照描述修改这张图片",
        "model": task.params.get("model", "gpt-image-2"),
        "size": task.params.get("size", "1024x1024"),
        "quality": task.params.get("quality", "standard"),
        "n": variants,
        "response_format": "b64_json",
        "generation_params": json.dumps(task.params.get("generation_params") or {}),
    }
    if str(task.params.get("edit_mode") or "").strip().lower() == "transparent":
        form.update(background="transparent", output_format="png")
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
    mask_bytes, mask_source = await offload.run_sync(
        _resolve_mask_bytes, task, base_bytes, ops, use_uploaded_mask=use_uploaded_mask
    )
    logger.info(
        "编辑掩码来源=%s task=%s 区域数=%d", mask_source, task.id, len(ops)
    )
    guide_bytes = await offload.run_sync(_render_ops_guide, base_bytes, ops)
    files: list[tuple[str, tuple[str, bytes, str]]] = [
        ("image", ("base.png", base_bytes, "image/png")),
        ("image", ("edit-guide.png", guide_bytes, "image/png")),
        ("mask", ("mask.png", mask_bytes, "image/png")),
    ]
    form = {
        **_pool_metadata(task),
        "prompt": prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "size": task.params.get("size", "1024x1024"),
        "quality": task.params.get("quality", "standard"),
        "n": max(1, min(variants, 4)),
        "response_format": "b64_json",
        "generation_params": json.dumps(task.params.get("generation_params") or {}),
    }
    if any(op.handler == "transparent" for op in ops):
        form.update(background="transparent", output_format="png")
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
                if task.params.get("planned_output") and ops:
                    generated = _render_ops_mask(base_bytes, ops)
                    with Image.open(io.BytesIO(uploaded)) as source:
                        mask = source.convert("RGBA")
                    with Image.open(io.BytesIO(generated)) as source:
                        own_alpha = source.convert("RGBA").getchannel("A")
                    mask.putalpha(ImageChops.lighter(mask.getchannel("A"), own_alpha))
                    buffer = io.BytesIO()
                    mask.save(buffer, format="PNG")
                    return buffer.getvalue(), "uploaded_intersection"
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
    x, y, w, h = ops_module.region_to_pixels(op.region, width, height)
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
        **_pool_metadata(task),
        "prompt": task.prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "n": int(task.params.get("n", 1)),
        "size": task.params.get("size", "1024x1024"),
        "quality": task.params.get("quality", "standard"),
        "response_format": "b64_json",
        "generation_params": task.params.get("generation_params") or {},
    }
    return await gw_module.gateway_client.image_generations(payload)


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


def _has_transparency(image_bytes: bytes) -> bool:
    """判断图片是否真的带透明像素。

    不透明图片或全透明空图都不符合独立素材的返回契约。
    """
    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            if img.mode not in ("RGBA", "LA", "P"):
                return False
            low, high = img.convert("RGBA").getchannel("A").getextrema()
            return low < 250 and high > 8
    except Exception:  # noqa: BLE001 - 读不出来就当作没有透明
        return False


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
