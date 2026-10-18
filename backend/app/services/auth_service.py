"""认证服务：注册 / 邮箱确认 / 登录 / 忘记与重置密码 / 登出全部设备。"""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.email_token import EmailToken
from app.models.user import User
from app.security import (
    create_access_token,
    generate_token,
    hash_password,
    verify_password,
)
from app.services import email_service, quota_service
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow

RESEND_COOLDOWN_SECONDS = 60


def _normalize_email(email: str) -> str:
    """邮箱小写归一。"""
    return email.strip().lower()


async def _create_token(
    db: AsyncSession, user_id: str, token_type: str, ttl_hours: int
) -> str:
    """创建并持久化一个邮箱令牌。"""
    token = generate_token()
    db.add(
        EmailToken(
            id=new_id(),
            user_id=user_id,
            token=token,
            type=token_type,
            expires_at=utcnow() + timedelta(hours=ttl_hours),
        )
    )
    await db.flush()
    return token


async def register(
    db: AsyncSession,
    email: str,
    password: str,
    display_name: str | None = None,
) -> User:
    """注册用户：直接创建为 active 并发放初始额度（注册流程不再需要邮箱确认）。

    历史实现创建 `pending_verification` 账号并寄送确认邮件，用户在此阶段无法登录，
    等于「注册完也用不了」。现在注册即完成激活，由路由层直接签发 JWT 自动登录。
    """
    from app.services import config_service

    email = _normalize_email(email)
    if not await config_service.get_value(db, "OPEN_REGISTRATION", settings.open_registration):
        raise AppError(ErrorCode.FORBIDDEN, "当前已关闭注册")

    existing = await db.execute(select(User).where(User.email == email))
    if existing.scalar_one_or_none() is not None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "该邮箱已被注册")

    user = User(
        id=new_id(),
        email=email,
        password_hash=hash_password(password),
        role="user",
        status="active",
        display_name=display_name or email.split("@")[0],
        email_verified_at=utcnow(),
    )
    db.add(user)
    await db.flush()

    initial = int(await config_service.get_value(db, "INITIAL_GRANT", settings.initial_grant))
    if initial > 0:
        await quota_service.grant(db, user.id, initial, note="新用户初始赠送")

    await db.commit()
    await db.refresh(user)
    return user


async def verify_email(db: AsyncSession, token: str) -> User:
    """邮箱确认：置为 active 并发放初始额度。"""
    result = await db.execute(select(EmailToken).where(EmailToken.token == token))
    record = result.scalar_one_or_none()
    if record is None or record.type != "verify":
        raise AppError(ErrorCode.VALIDATION_ERROR, "确认链接无效")
    if record.used_at is not None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "确认链接已被使用")
    if record.expires_at < utcnow():
        raise AppError(ErrorCode.VALIDATION_ERROR, "确认链接已过期")

    user_result = await db.execute(select(User).where(User.id == record.user_id))
    user = user_result.scalar_one_or_none()
    if user is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "用户不存在")

    user.status = "active"
    user.email_verified_at = utcnow()
    record.used_at = utcnow()

    if user.balance == 0:
        from app.services import config_service

        initial = int(await config_service.get_value(db, "INITIAL_GRANT", settings.initial_grant))
        if initial > 0:
            await quota_service.grant(db, user.id, initial, note="新用户初始赠送")

    await db.commit()
    await db.refresh(user)
    return user


async def resend_verification(db: AsyncSession, email: str) -> None:
    """重发确认邮件（60s 限流）。"""
    email = _normalize_email(email)
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        return  # 不泄露账号是否存在

    recent = await db.execute(
        select(EmailToken)
        .where(EmailToken.user_id == user.id, EmailToken.type == "verify")
        .order_by(EmailToken.created_at.desc())
        .limit(1)
    )
    last = recent.scalar_one_or_none()
    if last is not None and (utcnow() - last.created_at).total_seconds() < RESEND_COOLDOWN_SECONDS:
        raise AppError(ErrorCode.RATE_LIMITED, "操作过于频繁，请稍后再试")

    token = await _create_token(db, user.id, "verify", settings.verify_token_ttl_hours)
    await db.commit()
    await email_service.send_verify_email(email, token)


async def login(db: AsyncSession, email: str, password: str) -> tuple[str, User]:
    """登录：校验凭据与状态，签发 JWT。"""
    email = _normalize_email(email)
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None or not verify_password(password, user.password_hash):
        raise AppError(ErrorCode.UNAUTHORIZED, "邮箱或密码错误")
    if user.status == "banned":
        raise AppError(ErrorCode.FORBIDDEN, user.banned_reason or "账号已被封禁")
    if user.status != "active":
        raise AppError(ErrorCode.FORBIDDEN, "账号未激活，请先完成邮箱确认")

    user.last_login_at = utcnow()
    await db.commit()
    await db.refresh(user)
    token = create_access_token(user.id, user.role, user.token_version)
    return token, user


async def forgot_password(db: AsyncSession, email: str) -> None:
    """发送重置密码邮件（统一文案，不泄露账号是否存在）。"""
    email = _normalize_email(email)
    result = await db.execute(select(User).where(User.email == email))
    user = result.scalar_one_or_none()
    if user is None:
        return
    token = await _create_token(db, user.id, "reset", settings.reset_token_ttl_hours)
    await db.commit()
    await email_service.send_reset_email(email, token)


async def reset_password(db: AsyncSession, token: str, new_password: str) -> None:
    """重置密码：校验令牌，更新哈希并递增 token_version 使旧 token 失效。"""
    result = await db.execute(select(EmailToken).where(EmailToken.token == token))
    record = result.scalar_one_or_none()
    if record is None or record.type != "reset":
        raise AppError(ErrorCode.VALIDATION_ERROR, "重置链接无效")
    if record.used_at is not None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "重置链接已被使用")
    if record.expires_at < utcnow():
        raise AppError(ErrorCode.VALIDATION_ERROR, "重置链接已过期")

    user_result = await db.execute(select(User).where(User.id == record.user_id))
    user = user_result.scalar_one_or_none()
    if user is None:
        raise AppError(ErrorCode.VALIDATION_ERROR, "用户不存在")

    user.password_hash = hash_password(new_password)
    user.token_version += 1
    record.used_at = utcnow()
    await db.commit()


async def change_password(
    db: AsyncSession, user: User, old_password: str, new_password: str
) -> None:
    """修改密码（校验旧密码）。"""
    if not verify_password(old_password, user.password_hash):
        raise AppError(ErrorCode.VALIDATION_ERROR, "原密码不正确")
    user.password_hash = hash_password(new_password)
    user.token_version += 1
    await db.commit()


async def logout_all(db: AsyncSession, user: User) -> None:
    """登出全部设备：递增 token_version。"""
    user.token_version += 1
    await db.commit()
