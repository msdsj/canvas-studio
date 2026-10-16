"""生图 / 编辑转发路由 /gw/images/*。"""
from __future__ import annotations

from fastapi import APIRouter, File, Form, UploadFile

from app.schemas.common import ok
from app.schemas.image import ImageGenerationRequest
from app.services import image_router

router = APIRouter(prefix="/gw/images", tags=["gateway-images"])


@router.post("/generations")
async def image_generations(payload: ImageGenerationRequest) -> dict:
    """转发 chatgpt2api 文生图；demo 时返回占位图。"""
    return ok(await image_router.image_generations(payload.model_dump()))


@router.post("/edits")
async def image_edits(
    prompt: str = Form(...),
    model: str = Form(default="gpt-image-2"),
    size: str = Form(default="1024x1024"),
    image: list[UploadFile] = File(...),
    mask: UploadFile | None = File(default=None),
) -> dict:
    """转发 chatgpt2api 图生图/编辑（multipart）；demo 时返回占位图。"""
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
    form = {"prompt": prompt, "model": model, "size": size}
    return ok(await image_router.image_edits(files, form))
