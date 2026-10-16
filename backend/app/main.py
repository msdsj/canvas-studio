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
    announcements,
    assets,
    auth,
    canvases,
    chat,
    generate,
    health,
    me,
    projects,
    quota,
    tasks,
)
from app.routers import admin as admin_routers
from app.seed import run_seed
from app.services import config_service, scheduler
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import configure_logging, get_logger

logger = get_logger("app.main")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """启动：建表、seed、推送网关配置、启动调度器。"""
    configure_logging()
    await init_models()
    async with AsyncSessionLocal() as db:
        await run_seed(db)
        await config_service.push_to_gateway(db)
    scheduler.start_scheduler()
    logger.info("%s 已启动", settings.app_name)
    yield
    scheduler.shutdown_scheduler()
    logger.info("%s 已关闭", settings.app_name)


app = FastAPI(title=settings.app_name, version=settings.app_version, lifespan=lifespan)

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
    """参数校验异常 → VALIDATION_ERROR。"""
    return JSONResponse(
        status_code=422,
        content={
            "code": ErrorCode.VALIDATION_ERROR.value,
            "data": exc.errors(),
            "message": "参数校验失败",
        },
    )


# 用户侧路由
app.include_router(health.router)
app.include_router(auth.router)
app.include_router(me.router)
app.include_router(projects.router)
app.include_router(canvases.router)
app.include_router(assets.router)
app.include_router(chat.router)
app.include_router(generate.router)
app.include_router(tasks.router)
app.include_router(quota.router)
app.include_router(announcements.router)
# 管理后台
app.include_router(admin_routers.router)

# 静态资源（本地图片直出）
_storage = Path(settings.storage_dir)
_storage.mkdir(parents=True, exist_ok=True)
app.mount("/static", StaticFiles(directory=str(_storage)), name="static")
