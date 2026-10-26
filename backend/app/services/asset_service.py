"""资产服务：列表 / 上传 / 生成入库 / 删除 / 下载。

团队素材：`team_id` 非空且 `visibility='team'` 时团队成员都可读可复用；
写操作（删除、改可见性）需要 `asset.manage`。归属校验走 `access`。
"""
from __future__ import annotations

import mimetypes

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.asset import Asset
from app.models.user import User
from app.services import access, storage_service
from app.utils import offload
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id, utcnow

ALLOWED_MIME = {"image/png", "image/jpeg", "image/jpg", "image/webp"}
ALLOWED_EXT = {"png", "jpg", "jpeg", "webp"}


async def list_assets(
    db: AsyncSession,
    user: User,
    page: int,
    size: int,
    kind: str | None = None,
    q: str | None = None,
    scope: str = "all",
) -> tuple[list[Asset], int]:
    """分页查询资产（时间倒序）。

    `scope`：all = 我的 + 团队共享；mine = 只看我的；team = 只看团队共享。
    团队素材与个人素材混在一个列表里时，用户分不清「这张是公司的还是我的」，
    所以接口保留显式过滤能力，前端用分段控件切换。
    """
    ctx = await access.current_context(db, user)
    conditions = [Asset.deleted_at.is_(None)]
    if scope == "mine":
        conditions.append(Asset.owner_id == user.id)
    elif scope == "team":
        if ctx.team is None:
            return [], 0
        conditions.append(Asset.team_id == ctx.team.id)
        conditions.append(Asset.visibility == "team")
    else:
        conditions.append(access.asset_scope_clause(user, ctx))
    if kind:
        conditions.append(Asset.kind == kind)
    if q:
        conditions.append(Asset.source_prompt.like(f"%{q}%"))
    base = select(Asset).where(*conditions)
    total = int(
        (
            await db.execute(select(func.count()).select_from(base.order_by(None).subquery()))
        ).scalar()
        or 0
    )
    result = await db.execute(
        base.order_by(Asset.created_at.desc()).offset((page - 1) * size).limit(size)
    )
    return list(result.scalars().all()), total


async def get_asset(
    db: AsyncSession, user: User, asset_id: str, permission: str = "read"
) -> Asset:
    """获取资产并校验访问权限。"""
    return await access.get_asset_for(db, user, asset_id, permission)  # type: ignore[arg-type]


async def create_from_bytes(
    db: AsyncSession,
    user_id: str,
    data: bytes,
    *,
    kind: str,
    filename: str = "",
    content_type: str = "",
    prompt: str = "",
    is_demo: bool = False,
    generation_task_id: str | None = None,
) -> Asset:
    """把图片字节写入存储并登记资产。

    `save_image` 内部要解码读宽高 + 生成 JPEG 缩略图 + 写两个文件，全是同步重活。
    上传接口与生成任务都会走这里，必须挪出事件循环，否则多用户同时上传/出图时
    整个进程会卡在磁盘与 Pillow 上。
    """
    ext = _guess_ext(filename, content_type)
    saved = await offload.run_sync(storage_service.save_image, user_id, data, ext)
    mime = content_type or mimetypes.guess_type(f"x.{ext}")[0] or "image/png"
    asset = Asset(
        id=new_id(),
        owner_id=user_id,
        kind=kind,
        url=saved["url"],
        thumb_url=saved["thumb_url"] or None,
        width=saved["width"],
        height=saved["height"],
        size_bytes=saved["size"],
        mime=mime,
        source_prompt=prompt,
        is_demo=is_demo,
        generation_task_id=generation_task_id,
    )
    db.add(asset)
    await db.flush()
    return asset


def _guess_ext(filename: str, content_type: str) -> str:
    """推断文件扩展名。"""
    if filename and "." in filename:
        ext = filename.rsplit(".", 1)[1].lower()
        if ext in ALLOWED_EXT:
            return "jpg" if ext == "jpeg" else ext
    if content_type:
        ext = content_type.split("/")[-1].lower()
        if ext in ALLOWED_EXT:
            return "jpg" if ext == "jpeg" else ext
    return "png"


