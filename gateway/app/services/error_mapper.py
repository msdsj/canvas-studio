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
    """按上游 HTTP 状态与响应体归一错误。

    同时给出 `retryable` / `switch_model` 两个决策开关：HTTP 状态码本身已经说明了
    「该不该重试」——401 是 Key 错了，重试和换模型都是白费；429 / 5xx 才值得。
    这比只按错误码（400/401/403/404 全都归 UPSTREAM_ERROR）判断要准得多。
    """
    lowered = (body_text or "").lower()
    if any(hint in lowered for hint in _POOL_HINTS):
        # 号池「暂时排不上」是瞬时容量问题：同一模型等几秒往往就能拿到账号。
        # 这里标记为可重试（不换模型——换模型不会凭空多出账号），
        # 由 `resilience` 用更长的退避等待，避免用户刚点一次就直接失败。
        return GatewayError(
            ErrorCode.POOL_UNAVAILABLE,
            "上游号池繁忙：已自动轮换账号重试，暂未拿到可用额度，请稍后再试",
            retryable=True,
            switch_model=False,
        )
    if status in (401, 403):
        return GatewayError(
            ErrorCode.UPSTREAM_ERROR,
            "上游鉴权失败，请检查 Key 配置",
            retryable=False,
            switch_model=False,
        )
    if status == 404:
        return GatewayError(
            ErrorCode.UPSTREAM_ERROR, "上游接口不存在", retryable=False, switch_model=False
        )
    if status == 429:
        # 限流往往是「这个 Key / 这个模型」的额度问题，换一个模型可能就有额度
        return GatewayError(
            ErrorCode.UPSTREAM_ERROR, "上游限流，请稍后重试", retryable=True, switch_model=True
        )
    if status >= 500:
        return GatewayError(
            ErrorCode.UPSTREAM_ERROR, f"上游返回 {status}", retryable=True, switch_model=True
        )
    return GatewayError(
        ErrorCode.UPSTREAM_ERROR, f"上游返回 {status}", retryable=False, switch_model=False
    )


def raise_for_status(status: int, body_text: str = "") -> None:
    """非 2xx 抛出归一后的 GatewayError。"""
    if status >= 400:
        raise classify_status(status, body_text)
