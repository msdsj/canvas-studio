"""生成编排服务：生图 / 编辑任务的创建与后台执行。

- 幂等去重、并发上限、预扣→上游→确认/回滚统一在此收口；
- 上游由网关负责（含 Demo 降级）；结果落资产库。
"""
from __future__ import annotations

import base64
import io
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.generation import GenerationTask
from app.services import (
    asset_service,
    config_service,
    gateway_client as gw_module,
    storage_service,
    task_service,
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
    cost = await resolve_cost(db, "generate", quality)
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
    edit_mode: str | None = None,
    edit_intensity: str | None = None,
    extra: dict[str, Any] | None = None,
) -> tuple[GenerationTask, bool]:
    """创建编辑任务（幂等）。`edit_mode=transparent` 为本地透明化（免费）。"""
    cost = 0 if edit_mode == "transparent" else await resolve_cost(db, "edit")
    params: dict[str, Any] = {
        "model": model,
        "size": size,
        "quality": "standard",
        "n": 1,
        "base_image_url": base_image_url,
    }
    if mask_url:
        params["mask_url"] = mask_url
    if edit_region:
        params["edit_region"] = edit_region
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
                if task.params.get("edit_mode") == "transparent":
                    result = await _call_transparent(task)
                else:
                    result = await _call_edit(task)
            else:
                result = await _call_generate(task)
        except AppError as exc:
            await task_service.fail_and_refund(db, task_id, exc.code.value, exc.message)
            logger.warning("任务 %s 失败: %s", task_id, exc.message)
            return
        except Exception as exc:  # noqa: BLE001
            await task_service.fail_and_refund(db, task_id, ErrorCode.UPSTREAM_ERROR.value, str(exc))
            logger.exception("任务 %s 异常", task_id)
            return

        demo = bool(result.get("demo"))
        images = result.get("data") or []
        urls: list[str] = []
        for item in images:
            b64 = item.get("b64_json") or item.get("b64")
            if not b64:
                continue
            raw = _decode_b64(b64)
            # 区域编辑：把结果与原图按选区合成，确保选区外像素严格不变
            if (
                task.type == "edit"
                and not demo
                and task.params.get("edit_region")
                and task.params.get("edit_mode") != "transparent"
            ):
                raw = _composite_edit_result(task, raw)
                # 逐区域检测改动（用于"多区域遗漏"提醒与兜底重试）
                try:
                    checks = _region_change_checks(task, raw)
                    if checks:
                        task.params = {**task.params, "region_check": checks}
                except Exception:  # noqa: BLE001
                    logger.exception("区域变更检测失败")
            asset = await asset_service.create_from_bytes(
                db,
                task.user_id,
                raw,
                kind="generated",
                content_type="image/png",
                prompt=task.prompt,
                is_demo=demo,
                generation_task_id=task.id,
            )
            urls.append(asset.url)

        if not urls:
            await task_service.fail_and_refund(
                db, task_id, ErrorCode.UPSTREAM_ERROR.value, "上游未返回有效图片"
            )
            return

        await task_service.succeed(db, task_id, urls, demo=demo)


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


async def _call_edit(task: GenerationTask) -> dict[str, Any]:
    """调用网关图生图/编辑（multipart）。"""
    base_url = task.params.get("base_image_url")
    if not base_url:
        raise AppError(ErrorCode.VALIDATION_ERROR, "缺少参考图")
    base_bytes, ext = _local_bytes(base_url)
    mime = "image/png" if ext in {"png", "PNG"} else f"image/{ext}"
    files: list[tuple[str, tuple[str, bytes, str]]] = [
        ("image", (f"base.{ext}", base_bytes, mime))
    ]
    mask_url = task.params.get("mask_url")
    if mask_url:
        mask_bytes, mask_ext = _local_bytes(mask_url)
        files.append(("mask", (f"mask.{mask_ext}", mask_bytes, f"image/{mask_ext}")))
    prompt = task.prompt
    form = {
        # 用户提示词原样透传上游（配合带红框编号的 mask 图），不做任何额外加工
        "prompt": prompt,
        "model": task.params.get("model", "gpt-image-2"),
        "size": task.params.get("size", "1024x1024"),
        "response_format": "b64_json",
    }
    return await gw_module.gateway_client.image_edits(files, form)


def _region_to_pixels(region: dict[str, Any], width: int, height: int) -> tuple[int, int, int, int]:
    """归一化选区 → 像素矩形 (x, y, w, h)，并夹取到图像范围内。"""
    x = max(0, min(width - 1, round(float(region.get("x", 0)) * width)))
    y = max(0, min(height - 1, round(float(region.get("y", 0)) * height)))
    w = max(1, min(width - x, round(float(region.get("w", 1)) * width)))
    h = max(1, min(height - y, round(float(region.get("h", 1)) * height)))
    return x, y, w, h


