"""集中式配置：pydantic-settings 读取 `CS_` 前缀环境变量 + 上游/代理变量。

优先级说明：`system_configs` 表 > 环境变量（由 config_service 负责覆盖解析）。
本模块仅负责环境变量兜底层的读取与类型校验。
"""
from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """业务配置（`CS_` 前缀）。"""

    model_config = SettingsConfigDict(
        env_prefix="CS_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # 应用元信息
    app_name: str = "canvas-studio-backend"
    app_version: str = "1.0.0"

    # 安全 / JWT
    secret_key: str = "dev-change-me"
    jwt_algorithm: str = "HS256"
    access_token_ttl: int = 604800  # 7d

    # 数据库 / 存储
    database_url: str = "sqlite+aiosqlite:///./data/canvas_studio.db"
    storage_backend: str = "local"
    storage_dir: str = "./data/storage"
    storage_public_base: str = "http://localhost:27181/static"

    # 前端 / CORS
    frontend_base_url: str = "http://localhost:27180"
    cors_origins: str = "http://localhost:27180"

    # 网关
    gateway_base_url: str = "http://127.0.0.1:27182"
    gateway_internal_token: str = "dev-internal-token"

    # 管理员 / 初始额度
    default_admin_email: str = "admin@canvas.studio"
    default_admin_password: str = "Admin@12345"
    initial_grant: int = 200

    # 令牌时效
    verify_token_ttl_hours: int = 24
    reset_token_ttl_hours: int = 1

    # 额度单价
    quota_price_image: int = 10
    quota_price_image_hd: int = 16
    quota_price_edit: int = 8
    quota_price_chat: int = 2
    quota_warn_pct: int = 20

    # 平台开关
    open_registration: bool = True
    maintenance_mode: bool = False
    pool_autorefresh_minutes: int = 30
    max_upload_mb: int = 20

    # 邮件
    email_backend: str = "console"  # console | smtp
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from: str = "no-reply@canvas.studio"
    smtp_tls: bool = True
    mail_log_path: str = "./data/mail.log"

    # Demo / 任务状态机 / 网关超时
    demo_mode: str = "auto"  # auto | on | off
    max_active_tasks_per_user: int = 2
    idempotency_window_seconds: int = 300
    task_timeout_seconds: int = 180
    task_orphan_scan_seconds: int = 60
    gw_connect_timeout: float = 10.0
    gw_read_timeout: float = 300.0
    gw_max_retries: int = 2
    poll_base_interval_ms: int = 1500
    poll_max_interval_ms: int = 10000

    @property
    def cors_origin_list(self) -> list[str]:
        """把逗号分隔的 CORS 来源解析为列表。"""
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]


class UpstreamSettings(BaseSettings):
    """上游服务与代理配置（沿用原生变量名，无 `CS_` 前缀）。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    sub2api_base_url: str = "http://localhost:8080"
    sub2api_api_key: str = "sk-xxx"
    chatgpt2api_base_url: str = "http://localhost:3000"
    chatgpt2api_admin_key: str = "xxx"
    http_proxy: str = ""
    https_proxy: str = ""
    no_proxy: str = "localhost,127.0.0.1"

    @property
    def proxy_url(self) -> str:
        """返回优先使用的代理地址（HTTPS 优先，回退 HTTP）。"""
        return self.https_proxy or self.http_proxy or ""


@lru_cache
def get_settings() -> Settings:
    """返回单例业务配置。"""
    return Settings()


@lru_cache
def get_upstream_settings() -> UpstreamSettings:
    """返回单例上游配置。"""
    return UpstreamSettings()


settings: Settings = get_settings()
upstream_settings: UpstreamSettings = get_upstream_settings()
