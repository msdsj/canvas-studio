"""数据库引擎 / 会话工厂 / ORM 基类。

使用 SQLAlchemy 2.0 async + aiosqlite。首版通过 `Base.metadata.create_all` 建表，
迁移由 `app/migrations/run.py` 兜底。
"""
from __future__ import annotations

from collections.abc import AsyncGenerator

from sqlalchemy import event
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.pool import AsyncAdaptedQueuePool

from app.config import settings


class Base(DeclarativeBase):
    """所有 ORM 模型的声明式基类。"""


# SQLite 需要关闭 check_same_thread 以配合 async + 多线程
_connect_args: dict[str, object] = {}
_engine_kwargs: dict[str, object] = {}
if settings.database_url.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}
    # ⚠️ aiosqlite 的默认池是 NullPool：**每个请求都新建连接**，并重跑下面那组
    # PRAGMA（其中 `journal_mode=WAL` 是一次需要加锁的写操作）。
    # 实测并发取连接开销 NullPool 0.92ms/次 vs QueuePool 0.40ms/次。
    #
    # ⚠️ 反直觉但已实测（2026-10-21）：连接数**开大反而更慢**。
    # aiosqlite 每条连接独占一个 worker 线程，执行靠事件循环↔线程投递；
    # 连接数与并发数接近时，请求全在等线程唤醒，而不是在并行。
    #   pool=2  → 32 并发 1696 req/s (p50 18.8ms)
    #   pool=20 → 16 并发  462 req/s (p50 35.7ms)   ← 慢 3.7 倍
    # 默认值在 config.py 里（db_pool_size=4），要更高吞吐请加 uvicorn --workers。
    _engine_kwargs = {
        "poolclass": AsyncAdaptedQueuePool,
        "pool_size": settings.db_pool_size,
        "max_overflow": settings.db_max_overflow,
        # 本地文件不会出现「连接被网络断开」，pre_ping 只是白跑一次 SELECT
        "pool_pre_ping": False,
    }

engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
    connect_args=_connect_args,
    **_engine_kwargs,
)


# 启用 SQLite 外键约束（异步引擎下通过同步事件监听）
if settings.database_url.startswith("sqlite"):

    @event.listens_for(engine.sync_engine, "connect")
    def _set_sqlite_pragma(dbapi_connection, _connection_record) -> None:  # noqa: ANN001
        cursor = dbapi_connection.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        # WAL + busy_timeout：生成任务在后台每秒写进度，对话流同时在写消息，
        # 默认 rollback journal 下写写互斥会直接抛 "database is locked"，
        # 表现为 SSE 中途断流、任务莫名失败。WAL 允许读写并发，busy_timeout
        # 让第二个写者在锁释放前排队等待，而不是立刻失败。
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=15000")
        # 临时表/排序放在内存里（默认文件大小 0 = 关闭）：平台没有大结果集排序，
        # 打开能让会话列表、资产分页这类 ORDER BY 少走磁盘。
        cursor.execute("PRAGMA temp_store=MEMORY")
        cursor.close()


AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """FastAPI 依赖：提供一个请求级 AsyncSession。"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


async def init_models() -> None:
    """导入所有模型并建表（幂等）。"""
    # 触发模型注册到 Base.metadata
    from app import models  # noqa: F401

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
