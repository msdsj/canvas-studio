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
    model: str | None = None
    # 备用模型列表。接受**字符串或字符串数组**两种形态：backend 的 system_configs
    # 里存的就是「逗号分隔的字符串」，直接按 list 声明会让每次配置推送都 422，
    # 而网关配置推送失败是静默的（日志里只会看到 data=None），排查成本极高。
    fallback_models: str | list[str] | None = None


class ProxyConfig(BaseModel):
    """代理配置项。"""

    http_proxy: str = ""
    https_proxy: str = ""


class ConfigPushRequest(BaseModel):
    """backend 推送的运行时配置。"""

    text: UpstreamTarget | None = None
    llm: UpstreamTarget | None = None
    image: UpstreamTarget | None = None
    proxy: ProxyConfig | None = None
    demo_mode: str | None = None


class ConfigTestRequest(BaseModel):
    """连通性测试请求。"""

    target: str = "text"
