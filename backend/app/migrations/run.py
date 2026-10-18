"""轻量建表 + 字段补丁 + 初始化脚本。

用法：`python -m app.migrations.run`

`create_all` 只会建缺失的**表**，不会给已有表加**列**。所以本项目的字段演进
统一在这里追加幂等的 `_ensure_column` 调用——启动即自动补齐，不需要手工 ALTER。
"""
from __future__ import annotations

import asyncio

from sqlalchemy import text

from app.database import AsyncSessionLocal, engine, init_models
from app.seed import run_seed
from app.utils.logging import configure_logging, get_logger

logger = get_logger("app.migrations")


async def _ensure_column(table: str, column: str, ddl: str) -> None:
    """缺列则补（SQLite 支持 ADD COLUMN，且本项目的补列都允许 NULL / 有默认值）。"""
    async with engine.begin() as conn:
        rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).all()
        if not rows:
            return  # 表还不存在，create_all 会连列一起建好
        existing = {row[1] for row in rows}
        if column in existing:
            return
        await conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))
        logger.info("补字段：%s.%s", table, column)


async def _apply_column_patches() -> None:
    """历史库补字段（幂等，重复执行无副作用）。"""
    # 对话分享
    await _ensure_column("chat_sessions", "share_token", "share_token VARCHAR(64)")
    await _ensure_column("chat_sessions", "is_public", "is_public BOOLEAN DEFAULT 0")
    # 消息软删（对话列表加「全选删除」需要）
    await _ensure_column("chat_messages", "deleted_at", "deleted_at DATETIME")


async def main() -> None:
    """建表、补字段并执行 seed。"""
    configure_logging()
    await init_models()
    await _apply_column_patches()
    async with AsyncSessionLocal() as db:
        await run_seed(db)
    logger.info("数据库初始化完成")


if __name__ == "__main__":
    asyncio.run(main())
