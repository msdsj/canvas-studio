"""初始化：默认管理员 + 默认系统配置。"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User
from app.models.system_config import SystemConfig
from app.security import hash_password
from app.services import config_service
from app.utils.ids import new_id, utcnow
from app.utils.logging import get_logger

logger = get_logger("app.seed")


async def run_seed(db: AsyncSession) -> None:
    """执行幂等初始化。"""
    await config_service.ensure_defaults(db)
    # Upgrade only the old seeded default; keep limits explicitly set by an admin.
    limit = await db.get(SystemConfig, "MAX_ACTIVE_TASKS_PER_USER")
    if limit and limit.value == "2" and limit.updated_by is None and settings.max_active_tasks_per_user > 2:
        limit.value = str(settings.max_active_tasks_per_user)

    email = settings.default_admin_email.strip().lower()
    result = await db.execute(select(User).where(User.email == email))
    admin = result.scalar_one_or_none()
    if admin is None:
        initial = int(await config_service.get_value(db, "INITIAL_GRANT", settings.initial_grant))
        admin = User(
            id=new_id(),
            email=email,
            password_hash=hash_password(settings.default_admin_password),
            role="admin",
            status="active",
            display_name="管理员",
            email_verified_at=utcnow(),
            balance=initial,
        )
        db.add(admin)
        await db.flush()
        logger.info("已创建默认管理员：%s", email)
    await db.commit()
