"""生成路由 `/api/generate/*`（含任务生命周期）。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
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
    access,
    asset_service,
    generate_service,
    param_service,
    plan_service,
    queue_service,
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


def _serialize(task: GenerationTask | dict[str, Any]) -> dict:
    """序列化任务输出。

    列表接口返回的是普通 dict（绕开 ORM 实体化，见 task_service.list_tasks），
    详情接口返回实体；Pydantic 两种都能校验。
    """
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
    # 参数自适应：size=auto 时按「文本里的比例 > 文本里的像素 > 场景语义」推断，
    # 绝不再给全局正方形兜底（见 param_service 模块注释）。
    resolved = param_service.infer(
        payload.prompt,
        kind="generate",
        override_size=None if payload.size in {"", "auto"} else payload.size,
        override_aspect=str(payload.params.get("aspect") or "") or None,
    )
    ctx = await access.current_context(db, user)
    task, created = await generate_service.create_image_task(
        db,
        user.id,
        prompt=payload.prompt,
        model=payload.model,
        size=resolved["size"],
        quality=payload.quality if payload.quality != "auto" else resolved["quality"],
        n=payload.n,
        session_id=payload.session_id,
        canvas_id=payload.canvas_id,
        idempotency_key=key,
        extra={**payload.params, "aspect": resolved["aspect"], "param_source": resolved["source"]},
        team=ctx.team,
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
    - `edit_mode=transparent`：请求图像模型把选区处理为透明像素，按编辑单价计费；
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
    ctx = await access.current_context(db, user)
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
        team=ctx.team,
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
    result = await plan_service.plan_edit(
        db,
        message=payload.message,
        regions=payload.regions,
        history=payload.history,
        canvas=payload.canvas,
        user_id=user.id,
    )
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
        }
    )


@router.get("/param-presets")
async def list_param_presets(user: User = Depends(get_current_user)) -> dict:
    """画幅预设 + 场景规则：前端参数面板与产品文档共用一份定义。"""
    return envelope(
        {
            "presets": param_service.presets(),
            "scenes": param_service.scene_rules(),
            "default_aspect": param_service.DEFAULT_ASPECT,
        }
    )


@router.post("/params")
async def infer_params(
    payload: dict[str, Any],
    user: User = Depends(get_current_user),
) -> dict:
    """根据需求文本推断画幅/质量/强度（只读，不创建任务、不计费）。

    前端在输入框里防抖调用它，参数面板实时显示「系统会按 16:9 出图」，
    用户也可以随时手动覆盖。
    """
    text = str(payload.get("prompt") or payload.get("message") or "")
    kind = "edit" if str(payload.get("kind") or "generate") == "edit" else "generate"
    source = payload.get("source_image") if isinstance(payload.get("source_image"), dict) else None
    source_size = None
    if source:
        try:
            source_size = (int(source.get("width")), int(source.get("height")))
        except (TypeError, ValueError):
            source_size = None
    result = param_service.infer(
        text,
        kind=kind,
        override_size=str(payload.get("size") or "") or None,
        override_aspect=str(payload.get("aspect") or "") or None,
        source_image=source_size,
    )
    return envelope(result)


@router.get("/queue")
async def queue_status(user: User = Depends(get_current_user)) -> dict:
    """生成队列的实时水位（前端展示「前面还有 N 个任务」）。"""
    return envelope(queue_service.snapshot())


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
        # 只取推送需要的 5 个列，**不要** select 整个 ORM 对象：
        # `params` 里装着 ops、thinking、引导图 URL 等大字段，每秒反序列化一次纯属浪费。
        # 一个 330s 的生图任务在旧实现下要读 330 次整行，高并发时这里是隐形热点。
        stmt = select(
            GenerationTask.status,
            GenerationTask.progress,
            GenerationTask.demo,
            GenerationTask.result_urls,
            GenerationTask.error_code,
        ).where(GenerationTask.id == task_id)

        # 退避：前 10s 密集（进度从 30→35→60 变化快，用户正盯着看），
        # 之后逐步放宽到 3s。任务绝大多数时间都在等上游，没必要每秒打一次库。
        started = time.monotonic()
        while True:
            async with AsyncSessionLocal() as session:
                row = (await session.execute(stmt)).first()
            if row is None:
                yield _chat.sse_chunk({"done": True, "error_code": ErrorCode.TASK_NOT_FOUND.value})
                return
            status, progress, demo, result_urls, error_code = row
            done = status in _TERMINAL
            yield _chat.sse_chunk(
                {
                    "id": task_id,
                    "status": status,
                    "progress": progress,
                    "demo": demo,
                    "result_urls": result_urls,
                    "error_code": error_code,
                    "done": done,
                }
            )
            if done:
                return
            elapsed = time.monotonic() - started
            await asyncio.sleep(0.5 if elapsed < 10 else 1.5 if elapsed < 60 else 3.0)

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


@router.post("/tasks/{task_id}/retry")
async def retry_task(
    task_id: str,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> dict:
    """重试失败/超时/已取消的任务（复制成新任务，重新扣费与执行）。"""
    ctx = await access.current_context(db, user)
    key = idempotency_key or generate_service.new_idempotency_key()
    task, created = await task_service.clone_for_retry(
        db, user.id, task_id, idempotency_key=key, team=ctx.team
    )
    if created:
        background_tasks.add_task(generate_service.run_task, task.id)
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
