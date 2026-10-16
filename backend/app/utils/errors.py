"""统一错误码与业务异常。

错误码 → HTTP 状态映射见架构文档 §8.3。
"""
from __future__ import annotations

from enum import Enum
from typing import Any


class ErrorCode(str, Enum):
    """全局错误码枚举。"""

    OK = "OK"
    QUOTA_INSUFFICIENT = "QUOTA_INSUFFICIENT"
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    UPSTREAM_ERROR = "UPSTREAM_ERROR"
    POOL_UNAVAILABLE = "POOL_UNAVAILABLE"
    PROXY_UNREACHABLE = "PROXY_UNREACHABLE"
    TASK_NOT_FOUND = "TASK_NOT_FOUND"
    TASK_STATE_CONFLICT = "TASK_STATE_CONFLICT"
    TASK_LIMIT_EXCEEDED = "TASK_LIMIT_EXCEEDED"
    RATE_LIMITED = "RATE_LIMITED"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"


# 错误码 → HTTP 状态码
ERROR_HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.QUOTA_INSUFFICIENT: 402,
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.UPSTREAM_ERROR: 502,
    ErrorCode.POOL_UNAVAILABLE: 503,
    ErrorCode.PROXY_UNREACHABLE: 503,
    ErrorCode.TASK_NOT_FOUND: 404,
    ErrorCode.TASK_STATE_CONFLICT: 409,
    ErrorCode.TASK_LIMIT_EXCEEDED: 429,
    ErrorCode.RATE_LIMITED: 429,
    ErrorCode.VALIDATION_ERROR: 422,
    ErrorCode.NOT_FOUND: 404,
    ErrorCode.INTERNAL_ERROR: 500,
}

# 错误码 → 默认中文文案
ERROR_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.OK: "成功",
    ErrorCode.QUOTA_INSUFFICIENT: "额度不足，请联系管理员或查看额度明细",
    ErrorCode.UNAUTHORIZED: "未登录或登录已过期，请重新登录",
    ErrorCode.FORBIDDEN: "无权访问该资源",
    ErrorCode.UPSTREAM_ERROR: "上游服务繁忙或不可用，请稍后重试",
    ErrorCode.POOL_UNAVAILABLE: "当前无可用生图账号，请稍后重试",
    ErrorCode.PROXY_UNREACHABLE: "网络代理不可达，请检查服务器 VPN 配置",
    ErrorCode.TASK_NOT_FOUND: "任务不存在或已被清理",
    ErrorCode.TASK_STATE_CONFLICT: "任务当前状态不允许该操作",
    ErrorCode.TASK_LIMIT_EXCEEDED: "并发任务数已达上限，请稍候或先取消",
    ErrorCode.RATE_LIMITED: "操作过于频繁，请稍后再试",
    ErrorCode.VALIDATION_ERROR: "参数校验失败",
    ErrorCode.NOT_FOUND: "资源不存在",
    ErrorCode.INTERNAL_ERROR: "服务器内部错误",
}


class AppError(Exception):
    """业务异常：携带错误码、文案与可选附加数据。"""

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        status_code: int | None = None,
        data: Any | None = None,
    ) -> None:
        self.code = code
        self.message = message or ERROR_MESSAGES.get(code, "未知错误")
        self.status_code = status_code or ERROR_HTTP_STATUS.get(code, 400)
        self.data = data
        super().__init__(self.message)


def envelope(data: Any = None, message: str = "OK", code: ErrorCode = ErrorCode.OK) -> dict[str, Any]:
    """构造统一响应包裹 `{code,data,message}`。"""
    return {"code": code.value, "data": data, "message": message}
