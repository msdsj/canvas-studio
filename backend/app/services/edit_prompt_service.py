"""编辑指令优化：把用户的随口描述，整理成图像模型能直接执行的指令。

链路位置：
    用户框选 + 描述 → 本模块（对话模型改写）→ 上游图像模型生成

设计原则：
- **失败绝不阻断主流程**：优化失败就用用户原话，宁可差一点也不能卡住。
- **不改变结构**：只允许改写每条【区域N】后面的内容，编号数量必须一致，
  否则视为无效结果直接丢弃（防止模型把区域合并/重排）。
"""
from __future__ import annotations

import asyncio
import re

from sqlalchemy.ext.asyncio import AsyncSession

from app.services import config_service, prompt_service
from app.services.gateway_client import gateway_client
from app.utils.logging import get_logger

logger = get_logger("app.edit_prompt_service")

DEFAULT_MODEL = "gpt-4o-mini"
OPTIMIZE_TIMEOUT_SECONDS = 20.0
_REGION_MARK = re.compile(r"【区域\s*(\d+)\s*】")
_FENCE = re.compile(r"```[a-zA-Z]*\s*(.*?)```", re.DOTALL)
_MAX_CHARS = 1200


def _extract_content(result: dict) -> str:
    """从 OpenAI 风格响应里取正文。"""
    choices = result.get("choices") or []
    if not choices:
        return ""
    message = choices[0].get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "".join(
            str(item.get("text", "")) for item in content if isinstance(item, dict)
        )
    return ""


def _strip_fence(text: str) -> str:
    """去掉模型偶尔加上的代码围栏。"""
    fenced = _FENCE.search(text)
    return (fenced.group(1) if fenced else text).strip()


def _valid(original: str, candidate: str) -> bool:
    """结构校验：区域数量一致、长度可控、不是空话。"""
    if not candidate or len(candidate) > _MAX_CHARS:
        return False
    expected = _REGION_MARK.findall(original)
    actual = _REGION_MARK.findall(candidate)
    if expected and expected != actual:
        return False
    # 没有区域标记时（纯涂鸦/整体编辑），至少要求内容不缩水
    if not expected and len(candidate) < 8:
        return False
    return True


async def optimize(
    db: AsyncSession | None,
    instruction: str,
    *,
    model: str | None = None,
) -> tuple[str, bool]:
    """优化编辑指令。

    :return: ``(最终指令, 是否由模型改写)``；失败时返回原指令与 ``False``。
    """
    text = (instruction or "").strip()
    if not text:
        return "", False

    try:
        template = await prompt_service.load(db, "edit_optimizer")
        system_prompt = prompt_service.render(template, instruction=text)
        configured = str(await config_service.get_value(db, "LLM_MODEL", "")).strip() if db else ""
        model_name = (
            model
            or configured
            or str(
                await config_service.get_value(db, "INTENT_PLANNER_MODEL", DEFAULT_MODEL)
                if db
                else DEFAULT_MODEL
            ).strip()
            or DEFAULT_MODEL
        )
        # 改写是"锦上添花"，不能把整个任务拖住：20 秒拿不到就直接用原话
        result = await asyncio.wait_for(
            gateway_client.llm_completions(
                {
                    "model": model_name,
                    "messages": [
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": text},
                    ],
                    "stream": False,
                    "temperature": 0.3,
                }
            ),
            timeout=OPTIMIZE_TIMEOUT_SECONDS,
        )
        candidate = _strip_fence(_extract_content(result))
        if not _valid(text, candidate):
            logger.warning("指令优化结果不合法，回退原指令：%s", candidate[:160])
            return text, False
        return candidate, True
    except Exception as exc:  # noqa: BLE001 - 优化失败不阻断生成
        logger.warning("指令优化失败，回退原指令：%s", exc)
        return text, False
