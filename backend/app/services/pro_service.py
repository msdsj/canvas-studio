"""Pro 激活码服务：生成 / 列表 / 启停 / 兑换。"""
from __future__ import annotations

import secrets

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pro_code import ProCode
from app.models.user import User
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import utcnow

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
) -> list[ProCode]:
    """批量创建激活码。"""
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

    if user.role in UNLOCKED_ROLES:
        return {"role": user.role, "already_pro": True}

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
    user.role = "pro"
    await db.flush()
    return {"role": "pro", "already_pro": False}
