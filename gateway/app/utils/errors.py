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
    UPSTREAM_FORMAT_ERROR = "UPSTREAM_FORMAT_ERROR"
    POOL_UNAVAILABLE = "POOL_UNAVAILABLE"
    PROXY_UNREACHABLE = "PROXY_UNREACHABLE"
    VALIDATION_ERROR = "VALIDATION_ERROR"
    NOT_FOUND = "NOT_FOUND"
    INTERNAL_ERROR = "INTERNAL_ERROR"


ERROR_HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.UNAUTHORIZED: 401,
    ErrorCode.FORBIDDEN: 403,
    ErrorCode.UPSTREAM_ERROR: 502,
    ErrorCode.UPSTREAM_FORMAT_ERROR: 502,
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
    ErrorCode.UPSTREAM_FORMAT_ERROR: "上游返回的内容不是可用数据格式（已重试并尝试备用模型）",
    ErrorCode.POOL_UNAVAILABLE: "上游号池无可用账号",
    ErrorCode.PROXY_UNREACHABLE: "网络代理不可达，请检查服务器 VPN 配置",
    ErrorCode.VALIDATION_ERROR: "参数校验失败",
    ErrorCode.NOT_FOUND: "资源不存在",
    ErrorCode.INTERNAL_ERROR: "网关内部错误",
}

#: 默认可重试的错误（网络抖动、上游 5xx、响应体格式坏）。可按调用点覆盖。
_DEFAULT_RETRYABLE: dict[ErrorCode, bool] = {
    ErrorCode.PROXY_UNREACHABLE: True,
    ErrorCode.UPSTREAM_ERROR: True,
    ErrorCode.UPSTREAM_FORMAT_ERROR: True,
}

#: 默认「换备用模型有意义」的错误。连接不上属于地址问题，换模型名救不了，故不在列。
_DEFAULT_SWITCH_MODEL: dict[ErrorCode, bool] = {
    ErrorCode.UPSTREAM_ERROR: True,
    ErrorCode.UPSTREAM_FORMAT_ERROR: True,
}


class GatewayError(Exception):
    """网关业务异常。

    `retryable` / `switch_model` 是给 `resilience.run_with_fallback` 的决策开关：
    默认按错误码推导，HTTP 语义更细的场景（如 401 不该重试）由 `classify_status` 显式覆盖。
    """

    def __init__(
        self,
        code: ErrorCode,
        message: str | None = None,
        data: Any = None,
        *,
        retryable: bool | None = None,
        switch_model: bool | None = None,
    ) -> None:
        self.code = code
        self.message = message or ERROR_MESSAGES.get(code, "未知错误")
        self.status_code = ERROR_HTTP_STATUS.get(code, 502)
        self.data = data
        self.retryable = _DEFAULT_RETRYABLE.get(code, False) if retryable is None else retryable
        self.switch_model = _DEFAULT_SWITCH_MODEL.get(code, False) if switch_model is None else switch_model
        super().__init__(self.message)


def envelope(data: Any = None, message: str = "OK", code: ErrorCode = ErrorCode.OK) -> dict[str, Any]:
    """构造统一响应包裹。"""
    return {"code": code.value, "data": data, "message": message}
