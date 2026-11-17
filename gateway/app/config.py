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

    app_name: str = "msdsj-gateway"
    app_version: str = "1.0.0"

    internal_token: str = Field(validation_alias="CS_GATEWAY_INTERNAL_TOKEN")
    demo_mode: str = Field(default="off", validation_alias="CS_DEMO_MODE")
    connect_timeout: float = Field(default=10.0, validation_alias="CS_GW_CONNECT_TIMEOUT")
    read_timeout: float = Field(default=300.0, validation_alias="CS_GW_READ_TIMEOUT")
    max_retries: int = Field(default=2, validation_alias="CS_GW_MAX_RETRIES")

    text_base_url: str = Field(default="", validation_alias="TEXT_API_BASE_URL")
    text_api_key: str = Field(default="", validation_alias="TEXT_API_KEY")
    text_model: str = Field(default="gpt-4o-mini", validation_alias="TEXT_MODEL")
    # 备用模型链：主模型失败（格式异常 / 限流 / 5xx）后依次尝试。逗号或空格分隔。
    text_model_fallbacks: str = Field(default="", validation_alias="TEXT_MODEL_FALLBACKS")
    llm_base_url: str = Field(default="", validation_alias="LLM_BASE_URL")
    llm_api_key: str = Field(default="", validation_alias="LLM_API_KEY")
    llm_model: str = Field(default="", validation_alias="LLM_MODEL")
    llm_model_fallbacks: str = Field(default="", validation_alias="LLM_MODEL_FALLBACKS")
    image_base_url: str = Field(default="", validation_alias="IMAGE_API_BASE_URL")
    image_api_key: str = Field(default="", validation_alias="IMAGE_API_KEY")
    image_model: str = Field(default="gpt-image-2", validation_alias="IMAGE_MODEL")
    image_model_fallbacks: str = Field(default="", validation_alias="IMAGE_MODEL_FALLBACKS")
    pool_file: str = Field(default="./data/provider_accounts.json", validation_alias="POOL_FILE")

    http_proxy: str = Field(default="", validation_alias="HTTP_PROXY")
    https_proxy: str = Field(default="", validation_alias="HTTPS_PROXY")
    no_proxy: str = Field(default="localhost,127.0.0.1", validation_alias="NO_PROXY")


@lru_cache
def get_settings() -> GatewaySettings:
    """返回单例配置。"""
    return GatewaySettings()


settings: GatewaySettings = get_settings()
