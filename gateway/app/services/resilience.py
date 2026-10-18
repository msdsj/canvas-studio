"""模型链韧性调用：同模型重试 → 换备用模型 → 如实报错。

与 backend `relay_chain` 同源思路（那边服务文本 / 对话链路），这里服务网关侧的
直连对话与生图链路：上游把网页、半截 JSON 当 200 返回时，先原地重试，再依次换备用
模型；全部失败就抛出带明确错误码的 GatewayError，绝不伪装成成功。

是否重试 / 是否值得换模型由 `GatewayError.retryable` / `.switch_model` 决定——
这两个标记在 `classify_status` 里按 HTTP 语义给出（401 不重试也不换模型，
429 / 5xx 才重试，格式异常两者都做）。
"""
from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Awaitable, Callable
from typing import TypeVar

from app.config import settings
from app.services.error_mapper import classify_exception
from app.utils.errors import ErrorCode, GatewayError

logger = logging.getLogger("gateway.resilience")

T = TypeVar("T")


async def run_with_fallback(
    chain: list[str],
    attempt: Callable[[str], Awaitable[T]],
    *,
    max_retries: int | None = None,
    base_delay: float = 0.4,
) -> T:
    """按模型链依次尝试；每个模型先原地重试，重试用尽再换下一个模型。"""
    retries = settings.max_retries if max_retries is None else max_retries
    models = chain or [""]
    last: GatewayError | None = None

    for index, model in enumerate(models):
        for attempt_no in range(retries + 1):
            try:
                return await attempt(model)
            except Exception as exc:  # noqa: BLE001 - 统一归一后再判定
                error = exc if isinstance(exc, GatewayError) else classify_exception(exc)
                last = error
                if not error.retryable:
                    raise error
                if attempt_no < retries:
                    delay = base_delay * (2**attempt_no) + random.uniform(0, 0.2)
                    logger.warning(
                        "上游调用失败（%s），%.1fs 后重试同一模型 %s：%s",
                        error.code.value,
                        delay,
                        model or "(默认)",
                        error.message,
                    )
                    await asyncio.sleep(delay)
                    continue
                break

        next_model = models[index + 1] if index + 1 < len(models) else None
        if next_model is not None and last is not None and last.switch_model:
            logger.warning(
                "模型 %s 重试用尽（%s），切换备用模型 %s",
                model or "(默认)",
                last.code.value,
                next_model,
            )
            continue
        break

    if last is None:  # chain 为空时 models 至少含一个空串，正常不可达
        raise GatewayError(ErrorCode.UPSTREAM_ERROR, "上游调用失败")
    raise last
