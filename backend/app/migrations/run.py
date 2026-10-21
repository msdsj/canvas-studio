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


async def _ensure_index(table: str, name: str, columns: str) -> None:
    """缺索引则补。

    `create_all` 同样不会给已存在的表补索引，而协作与团队查询全是
    `WHERE team_id = ?` / `WHERE canvas_id = ?` 这种形态，没索引就是全表扫。
    """
    async with engine.begin() as conn:
        rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).all()
        if not rows:
            return
        await conn.execute(text(f"CREATE INDEX IF NOT EXISTS {name} ON {table}({columns})"))


async def _apply_column_patches() -> None:
    """历史库补字段（幂等，重复执行无副作用）。"""
    # 对话分享
    await _ensure_column("chat_sessions", "share_token", "share_token VARCHAR(64)")
    await _ensure_column("chat_sessions", "is_public", "is_public BOOLEAN DEFAULT 0")
    # 消息软删（对话列表加「全选删除」需要）
    await _ensure_column("chat_messages", "deleted_at", "deleted_at DATETIME")
    # 中转站备用模型链（ADR-3）：0–3 个有序模型名。
    # SQLite 的 ADD COLUMN 只接受常量默认值，'[]' 是常量字符串；
    # 既有行读出来是 '[]'，SQLAlchemy 的 JSON 类型会 json.loads 成 []，无需回填。
    await _ensure_column("ai_providers", "fallback_models", "fallback_models JSON DEFAULT '[]'")

    # ---- 团队版新增列（全部允许 NULL / 有默认值：历史行等价于「个人资源」）----
    await _ensure_column("users", "persona_key", "persona_key VARCHAR(32) DEFAULT ''")
    await _ensure_column("users", "onboarding_completed_at", "onboarding_completed_at DATETIME")
    await _ensure_column("users", "active_team_id", "active_team_id VARCHAR(36)")

    await _ensure_column("canvas_projects", "team_id", "team_id VARCHAR(36)")
    await _ensure_column("canvas_projects", "visibility", "visibility VARCHAR(16) DEFAULT 'private'")
    await _ensure_column("canvases", "team_id", "team_id VARCHAR(36)")
    await _ensure_column("canvases", "visibility", "visibility VARCHAR(16) DEFAULT 'private'")
    await _ensure_column("canvases", "version", "version INTEGER DEFAULT 0")
    await _ensure_column("canvases", "updated_by", "updated_by VARCHAR(36)")

    await _ensure_column("assets", "team_id", "team_id VARCHAR(36)")
    await _ensure_column("assets", "visibility", "visibility VARCHAR(16) DEFAULT 'private'")
    await _ensure_column("chat_sessions", "team_id", "team_id VARCHAR(36)")
    await _ensure_column("chat_sessions", "visibility", "visibility VARCHAR(16) DEFAULT 'private'")
    await _ensure_column("generation_tasks", "team_id", "team_id VARCHAR(36)")
    await _ensure_column("skill_runs", "team_id", "team_id VARCHAR(36)")
    await _ensure_column("audit_logs", "team_id", "team_id VARCHAR(36)")
    await _ensure_column("quota_transactions", "team_id", "team_id VARCHAR(36)")
    await _ensure_column("ai_providers", "scope", "scope VARCHAR(16) DEFAULT 'personal'")
    await _ensure_column("ai_providers", "team_id", "team_id VARCHAR(36)")

    for table in ("canvas_projects", "canvases", "assets", "chat_sessions", "generation_tasks"):
        await _ensure_index(table, f"ix_{table}_team_id", "team_id")

    # 生成任务的高频读路径（前端每 3s / 6s 轮询 + 列表分页）。
    # 单列 `user_id` 索引满足不了 `ORDER BY created_at DESC`，查询计划里会出现
    # `USE TEMP B-TREE FOR ORDER BY`；`list_unread` 更会挑 `status` 索引去扫全库。
    # 复合索引让「过滤 + 排序」一次走完。
    await _ensure_index(
        "generation_tasks", "ix_gen_task_user_created", "user_id, created_at"
    )
    await _ensure_index(
        "generation_tasks",
        "ix_gen_task_user_status_created",
        "user_id, status, created_at",
    )


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
