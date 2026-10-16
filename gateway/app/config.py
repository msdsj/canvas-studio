"""网关配置：环境变量兜底（运行时由 backend `/gw/config` 覆盖）。"""
from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class GatewaySettings(BaseSettings):
    """网关配置项。"""

    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    app_name: str = "canvas-studio-gateway"
    app_version: str = "1.0.0"

    internal_token: str = Field(default="dev-internal-token", validation_alias="CS_GATEWAY_INTERNAL_TOKEN")
    demo_mode: str = Field(default="auto", validation_alias="CS_DEMO_MODE")
    connect_timeout: float = Field(default=10.0, validation_alias="CS_GW_CONNECT_TIMEOUT")
    read_timeout: float = Field(default=300.0, validation_alias="CS_GW_READ_TIMEOUT")
    max_retries: int = Field(default=2, validation_alias="CS_GW_MAX_RETRIES")

    sub2api_base_url: str = Field(default="http://localhost:8080", validation_alias="SUB2API_BASE_URL")
    sub2api_api_key: str = Field(default="sk-xxx", validation_alias="SUB2API_API_KEY")
    chatgpt2api_base_url: str = Field(default="http://localhost:3000", validation_alias="CHATGPT2API_BASE_URL")
    chatgpt2api_admin_key: str = Field(default="xxx", validation_alias="CHATGPT2API_ADMIN_KEY")

    http_proxy: str = Field(default="", validation_alias="HTTP_PROXY")
    https_proxy: str = Field(default="", validation_alias="HTTPS_PROXY")
    no_proxy: str = Field(default="localhost,127.0.0.1", validation_alias="NO_PROXY")


@lru_cache
def get_settings() -> GatewaySettings:
    """返回单例配置。"""
    return GatewaySettings()


settings: GatewaySettings = get_settings()
