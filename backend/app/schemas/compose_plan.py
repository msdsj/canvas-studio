"""生图编排的输出契约（**唯一来源**，R04）。

为什么要有它
------------
一期的问题不是「模型不听话」，而是「模型输出没有契约」：`skill_id` 取不到就静默
丢弃、回退到 `shortlisted[0]`；比例字段叫 `size` 而 PRD 要求 `aspect`；提示词长度
上限散落在三个常量里。格式漂移时**只能丢弃、不能纠偏**。

本文件是 analyze / reason / prompt 三个阶段共用的唯一契约源：
- 字段名、类型、枚举、长度上限只在这里写一次；
- `model_json_schema()` 导出到 `docs/compose-plan.schema.json`，前端据此做
  「字段集合相等」断言（R04 的可验证标准）；
- 校验错误（`ValidationError.errors()`）的 `loc` + `msg` 正好是 R05 要的
  「字段路径 + 期望」，不需要二次解析。

口径说明（架构 §0）
------------------
- **C1**：plan 新增 `aspect`（5 值枚举），`size` 降级为派生字段（`ASPECT_TO_SIZE`）；
- **C2**：契约上限 800（约束模型产出），派发兜底上限仍是 3800（`verbatim` 不受 800 约束）；
- **R06**：`negative` 是折进 `final_prompt` 尾部的（上游没有独立负向参数），
  所以「负向段」的校验对象是**拼装后的最终提示词**，不是 plan 原始字段。
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

#: 契约版本：字段变更时 +1，前端据此判断是否需要迁移
PLAN_SCHEMA_VERSION = 2

#: 比例枚举（**唯一来源**）。改这里等于改全站契约。
ComposeAspect = Literal["1:1", "3:4", "4:3", "9:16", "16:9"]

#: 枚举的运行时视图（校验 / 归一 / 测试都用它，避免各处手写字符串列表）
ASPECTS: tuple[str, ...] = ("1:1", "3:4", "4:3", "9:16", "16:9")

#: `aspect → size` 映射（C1）。`9:16` 与 `3:4`、`16:9` 与 `4:3` 落到同一个上游尺寸，
#: 这是上游能力上限，不是实现缺陷。
ASPECT_TO_SIZE: dict[str, str] = {
    "1:1": "1024x1024",
    "3:4": "1024x1536",
    "4:3": "1536x1024",
    "9:16": "1024x1536",
    "16:9": "1536x1024",
}

#: 提示词长度下限：低于它说明模型没真正写画面（R06）
MIN_PROMPT_CHARS = 40
#: 提示词长度上限：契约上限（C2）。超出走纠错重试，3 次后截断并标记 `prompt_truncated`
MAX_PROMPT_CHARS = 800
#: 派发兜底上限（一期既有值）：`verbatim` 是用户原话，不受 800 约束
MAX_DISPATCH_PROMPT_CHARS = 3800

#: 负向描述段的分隔标记。上游没有独立负向参数，`negative` 折在提示词尾部，
#: 校验「尾部是否含负向段」就靠这个标记（R06）。
NEGATIVE_MARKER = "画面中避免出现："

#: 技能没给 `negative` 时的兜底负向词（真实容易画坏的东西，不是通用「低质量」堆砌）
DEFAULT_NEGATIVE = "低清晰度、模糊、畸变、多余手指、文字错乱、水印、裁切不当"

#: 平台内置画质强化后缀：每次派发生图/编辑时自动追加，让成片更清晰锐利。
#: 用户原话已经写了画质词时不再重复（见 `plan_validator.assemble_dispatch_prompt`）。
QUALITY_SUFFIX = "，超高清画质，4K/8K 细节，清晰锐利，无噪点"

#: 技能没有任何 `style_tags` 时的兜底（保证 R06 的「含 ≥1 个 style_tag」可满足）
DEFAULT_STYLE_TAGS: tuple[str, ...] = ("高清质感", "构图完整")


class StrictBase(BaseModel):
    """所有编排契约的基类：多一个字段就判失败（R05 的「多余字段」用例）。

    `extra_notes` 是给模型的**合法出口**：它想解释什么就写这里，不要往
    `final_prompt` 里塞，也不要乱加字段。纠错提示里会明确写这一条。
    """

    model_config = ConfigDict(
        extra="forbid",
        str_strip_whitespace=True,
        populate_by_name=True,
    )

    extra_notes: str | None = Field(default=None, max_length=200)


class ComposeAnalysis(StrictBase):
    """analyze 阶段的输出契约。

    只约束「判断需求够不够明确」所必需的三个字段。注意：线上 analyze 的提示词
    还会让模型输出 `summary` / `thinking` / `ambiguity` 等展示字段，那些**不属**本
    契约，校验时只投影这三个字段（见 `plan_validator.validate_analysis`）。
    """

    subject: str = Field(min_length=1, max_length=120)
    aspect: str | None = Field(default=None, max_length=32)
    missing: list[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    ] = Field(default_factory=list, max_length=5)
    confidence: float = Field(ge=0, le=1)


class ComposeOption(StrictBase):
    """澄清卡的一个方案选项。

    `aspect` 是契约字段；上游提示词让模型给的是 `size`，归一函数会按 `ASPECT_TO_SIZE`
    的反向映射补上 `aspect`（见 `plan_validator.aspect_from_size`）。
    """

    id: str = Field(min_length=1, max_length=8)
    label: str = Field(min_length=1, max_length=40)
    description: str = Field(default="", max_length=120)
    prompt: str = Field(min_length=1, max_length=MAX_PROMPT_CHARS)
    aspect: ComposeAspect
    image_count: int = Field(default=1, ge=1, le=12)


class ComposePlan(StrictBase):
    """最终方案（前端消费的唯一契约，R04）。

    字段名集合被 `frontend/scripts/check-plan-schema.mjs` 与
    `frontend/src/lib/api/chat.ts` 的 `ComposePlan` 断言相等——改字段只改这里。
    """

    #: 后端写入，模型不产出
    schema_version: int = Field(default=PLAN_SCHEMA_VERSION)
    title: str = Field(min_length=1, max_length=60)
    subject: str = Field(min_length=1, max_length=120)
    aspect: ComposeAspect
    negative: str = Field(min_length=1, max_length=200)
    final_prompt: str = Field(min_length=MIN_PROMPT_CHARS, max_length=MAX_PROMPT_CHARS)
    skill_id: str = Field(min_length=1, max_length=80)
    style_tags: list[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=40)]
    ] = Field(min_length=1, max_length=5)
    reasoning: list[
        Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    ] = Field(min_length=1, max_length=4)
    source: Literal["relay", "template_fallback", "verbatim"] = "relay"
    prompt_truncated: bool = False

    @field_validator("schema_version")
    @classmethod
    def _check_version(cls, value: int) -> int:
        """版本号必须与代码一致：否则说明这份输出来自另一套契约。"""
        if value != PLAN_SCHEMA_VERSION:
            raise ValueError(f"schema_version 必须是 {PLAN_SCHEMA_VERSION}")
        return value
