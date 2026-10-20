"""FastAPI 应用入口：路由挂载、静态资源、异常处理、生命周期。"""
from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import AsyncSessionLocal, init_models
from app.routers import (
    ai,
    announcements,
    assets,
    auth,
    canvases,
    collab,
    chat,
    generate,
    health,
    me,
    onboarding,
    projects,
    quota,
    tasks,
    teams,
)
from app.routers import admin as admin_routers
from app.seed import run_seed
from app.services import config_service, scheduler
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import configure_logging, get_logger


def _json_safe(value: object) -> object:
    """递归清洗为 JSON 可序列化值。

    bytes / set / 自定义对象等无法被 JSONResponse 序列化，统一降级为字符串描述，
    避免异常处理器自身抛错导致 500。
    """
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, bytes | bytearray):
        return f"<{len(value)} bytes>"
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set):
        return [_json_safe(v) for v in value]
    return str(value)
logger = get_logger("app.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动：建表、seed、推送网关配置、启动调度器。"""
    configure_logging()
    await init_models()
    # 历史库补字段：create_all 不会给已有表加列，缺列会直接导致 500
    from app.migrations.run import _apply_column_patches

    await _apply_column_patches()
    async with AsyncSessionLocal() as db:
        await run_seed(db)
        await config_service.push_to_gateway(db)
    scheduler.start_scheduler()
    logger.info("%s 已启动", settings.app_name)
    yield
    scheduler.shutdown_scheduler()
    logger.info("%s 已关闭", settings.app_name)


_is_dev = settings.app_env.lower() in ("dev", "development", "local")

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    lifespan=lifespan,
    # 生产环境不暴露接口清单与 schema
    docs_url="/docs" if _is_dev else None,
    redoc_url="/redoc" if _is_dev else None,
    openapi_url="/openapi.json" if _is_dev else None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(AppError)
async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    """业务异常 → 统一包裹。"""
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.code.value, "data": exc.data, "message": exc.message},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    """参数校验异常 → VALIDATION_ERROR。

    注意：`exc.errors()` 的 `input` 字段可能包含 bytes（如 form-data 上传），
    直接交给 JSONResponse 会因无法序列化而抛TypeError，使处理器自身崩溃、
    把本应返回的 422 变成 500。这里先做JSON 安全清洗。
    """
    return JSONResponse(
        status_code=422,
        content={
            "code": ErrorCode.VALIDATION_ERROR.value,
            "data": _json_safe(exc.errors()),
            "message": "参数校验失败",
        },
    )


# 用户侧路由
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(projects.router)
app.include_router(canvases.router)
app.include_router(collab.router)
app.include_router(assets.router)
app.include_router(chat.router)
app.include_router(ai.router)
app.include_router(generate.router)
app.include_router(tasks.router)
app.include_router(quota.router)
app.include_router(announcements.router)
app.include_router(teams.router)
app.include_router(onboarding.onboarding_router)
app.include_router(onboarding.skills_router)
# 管理后台
app.include_router(admin_routers.router)

# 静态资源（本地图片直出）
_storage = Path(settings.storage_dir)
_storage.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_storage)), name="static")
