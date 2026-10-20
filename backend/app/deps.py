"""FastAPI 依赖注入：当前用户、管理员守卫、分页参数。"""
from __future__ import annotations

from typing import Annotated

from fastapi import Depends, Header, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models.user import User
from app.security import decode_access_token
from app.utils.errors import AppError, ErrorCode


async def get_current_user(
    authorization: Annotated[str | None, Header()] = None,
    db: AsyncSession = Depends(get_db),
) -> User:
    """解析 Bearer JWT 并返回当前用户。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise AppError(ErrorCode.UNAUTHORIZED)
    token = authorization.split(" ", 1)[1].strip()
    payload = decode_access_token(token)
    user_id = payload.get("user_id") or payload.get("sub")
    if not user_id:
        raise AppError(ErrorCode.UNAUTHORIZED)

    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if user is None:
        raise AppError(ErrorCode.UNAUTHORIZED)
    # token_version 校验：登出全部设备后旧 token 失效
    if int(payload.get("token_version", 0)) != int(user.token_version):
        raise AppError(ErrorCode.UNAUTHORIZED, "登录状态已失效，请重新登录")
    if user.status == "banned":
        raise AppError(ErrorCode.FORBIDDEN, user.banned_reason or "账号已被封禁")
    if user.status != "active":
        raise AppError(ErrorCode.FORBIDDEN, "账号未激活，请先完成邮箱确认")
    return user


async def require_admin(
    user: User = Depends(get_current_user),
) -> User:
    """要求当前用户为管理员。"""
    if user.role != "admin":
        raise AppError(ErrorCode.FORBIDDEN, "需要管理员权限")
    return user


# 已解锁全部功能的角色：Pro 与管理员（管理员天然直通，无需激活码）
UNLOCKED_ROLES = ("pro", "admin")


def is_unlocked(user: User | None) -> bool:
    """判断用户是否已解锁全部功能（画布 / 抠图 / AI 对话 / 润色 / 图生图）。

    这是**纯同步**的快速判定，只看角色。团队成员的能力解锁需要查库，
    用 `unlocked_async()`；`require_pro` 已经接好了这条链路。
    """
    return bool(user and user.role in UNLOCKED_ROLES)


async def unlocked_async(db: AsyncSession, user: User) -> bool:
    """完整判定：角色直通，或已加入任一有效团队（按席位解锁）。"""
    if is_unlocked(user):
        return True
    from app.services import access

    return await access.has_active_team(db, user)


async def require_pro(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> User:
    """要求 Pro（或管理员 / 团队成员）身份。

    未激活时抛 `PRO_REQUIRED`（402），前端据此弹出「升级 / 激活 Pro」引导，
    而不是展示一条冷冰冰的 403。

    团队席位等价于 Pro：企业买了席位却还要逐个成员再买激活码，是卖不出去的。
    """
    if await unlocked_async(db, user):
        return user
    raise AppError(ErrorCode.PRO_REQUIRED)


async def pagination_params(
    page: int = Query(default=1, ge=1),
    size: int = Query(default=20, ge=1, le=100),
) -> tuple[int, int]:
    """分页参数依赖。"""
    return page, size


CurrentUser = Annotated[User, Depends(get_current_user)]
AdminUser = Annotated[User, Depends(require_admin)]
ProUser = Annotated[User, Depends(require_pro)]
DbSession = Annotated[AsyncSession, Depends(get_db)]
Pagination = Annotated[tuple[int, int], Depends(pagination_params)]
