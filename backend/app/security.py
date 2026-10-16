"""安全工具：密码哈希、JWT 签发/校验、随机令牌生成。"""
from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Any

import jwt
from passlib.context import CryptContext

from app.config import settings
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import utcnow

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    """对明文密码做 bcrypt 哈希（bcrypt 上限 72 字节，超出截断）。"""
    return _pwd_context.hash(password[:72])


def verify_password(password: str, password_hash: str) -> bool:
    """校验明文密码与哈希是否匹配。"""
    try:
        return _pwd_context.verify(password[:72], password_hash)
    except Exception:  # noqa: BLE001 - 非法哈希一律视为校验失败
        return False


def generate_token(nbytes: int = 32) -> str:
    """生成 URL 安全的随机令牌（用于邮箱确认/重置）。"""
    return secrets.token_urlsafe(nbytes)


def create_access_token(
    user_id: str,
    role: str,
    token_version: int,
    expires_seconds: int | None = None,
) -> str:
    """签发 HS256 access token。"""
    ttl = expires_seconds if expires_seconds is not None else settings.access_token_ttl
    now = utcnow()
    payload: dict[str, Any] = {
        "sub": user_id,
        "user_id": user_id,
        "role": role,
        "token_version": token_version,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> dict[str, Any]:
    """校验并解析 access token，失败抛 UNAUTHORIZED。"""
    try:
        return jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError as exc:
        raise AppError(ErrorCode.UNAUTHORIZED, "登录已过期，请重新登录") from exc
    except jwt.InvalidTokenError as exc:
        raise AppError(ErrorCode.UNAUTHORIZED) from exc