def _normalized_regions(value: Any) -> list[dict[str, Any]]:
    """把 edit_region 参数（单区域 dict 或区域列表）统一为列表。"""
    if isinstance(value, dict):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, dict)]
    return []


def _region_change_checks(task: GenerationTask, result_bytes: bytes) -> list[dict[str, Any]] | None:
    """逐区域检测生成结果是否发生实质修改（灰度均差超过阈值视为已修改）。"""
    regions = _normalized_regions(task.params.get("edit_region"))
    base_url = task.params.get("base_image_url")
    if not regions or not base_url:
        return None
    base_bytes, _ = _local_bytes(str(base_url))
    base = Image.open(io.BytesIO(base_bytes)).convert("L")
    edited = Image.open(io.BytesIO(result_bytes)).convert("L")
    if edited.size != base.size:
        edited = edited.resize(base.size, Image.LANCZOS)
    width, height = base.size
    diff = ImageChops.difference(base, edited)
    checks: list[dict[str, Any]] = []
    for index, region in enumerate(regions):
        x, y, w, h = _region_to_pixels(region, width, height)
        crop = diff.crop((x, y, x + w, y + h))
        small = crop.resize((min(64, max(1, w)), min(64, max(1, h))))
        pixels = list(small.getdata())
        mean = sum(pixels) / max(1, len(pixels))
        checks.append({"index": index, "changed": bool(mean > 5.0), "mean": round(mean, 2)})
    return checks


def _composite_edit_result(task: GenerationTask, result_bytes: bytes) -> bytes:
    """把编辑结果与原图按选区合成：所有选区外像素严格保留原图（100% 不变），选区内缘羽化过渡。"""
    regions = _normalized_regions(task.params.get("edit_region"))
    base_url = task.params.get("base_image_url")
    if not base_url or not regions:
        return result_bytes
    try:
        base_bytes, _ = _local_bytes(str(base_url))
        base = Image.open(io.BytesIO(base_bytes)).convert("RGB")
        edited = Image.open(io.BytesIO(result_bytes)).convert("RGB")
        if edited.size != base.size:
            edited = edited.resize(base.size, Image.LANCZOS)
        width, height = base.size
        # 逐区域生成 mask（区域外严格 0），再用 max 合并为并集
        mask = Image.new("L", (width, height), 0)
        for region in regions:
            x, y, w, h = _region_to_pixels(region, width, height)
            soft = Image.new("L", (width, height), 0)
            ImageDraw.Draw(soft).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
            soft = soft.filter(ImageFilter.GaussianBlur(max(2, min(w, h) // 40)))
            inside = Image.new("L", (width, height), 0)
            ImageDraw.Draw(inside).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
            single = ImageChops.multiply(soft, inside)
            mask = ImageChops.lighter(mask, single)
        out = Image.composite(edited, base, mask)
        buf = io.BytesIO()
        out.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:  # noqa: BLE001 - 合成失败时退回原始结果，不影响任务成功
        logger.exception("编辑结果合成失败，使用原始结果")
        return result_bytes


async def _call_transparent(task: GenerationTask) -> dict[str, Any]:
    """本地透明化：把选定区域（可多个）在该图内变为透明（确定性处理，不占用上游算力，内缘羽化）。"""
    regions = _normalized_regions(task.params.get("edit_region"))
    base_url = task.params.get("base_image_url")
    if not base_url or not regions:
        raise AppError(ErrorCode.VALIDATION_ERROR, "透明化需要参考图与选区")
    base_bytes, _ = _local_bytes(str(base_url))
    img = Image.open(io.BytesIO(base_bytes)).convert("RGBA")
    width, height = img.size
    # keep alpha：区域并集内 0（透明）；先模糊（边缘过渡）再把并集外恢复为 255（严格不变）
    keep = Image.new("L", (width, height), 255)
    inside_all = Image.new("L", (width, height), 0)
    min_side = width
    for region in regions:
        x, y, w, h = _region_to_pixels(region, width, height)
        min_side = min(min_side, w, h)
        ImageDraw.Draw(keep).rectangle([x, y, x + w - 1, y + h - 1], fill=0)
        ImageDraw.Draw(inside_all).rectangle([x, y, x + w - 1, y + h - 1], fill=255)
    keep = keep.filter(ImageFilter.GaussianBlur(max(1, min_side // 60)))
    keep = Image.composite(keep, Image.new("L", (width, height), 255), inside_all)
    img.putalpha(keep)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {"data": [{"b64_json": base64.b64encode(buf.getvalue()).decode("ascii")}], "demo": False}


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
