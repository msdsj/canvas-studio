"""AI 中转站 / 技能库 / 润色 相关 Schema。"""
from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.schemas.common import ORMModel


ProviderKind = Literal["claude", "codex", "deepseek", "openai", "compatible"]


class ProviderUpsertRequest(BaseModel):
    """新增 / 更新中转站配置。

    所有字段都可留空——本期是「预留配置位」：框架先跑通，值由用户后续填入。
    """

    name: str = Field(default="", max_length=80)
    kind: ProviderKind = "compatible"
    base_url: str = Field(default="", max_length=500)
    api_key: str = Field(default="", max_length=500)
    model: str = Field(default="", max_length=120)
    # 备用模型链（0–3 个有序）：服务端会 strip / 去空 / 去重 / 去掉等于主模型的项 / 截断到 3。
    # 传 None 表示「不改这一项」（PATCH 语义），传 [] 表示清空。
    fallback_models: list[str] | None = Field(default=None, max_length=12)
    temperature: float = Field(default=0.7, ge=0, le=2)
    max_tokens: int = Field(default=2048, ge=64, le=32000)
    extra: dict[str, Any] = Field(default_factory=dict)
    supports_vision: bool = False
    is_active: bool = False
    # 显式清除已保存的 Key：比「传空字符串」明确——空字符串有歧义（是清空还是没填）
    clear_api_key: bool = False


class ProviderOut(ORMModel):
    """中转站输出（api_key 只给掩码提示，绝不给明文）。"""

    id: str
    name: str
    kind: str
    base_url: str
    model: str
    # 备用模型链（已归一：≤3、去重、不含主模型）
    fallback_models: list[str] = Field(default_factory=list)
    temperature: float
    max_tokens: int
    extra: dict[str, Any] = Field(default_factory=dict)
    supports_vision: bool
    is_active: bool
    key_hint: str = ""
    has_key: bool = False
    last_test_ok: bool | None = None
    last_test_at: datetime | None = None
    last_test_message: str = ""
    created_at: datetime | None = None
    updated_at: datetime | None = None


class ProviderTestRequest(BaseModel):
    """连通性测试（可带临时草稿，未保存也能先测）。"""

    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    kind: ProviderKind | None = None
    supports_vision: bool | None = None


class RelayStatusOut(BaseModel):
    """中转站就绪状态：前端据此决定「能不能开始」而不是让用户猜。"""

    configured: bool
    source: str = "none"  # user | global | none
    provider_name: str = ""
    model: str = ""
    kind: str = ""
    reason: str = ""
    skills_count: int = 0
    # 用户配置的备用模型原始值（已归一，≤3）
    fallback_models: list[str] = Field(default_factory=list)
    # 实际会遍历的链（含跨 provider 互备的第 4 个）；与 fallback_models 不同的原因见 ADR-3
    chain_preview: list[str] = Field(default_factory=list)
    # 跨 provider 互备候选（只给 id / name / model，不含 base_url 与 Key）
    backup_provider: dict[str, Any] | None = None


class PolishRequest(BaseModel):
    """提示词润色请求。"""

    text: str = Field(min_length=1, max_length=4000)
    # composer=主输入框 / region=框选区域气泡 / sidebar=侧边栏输入框
    scene: Literal["composer", "region", "sidebar"] = "composer"
    # auto=智能 / specific=更具体 / professional=更专业 / concise=更简洁
    # english=英文提示词 / fix=修歧义
    mode: Literal["auto", "specific", "professional", "concise", "english", "fix"] = "auto"
    # 变体数量：给用户 1–3 个可选方向，而不是只给一个答案
    variants: int = Field(default=2, ge=1, le=3)
    # 可选的场景线索（技能 id、画幅、区域能力），只用于让润色更贴题
    context: dict[str, Any] = Field(default_factory=dict)


class PolishVariant(BaseModel):
    """一个润色结果。"""

    id: str
    label: str
    text: str
    notes: list[str] = Field(default_factory=list)
    length: int = 0


class PolishResult(BaseModel):
    """润色结果：`engine=local` 表示未配置中转站、走了本地规则，前端要如实标注。"""

    # 兼容旧调用：等于 variants[0].text
    text: str
    variants: list[PolishVariant] = Field(default_factory=list)
    original: str = ""
    mode: str = "auto"
    engine: str = "local"
    model: str = ""
    elapsed_ms: int = 0


class DesignSkillOut(BaseModel):
    """一条设计技能。"""

    id: str
    name: str
    category: str
    description: str
    when_to_use: str = ""
    prompt_scaffold: str = ""
    negative: str = ""
    aspect: str = ""
    style_tags: list[str] = Field(default_factory=list)
    # 结构化参数：比一整段散文更容易被模型稳定执行
    slots: dict[str, str] = Field(default_factory=dict)
    pitfalls: list[str] = Field(default_factory=list)


class DesignSkillCategoryOut(BaseModel):
    """技能分类（带数量，前端做分类计数）。"""

    id: str
    name: str
    description: str = ""
    count: int = 0
