"""网关统一错误码与异常。"""
from __future__ import annotations

from enum import Enum
from typing import Any


class ErrorCode(str, Enum):
    """网关错误码（与 backend §8.3 对齐）。"""

    OK = "OK"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    UPSTREAM_ERROR = "UPSTREAM_ERROR"
    POOL_UNAVAILABLE = "POOL_UNAVAILABLE"
    PROXY_UNREACHABLE = "PROXY_UNREACHABLE"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"


ERROR_HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.UPSTREAM_ERROR: 502,
    ErrorCode.POOL_UNAVAILABLE: 503,
    ErrorCode.PROXY_UNREACHABLE: 503,
    ErrorCode.VALIDATION_ERROR: 422,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.INTERNAL_ERROR: 500,
}

ERROR_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.OK: "成功",
    ErrorCode.UNAUTHORIZED: "内部令牌无效",
    ErrorCode.FORBIDDEN: "无权限访问上游",
    ErrorCode.UPSTREAM_ERROR: "上游服务不可用或返回错误",
    ErrorCode.POOL_UNAVAILABLE: "上游号池无可用账号",
    ErrorCode.PROXY_UNREACHABLE: "网络代理不可达，请检查服务器 VPN 配置",
    ErrorCode.VALIDATION_ERROR: "参数校验失败",
    ErrorCode.NOT_FOUND: "资源不存在",
    ErrorCode.INTERNAL_ERROR: "网关内部错误",
}


class GatewayError(Exception):
    """网关业务异常。"""

    def __init__(self, code: ErrorCode, message: str | None = None, data: Any = None) -> None:
        self.code = code
        self.message = message or ERROR_MESSAGES.get(code, "未知错误")
        self.status_code = ERROR_HTTP_STATUS.get(code, 502)
        self.data = data
        super().__init__(self.message)


def envelope(data: Any = None, message: str = "OK", code: ErrorCode = ErrorCode.OK) -> dict[str, Any]:
    """构造统一响应包裹。"""
    return {"code": code.value, "data": data, "message": message}
