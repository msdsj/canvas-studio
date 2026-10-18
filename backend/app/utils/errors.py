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
    PRO_REQUIRED = "PRO_REQUIRED"
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
    # 上游返回的响应体不是可用的数据（网页 / 空体 / 截断 / 结构不对）。
    # 只新增这一个码：其余 14 个复用既有语义，保证一期错误码行为零变化（ADR-7）。
    UPSTREAM_FORMAT_ERROR = "UPSTREAM_FORMAT_ERROR"


# 错误码 → HTTP 状态码
ERROR_HTTP_STATUS: dict[ErrorCode, int] = {
    ErrorCode.QUOTA_INSUFFICIENT: 402,
    ErrorCode.PRO_REQUIRED: 402,
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
    ErrorCode.UPSTREAM_FORMAT_ERROR: 502,
}

# 错误码 → 默认中文文案（用户可见，禁止出现「上游 / 网关 / 号池 / 代理 / 服务器」等内部词）
ERROR_MESSAGES: dict[ErrorCode, str] = {
    ErrorCode.OK: "成功",
    ErrorCode.QUOTA_INSUFFICIENT: "这次需要的额度不够了，去「用量」看看明细",
    ErrorCode.PRO_REQUIRED: "这是 Pro 功能，激活 Pro 后就能用了",
    ErrorCode.UNAUTHORIZED: "登录状态过期了，重新登录就能继续",
    ErrorCode.FORBIDDEN: "这部分内容你没有权限",
    ErrorCode.UPSTREAM_ERROR: "图片没生成出来，额度已经退回给你",
    ErrorCode.POOL_UNAVAILABLE: "现在有点忙，暂时排不上，等一分钟再试",
    ErrorCode.PROXY_UNREACHABLE: "网络不太稳定，检查一下网络再试",
    ErrorCode.TASK_NOT_FOUND: "这条记录已经过期清掉了，重新发起一次吧",
    ErrorCode.TASK_STATE_CONFLICT: "这一步已经做过了，刷新看看最新进度",
    ErrorCode.TASK_LIMIT_EXCEEDED: "同时生成的数量有点多，等一张完成或先停一张",
    ErrorCode.RATE_LIMITED: "操作有点快，缓一下再试",
    ErrorCode.VALIDATION_ERROR: "填写的内容需要调整一下",
    ErrorCode.NOT_FOUND: "没找到你要的内容",
    ErrorCode.INTERNAL_ERROR: "服务开了个小差，稍等片刻再试",
    # 兜底文案：正常情况下前端按 `data.reason` 渲染 i18n 文案，这句不会上屏。
    # 刻意不含 json / html / HTTP / 异常类名（R01 硬性要求）。
    ErrorCode.UPSTREAM_FORMAT_ERROR: "这次没能拿到可用的结果，换一个模型再试一次",
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
