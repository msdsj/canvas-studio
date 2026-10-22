"""管理后台相关 Schema。"""
from __future__ import annotations

from datetime import datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field

from app.schemas.common import ORMModel


class OverviewOut(BaseModel):
    """后台概览。"""

    users_total: int = 0
    users_active: int = 0
    pool: dict[str, int] = Field(default_factory=dict)
    quota_consumed_today: int = 0


class AdminUserOut(ORMModel):
    """后台用户行。"""

    id: str
    email: str
    role: str
    status: str
    display_name: str
    balance: int
    created_at: datetime | None = None
    last_login_at: datetime | None = None


class BanRequest(BaseModel):
    """封禁请求。"""

    reason: str = Field(default="", max_length=255)


class AdminUserCreateRequest(BaseModel):
    """后台新建可直接登录的普通用户，可选创建并加入企业空间。"""

    email: EmailStr
    password: str = Field(min_length=8, max_length=128)
    display_name: str | None = Field(default=None, max_length=128)
    role: str = Field(default="user")
    team_name: str | None = Field(default=None, min_length=2, max_length=60)


class QuotaAdjustResult(BaseModel):
    """额度调整结果。"""

    balance: int
    tx: dict[str, Any] = Field(default_factory=dict)


class ResetPasswordResult(BaseModel):
    """重置密码结果。"""

    temp_password: str


class PoolStatsOut(BaseModel):
    """号池统计。"""

    total: int = 0
    normal: int = 0
    limited: int = 0
    abnormal: int = 0
    disabled: int = 0


class PoolAccountOut(BaseModel):
    """号池账号（掩码）。"""

    token_masked: str
    type: str = ""
    status: str = ""
    quota: int = 0
    last_refresh: str = ""


class PoolAccountsOut(BaseModel):
    """号池账号列表。"""

    items: list[PoolAccountOut] = Field(default_factory=list)


class PoolImportRequest(BaseModel):
    """号池导入请求（五方式统一入口）。"""

    method: str = Field(description="token | session | codex_auth | account_json | oauth")
    tokens: list[str] = Field(default_factory=list)
    accounts: list[dict[str, Any]] = Field(default_factory=list)


class PoolImportResult(BaseModel):
    """导入回执。"""

    added: int = 0
    skipped: int = 0
    refreshed: int = 0
    errors: list[Any] = Field(default_factory=list)


class PoolDeleteRequest(BaseModel):
    """删除账号请求。"""

    tokens: list[str] = Field(default_factory=list)


class PoolJobRequest(BaseModel):
    """刷新/重登请求。"""

    tokens: list[str] | None = None


class PoolJobOut(BaseModel):
    """任务 id。"""

    job_id: str


class PoolProgressOut(BaseModel):
    """进度输出。"""

    status: str = ""
    done: int = 0
    total: int = 0
    detail: dict[str, Any] = Field(default_factory=dict)


class PoolUpdateRequest(BaseModel):
    """账号更新请求。"""

    access_token: str
    status: str | None = None
    quota: int | None = None
    type: str | None = None
    proxy: str | None = None


class PoolExportRequest(BaseModel):
    """导出请求。"""

    tokens: list[str] = Field(default_factory=list)
    format: str = Field(default="json")


class OAuthStartRequest(BaseModel):
    """OAuth 起始。"""

    email_hint: str = ""


class OAuthFinishRequest(BaseModel):
    """OAuth 完成。"""

    session_id: str
    callback: str


class InviteCreateRequest(BaseModel):
    """创建邀请码。"""

    max_uses: int = Field(default=1, ge=1, le=1000)
    expires_at: datetime | None = None


class InviteUpdateRequest(BaseModel):
    """更新邀请码状态。"""

    status: str


class InviteOut(ORMModel):
    """邀请码输出。"""

    id: str
    code: str
    max_uses: int
    used_count: int
    status: str
    expires_at: datetime | None = None
    created_at: datetime | None = None


class ProCodeCreateRequest(BaseModel):
    """批量创建 Pro 激活码。"""

    count: int = Field(default=1, ge=1, le=200)
    max_uses: int = Field(default=1, ge=1, le=1000)
    note: str = Field(default="", max_length=128)
    expires_at: datetime | None = None


class ProCodeUpdateRequest(BaseModel):
    """启用 / 禁用 Pro 激活码。"""

    status: str


class ProCodeOut(ORMModel):
    """Pro 激活码输出。"""

    id: str
    code: str
    max_uses: int
    used_count: int
    status: str
    note: str = ""
    expires_at: datetime | None = None
    created_at: datetime | None = None


class ProCodeBatchOut(BaseModel):
    """批量创建回执。"""

    items: list[ProCodeOut] = Field(default_factory=list)


class AnnouncementCreateRequest(BaseModel):
    """创建公告。"""

    title: str = Field(min_length=1, max_length=255)
    content: str = Field(default="", max_length=20000)
    level: str = Field(default="info")


class AnnouncementUpdateRequest(BaseModel):
    """更新公告。"""

    status: str | None = None
    title: str | None = None
    content: str | None = None


class AnnouncementOut(ORMModel):
    """公告输出。"""

    id: str
    title: str
    content: str
    level: str
    status: str
    published_at: datetime | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None


class AuditLogOut(ORMModel):
    """审计日志输出。"""

    id: str
    actor_id: str | None = None
    actor_email: str = ""
    action: str
    target_type: str = ""
    target_id: str | None = None
    detail: dict[str, Any] = Field(default_factory=dict)
    ip: str = ""
    created_at: datetime | None = None
