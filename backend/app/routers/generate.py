"""生成路由 `/api/generate/*`（含任务生命周期）。"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, Header, Query, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal, get_db
from app.deps import get_current_user, require_pro
from app.models.generation import GenerationTask
from app.models.user import User
from app.schemas.generate import GenerateImageRequest, PlanRequest
from app.schemas.task import GenerationTaskOut
from app.services import (
    asset_service,
    cutout_service,
    generate_service,
    plan_service,
    task_service,
)
from app.services import chat_service as _chat  # 复用 sse_chunk
from app.services.edit_handlers import load_handlers
from app.services.edit_ops import clean_region
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.pagination import normalize_page, paginated

router = APIRouter(prefix="/api/generate", tags=["generate"])

logger = logging.getLogger(__name__)

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
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
    prompt: str = Form(...),
    model: str = Form(default="gpt-image-2"),
    size: str = Form(default="1024x1024"),
    base_asset_id: str | None = Form(default=None),
    session_id: str | None = Form(default=None),
    canvas_id: str | None = Form(default=None),
    file: UploadFile | None = File(default=None),
    mask: UploadFile | None = File(default=None),
    guide: UploadFile | None = File(default=None),
    edit_mode: str | None = Form(default=None),
    edit_intensity: str | None = Form(default=None),
    region: str | None = Form(default=None),
    ops: str | None = Form(default=None),
    annotation_stats: str | None = Form(default=None),
    n: int = Form(default=1),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """创建编辑任务（参考图来自资产库或上传，幂等）。

    - `ops`：**结构化编辑操作**（推荐），JSON 数组，每项形如
      `{"region": {x,y,w,h}, "handler": "restyle|cutout|...", "prompt": "...", "intensity": "fine"}`；
      能力由注册表驱动，可按需扩展（见 `edit_handlers`）。产出数量随之自动规划：
      整图类能力合并为 1 张，素材类能力每区域各 1 张。
    - `region`：旧版纯几何选区（JSON），等价于全部按兜底能力处理，保留向后兼容；
    - `annotation_stats`：标注计数（JSON 字符串，如 `{"border":2,"marker":3,"doodle":1}`）。
      **只写日志、不入库**（R09 的验收就是日志里有这行）——标注是「未提交的临时意图」，
      提交时已被合成进 guideFile，原对象没有复用价值，落库只会带来迁移与清理成本。
    - `edit_mode=transparent`：对全部选区做就地透明化（免费，不消耗上游算力）；
    - `edit_intensity`：fine=精细修改（保结构，默认）；rebuild=重新生成（换主体）。
    """
    # 标注计数：容错解析，绝不因为一个统计字段让整次编辑失败
    if annotation_stats:
        try:
            stats = json.loads(annotation_stats)
        except ValueError:
            stats = annotation_stats
        logger.info("edit annotations: %s", stats)

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

    guide_url: str | None = None
    if guide is not None:
        guide_data = await guide.read()
        guide_asset = await generate_service.save_upload_as_asset(
            db, user.id, guide.filename or "edit-guide.png", guide.content_type or "image/png", guide_data
        )
        guide_url = guide_asset.url

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
            if isinstance(item, dict):
                cleaned = clean_region(item)
                if cleaned is not None:
                    normalized_regions.append(cleaned)
        edit_region = normalized_regions or None

    # 结构化编辑操作（能力注册表驱动）；非法项由服务层统一过滤与夹取
    edit_ops: list[dict[str, Any]] | None = None
    if ops:
        try:
            parsed_ops = json.loads(ops)
        except ValueError:
            parsed_ops = None
        if isinstance(parsed_ops, list):
            edit_ops = [item for item in parsed_ops if isinstance(item, dict)] or None

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
        edit_ops=edit_ops,
        edit_mode=edit_mode,
        edit_intensity=edit_intensity,
        extra={"guide_url": guide_url, "n": max(1, min(n, 4))} if guide_url else {"n": max(1, min(n, 4))},
    )
    if created:
        background_tasks.add_task(generate_service.run_task, task.id)
    return envelope(_serialize(task))


@router.post("/plan")
async def plan_edit(
    payload: PlanRequest,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """把自然语言需求解析为结构化编辑计划（只分析，不创建任务、不计费）。

    返回 `{reply, ops, outputs, summary, demo}`：前端可先展示给用户确认或微调，
    确认后再带 `ops` 调用 `POST /api/generate/edit` 真正执行。
    能力清单由注册表动态注入提示词——管理员新增能力后，分析结果自动支持它。
    """
    result = await plan_service.plan_edit(db, message=payload.message, regions=payload.regions)
    return envelope(result)


@router.get("/capabilities")
async def list_capabilities(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """列出当前可用的编辑能力（注册表驱动，前端据此渲染能力选择与说明）。"""
    handlers = await load_handlers(db)
    return envelope(
        {
            "handlers": [item.to_public() for item in handlers.values()],
            "cutout_strategies": cutout_service.available_strategies(),
        }
    )


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
