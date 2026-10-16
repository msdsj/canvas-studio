"""生成路由 `/api/generate/*`（含任务生命周期）。"""
from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Header, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal, get_db
from app.deps import get_current_user
from app.models.generation import GenerationTask
from app.models.user import User
from app.schemas.generate import GenerateImageRequest
from app.schemas.task import GenerationTaskOut
from app.services import (
    asset_service,
    generate_service,
    task_service,
)
from app.services import chat_service as _chat  # 复用 sse_chunk
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/generate", tags=["generate"])

_TERMINAL = ("succeeded", "failed", "cancelled", "timeout")


def _serialize(task: GenerationTask) -> dict:
    """序列化任务输出。"""
    return GenerationTaskOut.model_validate(task).model_dump()


@router.post("/image")
async def generate_image(
    payload: GenerateImageRequest,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """创建文生图任务（幂等，异步执行）。"""
    key = idempotency_key or generate_service.new_idempotency_key()
    task, created = await generate_service.create_image_task(
        db,
        user.id,
        prompt=payload.prompt,
        model=payload.model,
        size=payload.size,
        quality=payload.quality,
        n=payload.n,
        session_id=payload.session_id,
        canvas_id=payload.canvas_id,
        idempotency_key=key,
        extra=payload.params,
    )
    if created:
        background_tasks.add_task(generate_service.run_task, task.id)
    return envelope(_serialize(task))


@router.post("/edit")
async def generate_edit(
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    prompt: str = Form(...),
    model: str = Form(default="gpt-image-2"),
    size: str = Form(default="1024x1024"),
    base_asset_id: str | None = Form(default=None),
    session_id: str | None = Form(default=None),
    canvas_id: str | None = Form(default=None),
    file: UploadFile | None = File(default=None),
    mask: UploadFile | None = File(default=None),
    edit_mode: str | None = Form(default=None),
    edit_intensity: str | None = Form(default=None),
    region: str | None = Form(default=None),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """创建编辑任务（参考图来自资产库或上传，幂等）。

    - `region`：JSON 形式的归一化选区 {x,y,w,h}，用于"选区外严格不变"的合成保真；
    - `edit_mode=transparent`：本地透明化（免费，不消耗上游算力）；
    - `edit_intensity`：fine=精细修改（保结构，默认）；rebuild=重新生成（换主体）。
    """
    if base_asset_id:
        asset = await asset_service.get_asset(db, user, base_asset_id)
        base_url = asset.url
    elif file is not None:
        data = await file.read()
        asset = await generate_service.save_upload_as_asset(
            db, user.id, file.filename or "base.png", file.content_type or "image/png", data, prompt
        )
        base_url = asset.url
    else:
        raise AppError(ErrorCode.VALIDATION_ERROR, "需要提供 base_asset_id 或上传参考图")

    mask_url: str | None = None
    if mask is not None:
        mask_data = await mask.read()
        mask_asset = await generate_service.save_upload_as_asset(
            db, user.id, mask.filename or "mask.png", mask.content_type or "image/png", mask_data
        )
        mask_url = mask_asset.url

    edit_region: list[dict[str, float]] | None = None
    if region:
        try:
            parsed_region = json.loads(region)
        except ValueError:
            parsed_region = None
        if isinstance(parsed_region, dict):
            raw_regions: list = [parsed_region]
        elif isinstance(parsed_region, list):
            raw_regions = parsed_region
        else:
            raw_regions = []
        normalized_regions: list[dict[str, float]] = []
        for item in raw_regions:
            if isinstance(item, dict) and all(k in item for k in ("x", "y", "w", "h")):
                normalized_regions.append({k: round(float(item[k]), 6) for k in ("x", "y", "w", "h")})
        edit_region = normalized_regions or None

    key = idempotency_key or generate_service.new_idempotency_key()
    task, created = await generate_service.create_edit_task(
        db,
        user.id,
        prompt=prompt,
        model=model,
        size=size,
        base_image_url=base_url,
        session_id=session_id,
        canvas_id=canvas_id,
        idempotency_key=key,
        mask_url=mask_url,
        edit_region=edit_region,
        edit_mode=edit_mode,
        edit_intensity=edit_intensity,
    )
    if created:
        background_tasks.add_task(generate_service.run_task, task.id)
    return envelope(_serialize(task))


@router.get("/tasks")
async def list_tasks(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    canvas_id: str | None = Query(default=None),
    session_id: str | None = Query(default=None),
    status: str | None = Query(default=None),
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
) -> dict:
    """分页查询生成历史。"""
    page, size = normalize_page(page, size)
    rows, total = await task_service.list_tasks(
        db, user.id, page, size, canvas_id, session_id, status
    )
    items = [_serialize(r) for r in rows]
    return envelope(paginated(items, total, page, size))


@router.get("/tasks/{task_id}")
async def get_task(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """获取任务详情（轮询）。"""
    task = await task_service.get_task(db, user.id, task_id)
    return envelope(_serialize(task))


@router.get("/tasks/{task_id}/stream")
async def stream_task(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """SSE 任务进度（直到终态）。"""
    await task_service.get_task(db, user.id, task_id)  # 校验归属

    async def event_gen() -> AsyncIterator[str]:
        while True:
            async with AsyncSessionLocal() as session:
                row = (
                    await session.execute(
                        select(GenerationTask).where(GenerationTask.id == task_id)
                    )
                ).scalar_one_or_none()
            if row is None:
                yield _chat.sse_chunk({"done": True, "error_code": ErrorCode.TASK_NOT_FOUND.value})
                return
            done = row.status in _TERMINAL
            yield _chat.sse_chunk(
                {
                    "id": row.id,
                    "status": row.status,
                    "progress": row.progress,
                    "demo": row.demo,
                    "result_urls": row.result_urls,
                    "error_code": row.error_code,
                    "done": done,
                }
            )
            if done:
                return
            await asyncio.sleep(1)

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@router.post("/tasks/{task_id}/pause")
async def pause_task(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """暂停任务（软暂停）。"""
    task = await task_service.pause(db, user.id, task_id)
    return envelope(_serialize(task))


@router.post("/tasks/{task_id}/resume")
async def resume_task(
    task_id: str,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """恢复任务（上游已终止时重新提交，复用预扣）。"""
    task = await task_service.resume(db, user.id, task_id)
    if task.status == "running":
        background_tasks.add_task(generate_service.run_task, task.id)
    return envelope(_serialize(task))


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """取消任务并幂等回滚预扣。"""
    task = await task_service.cancel(db, user.id, task_id)
    return envelope(_serialize(task))


@router.post("/tasks/{task_id}/seen")
async def mark_seen(
    task_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """标记结果已读。"""
    task = await task_service.mark_seen(db, user.id, task_id)
    return envelope(_serialize(task))