async def upload(
    db: AsyncSession,
    user: User,
    filename: str,
    content_type: str,
    data: bytes,
    prompt: str = "",
    *,
    share_with_team: bool = False,
) -> Asset:
    """上传图片（校验类型与大小，0 积分）。`prompt` 为上传流程内置提示词配置。"""
    if content_type and content_type not in ALLOWED_MIME:
        raise AppError(ErrorCode.VALIDATION_ERROR, "仅支持 png/jpg/webp 图片")
    limit = settings.max_upload_mb * 1024 * 1024
    if len(data) > limit:
        raise AppError(ErrorCode.VALIDATION_ERROR, f"文件超过 {settings.max_upload_mb}MB 上限")
    if not data:
        raise AppError(ErrorCode.VALIDATION_ERROR, "文件内容为空")
    asset = await create_from_bytes(
        db,
        user.id,
        data,
        kind="uploaded",
        filename=filename,
        content_type=content_type,
        prompt=prompt.strip(),
    )
    ctx = await access.current_context(db, user)
    access.stamp_team(asset, ctx, share=share_with_team)
    await db.flush()
    return asset


async def delete_asset(db: AsyncSession, user: User, asset_id: str) -> None:
    """软删除资产（仅移出资产库）。"""
    target = await get_asset(db, user, asset_id, "write")
    target.deleted_at = utcnow()
    await db.flush()


async def find_by_url(db: AsyncSession, user: User, url: str) -> Asset | None:
    """按对外 URL 找已登记资产（只返回当前用户可读的）。

    用途：生成结果落画布时，前端原本要把整张图下载下来再上传一次才能拿到
    asset_id——一张 2MB 的 PNG 就是 2MB 下行 + 2MB 上行，用户看到的就是
    「放入画布等半天」。其实生成任务早就把资产登记好了（`generation_task_id`），
    这里按 URL 直接换回 id，省掉整个往返。
    """
    target = str(url or "").strip()
    if not target:
        return None
    ctx = await access.current_context(db, user)
    row = (
        await db.execute(
            select(Asset).where(
                Asset.url == target,
                Asset.deleted_at.is_(None),
                access.asset_scope_clause(user, ctx),
            )
        )
    ).scalars().first()
    return row


def local_path_from_url(url: str) -> str | None:
    """把对外 URL 反解为本地相对路径（用于下载）。"""
    base = settings.storage_public_base.rstrip("/")
    if not url.startswith(base):
        return None
    return url[len(base):].lstrip("/")


async def delete_assets(db: AsyncSession, user: User, asset_ids: list[str]) -> int:
    """批量软删资产，返回实际删除条数（越权 id 会被静默跳过）。

    团队素材允许 `asset.manage` 角色删除：企业侧需要有人能清理公共素材库，
    但普通成员删不到别人的图。
    """
    ids = [item for item in dict.fromkeys(asset_ids) if item]
    if not ids:
        return 0
    ctx = await access.current_context(db, user)
    if ctx.has("asset.manage") and ctx.team is not None:
        owner_clause = access.asset_scope_clause(user, ctx)
    else:
        owner_clause = Asset.owner_id == user.id
    rows = (
        await db.execute(
            select(Asset).where(
                Asset.id.in_(ids),
                owner_clause,
                Asset.deleted_at.is_(None),
            )
        )
    ).scalars().all()
    now = utcnow()
    for row in rows:
        row.deleted_at = now
    await db.flush()
    return len(rows)


async def set_visibility(
    db: AsyncSession, user: User, asset_ids: list[str], visibility: str
) -> int:
    """把资产设为团队共享 / 收回私有（返回受影响条数）。

    只有属主能把自己的图放出去；管理员可以把团队素材收回私有，
    但不能把别人的个人素材强行公开——那等于替人做隐私决定。
    """
    if visibility not in ("private", "team"):
        raise AppError(ErrorCode.VALIDATION_ERROR, "可见性只能是 private 或 team")
    ids = [item for item in dict.fromkeys(asset_ids) if item]
    if not ids:
        return 0
    ctx = await access.current_context(db, user)
    rows = (
        await db.execute(
            select(Asset).where(Asset.id.in_(ids), Asset.deleted_at.is_(None))
        )
    ).scalars().all()
    changed = 0
    for row in rows:
        is_owner = row.owner_id == user.id
        can_manage_team = (
            ctx.team is not None
            and row.team_id == ctx.team.id
            and ctx.has("asset.manage")
        )
        if not (is_owner or can_manage_team):
            continue
        if visibility == "team":
            if ctx.team is None:
                raise AppError(ErrorCode.VALIDATION_ERROR, "当前不在团队里，无法共享给团队")
            row.team_id = ctx.team.id
        elif not is_owner:
            # 管理员收回团队共享：只改可见性，不动归属
            pass
        row.visibility = visibility
        changed += 1
    await db.flush()
    return changed
