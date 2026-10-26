"""Pydantic Schema 聚合导出。

`compose_plan` 里的三个模型是**生图编排的唯一契约源**（R04），因此在这里显式导出：
任何模块要用契约都应该 `from app.schemas import ComposePlan`，而不是在 service 里
手写 dict 校验（否则字段一改就会出现两份定义）。
"""
from __future__ import annotations

from app.schemas.compose_plan import (
    ASPECTS,
    ASPECT_TO_SIZE,
    DEFAULT_NEGATIVE,
    DEFAULT_STYLE_TAGS,
    MAX_DISPATCH_PROMPT_CHARS,
    MAX_PROMPT_CHARS,
    MIN_PROMPT_CHARS,
    NEGATIVE_MARKER,
    PLAN_SCHEMA_VERSION,
    QUALITY_SUFFIX,
    ComposeAnalysis,
    ComposeAspect,
    ComposeOption,
    ComposeOptionJob,
    ComposePlan,
    StrictBase,
)

__all__ = [
    "ASPECTS",
    "ASPECT_TO_SIZE",
    "DEFAULT_NEGATIVE",
    "DEFAULT_STYLE_TAGS",
    "MAX_DISPATCH_PROMPT_CHARS",
    "MAX_PROMPT_CHARS",
    "MIN_PROMPT_CHARS",
    "NEGATIVE_MARKER",
    "PLAN_SCHEMA_VERSION",
    "QUALITY_SUFFIX",
    "ComposeAnalysis",
    "ComposeAspect",
    "ComposeOption",
    "ComposeOptionJob",
    "ComposePlan",
    "StrictBase",
]
