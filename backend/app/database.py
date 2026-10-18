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

from app.config import settings


class Base(DeclarativeBase):
    """所有 ORM 模型的声明式基类。"""


# SQLite 需要关闭 check_same_thread 以配合 async + 多线程
_connect_args: dict[str, object] = {}
if settings.database_url.startswith("sqlite"):
    _connect_args = {"check_same_thread": False}

engine = create_async_engine(
    settings.database_url,
    echo=False,
    future=True,
    connect_args=_connect_args,
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
