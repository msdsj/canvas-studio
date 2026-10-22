"""生图 / 编辑转发路由 /gw/images/*。"""
from __future__ import annotations

import json

from fastapi import APIRouter, File, Form, UploadFile

from app.schemas.common import ok
from app.schemas.image import ImageGenerationRequest
from app.services import image_router

router = APIRouter(prefix="/gw/images", tags=["gateway-images"])


@router.post("/generations")
async def image_generations(payload: ImageGenerationRequest) -> dict:
    """调用配置的图片 provider。"""
    return ok(await image_router.image_generations(payload.model_dump()))


@router.post("/edits")
async def image_edits(
    prompt: str = Form(...),
    model: str = Form(default="gpt-image-2"),
    size: str = Form(default="1024x1024"),
    quality: str = Form(default="standard"),
    n: int = Form(default=1),
    response_format: str = Form(default="b64_json"),
    background: str | None = Form(default=None),
    output_format: str | None = Form(default=None),
    pool_batch_id: str = Form(default="", max_length=200),
    pool_task_id: str = Form(default="", max_length=200),
    pool_batch_total: int = Form(default=1, ge=1, le=32),
    generation_params: str = Form(default="{}"),
    image: list[UploadFile] = File(...),
    mask: UploadFile | None = File(default=None),
) -> dict:
    """调用配置的图片 provider 图生图/编辑（multipart）。"""
    files: list[tuple[str, tuple[str, bytes, str]]] = []
    for upload in image:
        files.append(
            (
                "image",
                (
                    upload.filename or "image.png",
                    await upload.read(),
                    upload.content_type or "image/png",
                ),
            )
        )
    if mask is not None:
        files.append(
            (
                "mask",
                (
                    mask.filename or "mask.png",
                    await mask.read(),
                    mask.content_type or "image/png",
                ),
            )
        )
    form = {
        "prompt": prompt,
        "model": model,
        "size": size,
        "quality": quality,
        "n": max(1, min(n, 4)),
        "response_format": response_format,
        "pool_batch_id": pool_batch_id,
        "pool_task_id": pool_task_id,
        "pool_batch_total": pool_batch_total,
    }
    try:
        extra_params = json.loads(generation_params)
    except (TypeError, ValueError):
        extra_params = {}
    if isinstance(extra_params, dict):
        form["generation_params"] = extra_params
    if background:
        form["background"] = background
    if output_format:
        form["output_format"] = output_format
    return ok(await image_router.image_edits(files, form))
