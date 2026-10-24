"""Pro 激活码服务：生成 / 列表 / 启停 / 兑换 / 到期降级。"""
from __future__ import annotations

import secrets
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pro_code import ProCode
from app.models.user import User
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import utcnow
from app.utils.logging import get_logger

logger = get_logger("app.pro")

# 去掉 0/O/1/I 等易混字符，避免用户手抄时输错
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

# 视为「已解锁全部功能」的角色：Pro 与管理员
UNLOCKED_ROLES = ("pro", "admin")


def generate_code(length: int = 16) -> str:
    """生成随机激活码。"""
    return "".join(secrets.choice(ALPHABET) for _ in range(length))


def normalize(raw: str) -> str:
    """归一化用户输入：忽略空格与连接符，统一大写。"""
    return "".join(ch for ch in (raw or "").upper() if ch.isalnum())


async def create_codes(
    db: AsyncSession,
    *,
    count: int,
    max_uses: int,
    expires_at,
    note: str,
    created_by: str | None,
    duration_hours: int = 0,
) -> list[ProCode]:
    """批量创建激活码。`duration_hours` = 兑换后授予的 Pro 时长（0 = 永久）。"""
    created: list[ProCode] = []
    for _ in range(count):
        for _attempt in range(5):
            code = generate_code()
            exists = await db.execute(select(ProCode).where(ProCode.code == code))
            if exists.scalar_one_or_none() is None:
                row = ProCode(
                    code=code,
                    max_uses=max_uses,
                    used_count=0,
                    status="active",
                    note=note,
                    expires_at=expires_at,
                    duration_hours=duration_hours,
                    created_by=created_by,
                )
                db.add(row)
                await db.flush()
                created.append(row)
                break
        else:
            raise AppError(ErrorCode.INTERNAL_ERROR, "激活码生成失败，请重试")
    return created


async def list_codes(
    db: AsyncSession, page: int, size: int, status: str | None = None
) -> tuple[list[ProCode], int]:
    """分页查询激活码。"""
    base = select(ProCode)
    if status:
        base = base.where(ProCode.status == status)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(ProCode.created_at.desc()).offset((page - 1) * size).limit(size)
    )
    return list(result.scalars().all()), total


async def _get_row(db: AsyncSession, code_id: str) -> ProCode:
    row = (
        await db.execute(select(ProCode).where(ProCode.id == code_id))
    ).scalar_one_or_none()
    if row is None:
        raise AppError(ErrorCode.NOT_FOUND, "激活码不存在")
    return row


async def set_status(db: AsyncSession, code_id: str, status: str) -> ProCode:
    """启用 / 禁用激活码。"""
    row = await _get_row(db, code_id)
    row.status = status
    await db.flush()
    return row


async def delete_code(db: AsyncSession, code_id: str) -> None:
    """删除激活码。"""
    row = await _get_row(db, code_id)
    await db.delete(row)
    await db.flush()


async def redeem(db: AsyncSession, user: User, raw: str) -> dict:
    """用激活码兑换 Pro 权限。

    约束：
    - 已经是 Pro / 管理员：直接返回，**不消耗**激活码（避免误扣）；
    - 校验失败一律给「激活码」口径的提示，不泄露码是否存在；
    - 兑换成功后只改 `users.role`，不新增列表。
    """
    code = normalize(raw)
    if not code:
        raise AppError(ErrorCode.VALIDATION_ERROR, "请输入激活码")

    # 管理员永久全功能；永久 Pro 也无需再兑换。
    # 限时 Pro 允许继续兑换（在现有到期时间上叠加），否则续费会被当成「已是 Pro」吞掉。
    if user.role == "admin" or (user.role == "pro" and user.pro_expires_at is None):
        return {"role": user.role, "already_pro": True}
    if user.role == "pro" and user.pro_expires_at and user.pro_expires_at < utcnow():
        # 已过期但调度器还没跑到：先降级，再按普通用户走兑换
        user.role = "user"

    row = (
        await db.execute(select(ProCode).where(ProCode.code == code))
    ).scalar_one_or_none()
    if row is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "激活码无效，请检查后重试")
    if row.status != "active":
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个激活码已经用完了")
    if row.expires_at is not None and row.expires_at < utcnow():
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个激活码已经过期了")
    if row.used_count >= row.max_uses:
        raise AppError(ErrorCode.VALIDATION_ERROR, "这个激活码已经用完了")

    row.used_count += 1
    if row.used_count >= row.max_uses:
        row.status = "disabled"
    _grant(db, user, row.duration_hours)
    await db.flush()
    return {
        "role": "pro",
        "already_pro": False,
        "pro_expires_at": user.pro_expires_at,
        "duration_hours": row.duration_hours,
    }


def _grant(db: AsyncSession, user: User, duration_hours: int) -> None:
    """给用户开 Pro：按时长顺延，0 表示永久。

    已是 pro 且尚未到期时在**现有到期时间**上叠加，避免用户续费反而变短；
    已过期或首次开通则从当前时间起算。
    """
    now = utcnow()
    user.role = "pro"
    if duration_hours <= 0:
        user.pro_expires_at = None
        return
    base = user.pro_expires_at if user.pro_expires_at and user.pro_expires_at > now else now
    user.pro_expires_at = base + timedelta(hours=int(duration_hours))


async def grant(
    db: AsyncSession, user: User, duration_hours: int, *, actor_email: str = ""
) -> dict:
    """超管直接给某个用户开通 Pro（不走激活码）。"""
    if user.role == "admin":
        raise AppError(ErrorCode.VALIDATION_ERROR, "管理员本身就是全功能，无需开通 Pro")
    _grant(db, user, duration_hours)
    await db.flush()
    logger.info(
        "Pro 已开通：user=%s duration=%sh by=%s", user.id, duration_hours, actor_email or "-"
    )
    return {
        "role": user.role,
        "pro_expires_at": user.pro_expires_at,
        "duration_hours": duration_hours,
    }


async def downgrade_expired(db: AsyncSession) -> int:
    """把所有已过期的 Pro 降回 Free（role=user）。

    角色是功能权限的唯一开关（画布 / 抠图 / AI 对话 / 润色 / 图生图都走
    `UNLOCKED_ROLES`），所以改回 user 等于同时回收页面与功能权限。
    """
    now = utcnow()
    rows = (
        await db.execute(
            select(User).where(
                User.role == "pro",
                User.pro_expires_at.is_not(None),
                User.pro_expires_at < now,
            )
        )
    ).scalars().all()
    for user in rows:
        user.role = "user"
    if rows:
        await db.commit()
        logger.info("Pro 到期降级：%s 个账号已恢复 Free", len(rows))
    return len(rows)
