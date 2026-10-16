"""号池 / 配置 Schema。"""
from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PoolImportRequest(BaseModel):
    """导入请求。"""

    tokens: list[str] = Field(default_factory=list)
    accounts: list[dict[str, Any]] = Field(default_factory=list)


class PoolDeleteRequest(BaseModel):
    """删除请求。"""

    tokens: list[str] = Field(default_factory=list)


class PoolRefreshRequest(BaseModel):
    """刷新 / 重登请求。"""

    tokens: list[str] = Field(default_factory=list)


class PoolUpdateRequest(BaseModel):
    """更新账号请求。"""

    access_token: str = ""
    type: str | None = None
    status: str | None = None
    quota: int | None = None
    proxy: str | None = None


class PoolExportRequest(BaseModel):
    """导出请求。"""

    tokens: list[str] = Field(default_factory=list)
    format: str = "json"


class OAuthStartRequest(BaseModel):
    """OAuth 起始。"""

    email_hint: str = ""


class OAuthFinishRequest(BaseModel):
    """OAuth 完成。"""

    session_id: str = ""
    callback: str = ""


class UpstreamTarget(BaseModel):
    """上游配置项。"""

    base_url: str = ""
    api_key: str | None = None
    admin_key: str | None = None


class ProxyConfig(BaseModel):
    """代理配置项。"""

    http_proxy: str = ""
    https_proxy: str = ""


class ConfigPushRequest(BaseModel):
    """backend 推送的运行时配置。"""

    sub2api: UpstreamTarget | None = None
    chatgpt2api: UpstreamTarget | None = None
    proxy: ProxyConfig | None = None
    demo_mode: str | None = None


class ConfigTestRequest(BaseModel):
    """连通性测试请求。"""

    target: str = "sub2api"
