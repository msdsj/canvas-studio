"""轻量建表 + 初始化脚本。

用法：`python -m app.migrations.run`
（首版通过 `create_all` 建表；后续字段补丁可在此追加。）
"""
from __future__ import annotations

import asyncio

from app.database import AsyncSessionLocal, init_models
from app.seed import run_seed
from app.utils.logging import configure_logging, get_logger

logger = get_logger("app.migrations")


async def main() -> None:
    """建表并执行 seed。"""
    configure_logging()
    await init_models()
    async with AsyncSessionLocal() as db:
        await run_seed(db)
    logger.info("数据库初始化完成")


if __name__ == "__main__":
    asyncio.run(main())
