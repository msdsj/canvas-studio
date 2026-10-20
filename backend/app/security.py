"""安全工具：密码哈希、JWT 签发/校验、随机令牌生成。"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from passlib.context import CryptContext

from app.config import settings
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import utcnow

_pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def _epoch(moment: datetime) -> int:
    """把 naive-UTC datetime 转成真正的 epoch 秒。

    `datetime.timestamp()` 对 naive 对象按**本地时区**解释，而 `utcnow()` 给的是
    naive UTC——直接调用会整体偏移一个时区（本机是 -8h），导致令牌实际有效期
    比配置短 8 小时。这里显式补上 UTC 时区再取时间戳。
    """
    return int(moment.replace(tzinfo=timezone.utc).timestamp())


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


#: 协作票据有效期：只用于「把 HTTP 的登录态换成一条 WS 连接」，30 秒足够
COLLAB_TICKET_TTL = 30


def create_collab_ticket(user_id: str, canvas_id: str, ttl: int = COLLAB_TICKET_TTL) -> str:
    """签发一次性协作票据。

    WebSocket 没法带 Authorization 头（浏览器 API 限制），把 access token 塞进
    query string 又会进浏览器历史/代理日志。所以先用 HTTP 换一张 30 秒有效、
    绑定单一画布的短票据，再拿它连 WS——即使泄漏，攻击窗口也极小。
    """
    now = utcnow()
    payload: dict[str, Any] = {
        "typ": "collab",
        "sub": user_id,
        "canvas_id": canvas_id,
        "iat": _epoch(now),
        "exp": _epoch(now + timedelta(seconds=ttl)),
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.jwt_algorithm)


def decode_collab_ticket(token: str) -> dict[str, Any]:
    """校验协作票据；类型不对也拒绝（防止拿 access token 冒充）。"""
    try:
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError as exc:
        raise AppError(ErrorCode.UNAUTHORIZED, "协作连接已过期，请刷新页面") from exc
    except jwt.InvalidTokenError as exc:
        raise AppError(ErrorCode.UNAUTHORIZED) from exc
    if payload.get("typ") != "collab":
        raise AppError(ErrorCode.UNAUTHORIZED)
    return payload
