"""网关入口：内部令牌中间件、路由挂载、异常处理。"""
from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from app.config import settings
from app.routers import chat, config, health, images, pool
from app.utils.errors import ErrorCode, GatewayError, envelope

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)-7s | %(name)s | %(message)s",
)
logger = logging.getLogger("gateway.main")

app = FastAPI(title=settings.app_name, version=settings.app_version)


@app.middleware("http")
async def internal_token_guard(request: Request, call_next):
    """校验内部令牌：`/gw/*` 需携带正确的 `X-Internal-Token`。"""
    if request.url.path.startswith("/gw/"):
        token = request.headers.get("X-Internal-Token")
        if token != settings.internal_token:
            return JSONResponse(
                status_code=401,
                content=envelope(None, "内部令牌无效", ErrorCode.UNAUTHORIZED),
            )
    return await call_next(request)


@app.exception_handler(GatewayError)
async def gateway_error_handler(_: Request, exc: GatewayError) -> JSONResponse:
    """网关业务异常 → 统一包裹。"""
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.code.value, "data": exc.data, "message": exc.message},
    )


@app.exception_handler(Exception)
async def unhandled_error_handler(_: Request, exc: Exception) -> JSONResponse:
    """兜底异常处理。"""
    logger.exception("未处理异常: %s", exc)
    return JSONResponse(
        status_code=500,
        content=envelope(None, str(exc), ErrorCode.INTERNAL_ERROR),
    )


app.include_router(health.router)
app.include_router(chat.router)
app.include_router(images.router)
app.include_router(pool.router)
app.include_router(config.router)
