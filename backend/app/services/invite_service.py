"""邀请码服务。"""
from __future__ import annotations

import secrets

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.invite import InviteCode
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import utcnow


def generate_code(length: int = 10) -> str:
    """生成随机邀请码。"""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(length))


async def consume_code(db: AsyncSession, code: str) -> InviteCode:
    """校验并消费一次邀请码。"""
    result = await db.execute(select(InviteCode).where(InviteCode.code == code))
    invite = result.scalar_one_or_none()
    if invite is None:
        raise AppError(ErrorCode.FORBIDDEN, "邀请码无效")
    if invite.status != "active":
        raise AppError(ErrorCode.FORBIDDEN, "邀请码已被禁用")
    if invite.expires_at is not None and invite.expires_at < utcnow():
        raise AppError(ErrorCode.FORBIDDEN, "邀请码已过期")
    if invite.used_count >= invite.max_uses:
        raise AppError(ErrorCode.FORBIDDEN, "邀请码使用次数已达上限")
    invite.used_count += 1
    if invite.used_count >= invite.max_uses:
        invite.status = "disabled"
    await db.flush()
    return invite


async def create_invite(
    db: AsyncSession, max_uses: int, expires_at, created_by: str | None
) -> InviteCode:
    """创建邀请码（唯一性重试）。"""
    for _ in range(5):
        code = generate_code()
        exists = await db.execute(select(InviteCode).where(InviteCode.code == code))
        if exists.scalar_one_or_none() is None:
            invite = InviteCode(
                code=code,
                max_uses=max_uses,
                used_count=0,
                status="active",
                expires_at=expires_at,
                created_by=created_by,
            )
            db.add(invite)
            await db.flush()
            return invite
    raise AppError(ErrorCode.INTERNAL_ERROR, "邀请码生成失败，请重试")
