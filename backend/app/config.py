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
    app_name: str = "msdsj-backend"
    app_version: str = "1.0.0"

    # 安全 / JWT
    secret_key: str = "dev-change-me"
    jwt_algorithm: str = "HS256"
    access_token_ttl: int = 604800  # 7d

    # 数据库 / 存储
    database_url: str = "sqlite+aiosqlite:///./data/canvas_studio.db"
    # 连接池：SQLite 单文件下「连接」很便宜，但要避免每次请求都重开（见 database.py）。
    # ⚠️ 连接数**不是越多越好**，这是 2026-10-21 实测反直觉的一点：
    #    aiosqlite 每条连接 = 一个独立 worker 线程，执行靠「事件循环 → Python 线程」来回投递。
    #    连接数 ≈ 并发数时，每次请求都要等线程调度唤醒，吞吐反而崩。
    #    实测（/api/generate/tasks，20 条记录，p50 延迟）：
    #      pool 2~4  : 32 并发仍 1400~1700 req/s，p50 19~22ms  ← 稳定平台期
    #      pool 8    : 8 并发即掉到 662 req/s，p50 11.3ms
    #      pool 20   : 16 并发仅 462 req/s，p50 35.7ms（比 pool=2 慢 3.7 倍）
    #      NullPool  : 同 pool=20 水平，且空载还慢 30%
    #    所以默认给「小池」：读多写少时 4 条常驻足够把请求压成紧凑批次。
    #    生图任务由进程内队列与 Gateway 账号租约协调；部署保持单 worker，
    #    真要提高图片吞吐请调 image_concurrency 或使用共享租约层后再横向扩容。
    db_pool_size: int = 4
    db_max_overflow: int = 2
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
    # 新用户初始赠送额度。用户明确要求：**不要白送额度**，默认 0。
    initial_grant: int = 0

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
    app_env: str = "dev"  # dev | prod：prod 下关闭 /docs、openapi，错误详情不外泄
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
    demo_mode: str = "off"  # auto | on | off; applies to chat responses only
    max_active_tasks_per_user: int = 12
    # 生图并发上限：进程内信号量。上游只有几条并发额度时把它调小，
    # 多出来的任务会在本进程排队（进度 5%），而不是一起超时。
    image_concurrency: int = 4
    # 等待队列上限：超过直接拒绝，避免内存里堆无限等待的协程。
    image_queue_max: int = 200
    idempotency_window_seconds: int = 300
    # 任务超时必须大于网关读超时，否则「上游还在画」会被我们自己判成失败
    task_timeout_seconds: int = 330
    task_orphan_scan_seconds: int = 60
    gw_connect_timeout: float = 10.0
    gw_read_timeout: float = 300.0
    gw_max_retries: int = 2
    # 网关连接池上限：每个进行中的生图请求占 1 条连接，多区域并发时按区域数翻倍。
    # 太小会在本地排队（表现为「明明上游很快，我们却等」），太大没有意义。
    gw_max_connections: int = 100
    poll_base_interval_ms: int = 1500
    poll_max_interval_ms: int = 10000
    # 图片处理线程池大小（0 = 自动：CPU×2，夹取 4~16）。
    # Pillow 大量工作在 C 层且释放 GIL，线程并行能拿到接近线性的收益；
    # 但也不宜过大，否则内存里同时展开的大图会撑爆 RSS。
    image_workers: int = 0

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

    text_base_url: str = ""
    text_api_key: str = ""
    text_model: str = "gpt-4o-mini"
    llm_base_url: str = ""
    llm_api_key: str = ""
    llm_model: str = ""
    image_base_url: str = ""
    image_api_key: str = ""
    image_model: str = "gpt-image-2"
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
