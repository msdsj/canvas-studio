"""上游错误归一：把异常 / 状态码映射为统一错误码。"""
from __future__ import annotations

import httpx

from app.utils.errors import ErrorCode, GatewayError

# 上游提示"无可用账号"的关键字
_POOL_HINTS = (
    "no available image quota",
    "no available account",
    "no available",
    "pool",
    "号池",
    "无可用",
)


def classify_exception(exc: Exception) -> GatewayError:
    """按异常类型归一错误。"""
    if isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout)):
        return GatewayError(ErrorCode.PROXY_UNREACHABLE)
    if isinstance(exc, httpx.TimeoutException):
        return GatewayError(ErrorCode.UPSTREAM_ERROR, "上游请求超时")
    if isinstance(exc, GatewayError):
        return exc
    return GatewayError(ErrorCode.UPSTREAM_ERROR, str(exc))


def classify_status(status: int, body_text: str = "") -> GatewayError:
    """按上游 HTTP 状态与响应体归一错误。"""
    lowered = (body_text or "").lower()
    if any(hint in lowered for hint in _POOL_HINTS):
        return GatewayError(ErrorCode.POOL_UNAVAILABLE, "上游号池无可用账号")
    if status in (401, 403):
        return GatewayError(ErrorCode.UPSTREAM_ERROR, "上游鉴权失败，请检查 Key 配置")
    if status == 404:
        return GatewayError(ErrorCode.UPSTREAM_ERROR, "上游接口不存在")
    if status == 429:
        return GatewayError(ErrorCode.UPSTREAM_ERROR, "上游限流，请稍后重试")
    if status >= 500:
        return GatewayError(ErrorCode.UPSTREAM_ERROR, f"上游返回 {status}")
    return GatewayError(ErrorCode.UPSTREAM_ERROR, f"上游返回 {status}")


def raise_for_status(status: int, body_text: str = "") -> None:
    """非 2xx 抛出归一后的 GatewayError。"""
    if status >= 400:
        raise classify_status(status, body_text)
