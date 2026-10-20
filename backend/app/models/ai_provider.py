"""用户级 AI 中转站配置。

为什么是「用户级」而不是全局：平台允许每个创作者接自己的中转站
（Claude / Codex / DeepSeek / 任意 OpenAI 兼容网关），额度与账单都在用户自己那边。
全局 `system_configs` 里的 TEXT_*/LLM_* 只作为**未配置时的兜底**。

安全约定：
- `api_key` 落库（SQLite），接口**永远不回传明文**，只回 `key_hint` 掩码；
- 更新时若传入的是掩码（含 `*`），视为「不修改」，避免把掩码写回真实值；
- 一个用户可以有多个 provider，但同一时刻只有一个 `is_active`。
"""
from __future__ import annotations

from datetime import datetime

from sqlalchemy import JSON, Boolean, DateTime, Float, ForeignKey, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base
from app.utils.ids import new_id, utcnow


class AIProvider(Base):
    """一条用户自定义的 AI 中转站配置。"""

    __tablename__ = "ai_providers"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        String(36), ForeignKey("users.id"), index=True, nullable=False
    )
    # 配置归属：personal = 用户自建；team = 团队超级管理员统一配置，成员只读使用。
    # 团队配置仍然落在本表（而不是另开一张表），因为请求参数结构完全一致，
    # 分表只会让 relay_service 多一条几乎相同的解析分支。
    scope: Mapped[str] = mapped_column(String(16), default="personal", index=True)
    team_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("teams.id"), index=True, nullable=True
    )

    # 展示名（用户自己起，如「我的 DeepSeek 中转」）
    name: Mapped[str] = mapped_column(String(80), default="")
    # claude | codex | deepseek | openai | compatible
    kind: Mapped[str] = mapped_column(String(24), default="compatible")

    base_url: Mapped[str] = mapped_column(String(500), default="")
    api_key: Mapped[str] = mapped_column(String(500), default="")
    model: Mapped[str] = mapped_column(String(120), default="")

    # 备用模型链：主模型失败时按序切换。
    # - 0–3 个模型名（有序），**存 3 但运行时只遍历前 2 个**（延迟保护，见 ADR-3/C5）
    # - 空列表 = 不启用 fallback（保持一期行为）
    # - 读取处统一走 `relay_service.safe_model_list()`，兼容 None / 字符串 '[]' / 脏数据
    fallback_models: Mapped[list] = mapped_column(JSON, default=list)

    temperature: Mapped[float] = mapped_column(Float, default=0.7)
    max_tokens: Mapped[int] = mapped_column(Integer, default=2048)
    # 额外请求参数（如 top_p / response_format / 自定义 header），原样并入请求体
    extra: Mapped[dict] = mapped_column(JSON, default=dict)
    # 是否支持读图（决定要不要把参考图一起发给模型做语义分析）
    supports_vision: Mapped[bool] = mapped_column(Boolean, default=False)

    is_active: Mapped[bool] = mapped_column(Boolean, default=False, index=True)

    # 最近一次连通性测试结果（面板上直接显示，不用再点一次）
    last_test_ok: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    last_test_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_test_message: Mapped[str] = mapped_column(String(300), default="")

    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, index=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
