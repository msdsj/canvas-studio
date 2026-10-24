"""统一的文本 LLM 入口：中转站优先，网关兜底。

为什么需要这层
--------------
平台里有两条文本模型链路：

1. **用户自己的「AI 中转站」**（`ai_providers` 表）——设置页里配的，
   Key 只存在该账号下，润色 / 对话 / 需求分析都该走这条；
2. **网关内置文本 provider**（系统级环境变量）——多租户共用的兜底。

在这之前，润色与对话走 1，而「意图分析」走 2。于是出现最让人困惑的一种故障：
用户明明在设置里看到「连接正常 · deepseek-v4.1-flash · 可用」，
点 AI 分析却回「意图分析服务暂时不可用」——两套配置，各说各话。

本模块把「用哪条链路」收敛为唯一规则：
**能解析到用户的 relay → 用它；解析不到或调用失败 → 回退网关。**
调用方只关心 `content / model / source`，不再自己拼 payload、不再重复处理降级。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import relay_service
from app.services.gateway_client import gateway_client
from app.utils.errors import AppError
from app.utils.logging import get_logger

logger = get_logger("app.text_llm")

DEFAULT_MODEL = "gpt-4o-mini"
#: 当用户没配中转站、网关也没指定模型时的兜底（与历史行为一致）
FALLBACK_ERROR = (
    "文本模型暂时不可用：请到「AI 中转站」检查连接（网关地址 / Key / 模型），"
    "测试通过后再试。"
)


@dataclass(slots=True)
class TextResult:
    """一次文本补全的结果。`source` 用于前端/日志如实标注走了哪条链路。"""

    content: str
    model: str
    source: Literal["relay", "gateway"]
    demo: bool = False


def _extract_gateway_content(result: Any) -> str:
    """从 OpenAI 风格响应里取助手文本（容忍 content 为分段数组）。"""
    if not isinstance(result, dict):
        return ""
    try:
        choices = result.get("choices") or []
        if not choices:
            return ""
        message = choices[0].get("message") or {}
        content = message.get("content")
        if isinstance(content, list):
            return "".join(
                str(item.get("text", "")) for item in content if isinstance(item, dict)
            )
        return str(content or "")
    except (AttributeError, IndexError, TypeError):
        return ""


async def complete(
    db: AsyncSession,
    user_id: str | None,
    messages: list[dict[str, Any]],
    *,
    json_mode: bool = False,
    temperature: float = 0.2,
    max_tokens: int | None = None,
    model: str | None = None,
    error_hint: str | None = None,
) -> TextResult:
    """跑一次文本补全。

    :param user_id: 有值时优先用该用户的中转站；为 None 直接走网关。
    :param error_hint: 两条链路都失败时给用户看的文案（各业务自己写更具体的引导）。
    """
    relay_target = None
    if user_id:
        try:
            relay_target = await relay_service.resolve(db, user_id)
        except AppError as exc:
            # 读取配置失败不该让整个功能挂掉：记录后直接走网关
            logger.warning("读取中转站配置失败，回退网关：%s", exc.message)
            relay_target = None

    if relay_target is not None:
        try:
            result = await relay_service.chat(
                db,
                user_id or "",
                messages,
                json_mode=json_mode,
                temperature=temperature,
                max_tokens=max_tokens,
                target=relay_target,
            )
            return TextResult(
                content=str(result.get("content") or ""),
                model=str(result.get("model") or relay_target.model or ""),
                source="relay",
            )
        except AppError as exc:
            logger.warning("中转站调用失败，回退网关：%s %s", exc.code, exc.message)

    payload: dict[str, Any] = {
        "model": model or DEFAULT_MODEL,
        "messages": messages,
        "stream": False,
        "temperature": temperature,
    }
    if max_tokens:
        payload["max_tokens"] = max_tokens
    try:
        result = await gateway_client.llm_completions(payload)
    except AppError as exc:
        logger.warning("网关文本模型调用失败：%s %s", exc.code, exc.message)
        raise AppError(exc.code, error_hint or FALLBACK_ERROR) from exc

    return TextResult(
        content=_extract_gateway_content(result),
        model=str(payload["model"]),
        source="gateway",
        demo=bool(result.get("demo")),
    )


__all__ = ["TextResult", "complete", "DEFAULT_MODEL"]
