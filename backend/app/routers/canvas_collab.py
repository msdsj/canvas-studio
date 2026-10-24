"""画布协作扩展路由：打点评论 + 版本历史。

权限沿用 `access.get_canvas_for`：
- 读评论/版本：画布可读即可（查看者也能看讨论与历史）；
- 写评论、建快照、恢复版本：需要画布可写（所有者 / 编辑者）。

为什么评论与版本不做 WebSocket 广播
----------------------------------
两者都是「低频、强一致」的操作：一条评论发出去，别人刷新就能看到，
不需要 16ms 级的同步。走 HTTP + 前端轮询/手动刷新，比在协作协议里
新增两种消息类型更简单，也不会拖慢拖拽同步的主链路。
"""
from __future__ import annotations

import re
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.deps import require_pro
from app.models.canvas import Canvas
from app.models.collab_ext import CanvasComment, CanvasVersion
from app.models.collaboration import CanvasCollaborator
from app.models.team import TeamMember
from app.models.user import User
from app.services import access, collab_hub
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.ids import utcnow

router = APIRouter(prefix="/api", tags=["canvas-collab"])

MAX_VERSIONS_PER_CANVAS = 30


class CommentCreate(BaseModel):
    """新建评论：坐标是画布坐标系。"""

    content: str = Field(min_length=1, max_length=2000)
    x: float = 0.0
    y: float = 0.0
    element_id: str | None = None
    parent_id: str | None = None
    mentions: list[str] = Field(default_factory=list)


class CommentUpdate(BaseModel):
    content: str | None = Field(default=None, max_length=2000)
    resolved: bool | None = None


class VersionCreate(BaseModel):
    label: str = Field(default="手动存档", max_length=120)


async def _user_brief(db: AsyncSession, user_id: str | None) -> dict[str, Any]:
    if not user_id:
        return {"id": "", "name": "已注销用户", "avatar": ""}
    user = await db.get(User, user_id)
    if user is None:
        return {"id": user_id, "name": "已注销用户", "avatar": ""}
    name = user.display_name or user.email.split("@")[0]
    return {"id": user.id, "name": name, "avatar": ""}


async def _resolve_mentions(
    db: AsyncSession, canvas: Canvas, raw: list[str], content: str
) -> list[dict[str, str]]:
    """把 @ 转成成员 id：前端可以显式传 id，也可以只写 `@昵称` 让后端匹配。"""
    candidates: dict[str, str] = {}
    owner = await db.get(User, canvas.owner_id)
    if owner is not None:
        candidates[owner.display_name or owner.email.split("@")[0]] = owner.id
        candidates[owner.email.split("@")[0]] = owner.id
    if canvas.team_id:
        rows = (
            await db.execute(
                select(TeamMember.user_id, User.display_name, User.email).join(
                    User, User.id == TeamMember.user_id
                ).where(TeamMember.team_id == canvas.team_id)
            )
        ).all()
        for row in rows:
            if row.display_name:
                candidates[row.display_name] = row.user_id
            if row.email:
                candidates[row.email.split("@")[0]] = row.user_id
    collab = (
        await db.execute(
            select(CanvasCollaborator.user_id).where(CanvasCollaborator.canvas_id == canvas.id)
        )
    ).all()
    for row in collab:
        user = await db.get(User, row.user_id)
        if user and user.display_name:
            candidates.setdefault(user.display_name, user.id)

    resolved: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in raw:
        if item and item not in seen:
            seen.add(item)
            brief = await _user_brief(db, item)
            resolved.append({"id": item, "name": brief["name"]})
    for name in re.findall(r"@([\w\u4e00-\u9fff.\-]{1,24})", content):
        user_id = candidates.get(name)
        if user_id and user_id not in seen:
            seen.add(user_id)
            resolved.append({"id": user_id, "name": name})
    return resolved[:10]


def _comment_out(item: CanvasComment, author: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item.id,
        "canvas_id": item.canvas_id,
        "x": item.x,
        "y": item.y,
        "element_id": item.element_id,
        "parent_id": item.parent_id,
        "content": item.content,
        "mentions": item.mentions or [],
        "resolved": bool(item.resolved),
        "author": author,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


# ---------------------------------------------------------------------------
# 评论
# ---------------------------------------------------------------------------
@router.get("/canvases/{canvas_id}/comments")
async def list_comments(
    canvas_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
    include_resolved: bool = Query(default=True),
) -> dict:
    """列出画布评论（按创建时间正序，楼中楼由前端按 parent_id 组装）。"""
    await access.get_canvas_for(db, user, canvas_id, "read")
    stmt = select(CanvasComment).where(
        CanvasComment.canvas_id == canvas_id, CanvasComment.deleted_at.is_(None)
    )
    if not include_resolved:
        stmt = stmt.where(CanvasComment.resolved.is_(False))
    rows = (await db.execute(stmt.order_by(CanvasComment.created_at.asc()))).scalars().all()
    items = list(rows)
    authors: dict[str, dict[str, Any]] = {}
    for item in items:
        if item.user_id not in authors:
            authors[item.user_id] = await _user_brief(db, item.user_id)
    return envelope(
        {
            "items": [_comment_out(item, authors.get(item.user_id, {})) for item in items],
            "total": len(items),
            "unresolved": sum(1 for item in items if not item.resolved),
        }
    )


@router.post("/canvases/{canvas_id}/comments")
async def create_comment(
    canvas_id: str,
    payload: CommentCreate,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """在画布上打一个评论点（支持 @ 成员）。"""
    canvas = await access.get_canvas_for(db, user, canvas_id, "write")
    if payload.parent_id:
        parent = await db.get(CanvasComment, payload.parent_id)
        if parent is None or parent.canvas_id != canvas_id or parent.deleted_at is not None:
            raise AppError(ErrorCode.VALIDATION_ERROR, "回复的评论不存在")
    mentions = await _resolve_mentions(db, canvas, payload.mentions, payload.content)
    item = CanvasComment(
        canvas_id=canvas_id,
        user_id=user.id,
        content=payload.content.strip(),
        x=max(-1e6, min(1e6, payload.x)),
        y=max(-1e6, min(1e6, payload.y)),
        element_id=payload.element_id,
        parent_id=payload.parent_id,
        mentions=mentions,
    )
    db.add(item)
    await db.commit()
    author = await _user_brief(db, user.id)
    return envelope(_comment_out(item, author))


@router.patch("/canvas-comments/{comment_id}")
async def update_comment(
    comment_id: str,
    payload: CommentUpdate,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """编辑内容（仅作者）或标记已解决（可写者都可以）。"""
    item = await db.get(CanvasComment, comment_id)
    if item is None or item.deleted_at is not None:
        raise AppError(ErrorCode.NOT_FOUND, "评论不存在")
    canvas = await access.get_canvas_for(db, user, item.canvas_id, "read")
    writable = await access.can_access_canvas(
        db, user, canvas, "write", await access.current_context(db, user)
    )
    if payload.content is not None:
        if item.user_id != user.id:
            raise AppError(ErrorCode.FORBIDDEN, "只能修改自己的评论")
        item.content = payload.content.strip()
    if payload.resolved is not None:
        if not writable:
            raise AppError(ErrorCode.FORBIDDEN, "没有权限标记该评论")
        item.resolved = payload.resolved
    item.updated_at = utcnow()
    await db.commit()
    return envelope(_comment_out(item, await _user_brief(db, item.user_id)))


@router.delete("/canvas-comments/{comment_id}")
async def delete_comment(
    comment_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """软删评论：作者本人或画布属主。"""
    item = await db.get(CanvasComment, comment_id)
    if item is None or item.deleted_at is not None:
        raise AppError(ErrorCode.NOT_FOUND, "评论不存在")
    canvas = await access.get_canvas_for(db, user, item.canvas_id, "read")
    if item.user_id != user.id and canvas.owner_id != user.id:
        raise AppError(ErrorCode.FORBIDDEN, "只能删除自己的评论")
    item.deleted_at = utcnow()
    await db.commit()
    return envelope({"deleted": True})


# ---------------------------------------------------------------------------
# 版本历史
# ---------------------------------------------------------------------------
def _version_out(item: CanvasVersion, author_name: str = "") -> dict[str, Any]:
    return {
        "id": item.id,
        "label": item.label,
        "kind": item.kind,
        "version": item.version,
        "element_count": item.element_count,
        "author": author_name,
        "created_at": item.created_at,
        "preview": [e.get("id") for e in (item.state or {}).get("elements", [])[:6]]
        if isinstance(item.state, dict)
        else [],
    }


async def _snapshot(
    db: AsyncSession,
    canvas: Canvas,
    user_id: str | None,
    *,
    label: str,
    kind: str,
    state: dict[str, Any] | None = None,
) -> CanvasVersion:
    """写一份快照并裁掉最老的（保留最近 30 份）。"""
    payload = state if isinstance(state, dict) else (canvas.state or {})
    elements = payload.get("elements") if isinstance(payload, dict) else []
    item = CanvasVersion(
        canvas_id=canvas.id,
        user_id=user_id,
        label=label[:120],
        kind=kind,
        version=int(canvas.version or 0),
        state=payload,
        element_count=len(elements or []),
    )
    db.add(item)
    await db.flush()
    rows = (
        await db.execute(
            select(CanvasVersion.id)
            .where(CanvasVersion.canvas_id == canvas.id)
            .order_by(CanvasVersion.created_at.desc())
        )
    ).all()
    if len(rows) > MAX_VERSIONS_PER_CANVAS:
        for row in rows[MAX_VERSIONS_PER_CANVAS:]:
            old = await db.get(CanvasVersion, row.id)
            if old is not None:
                await db.delete(old)
    return item


@router.get("/canvases/{canvas_id}/versions")
async def list_versions(
    canvas_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """版本列表（不含 state，避免一次返回几十份大 JSON）。"""
    await access.get_canvas_for(db, user, canvas_id, "read")
    rows = (
        await db.execute(
            select(CanvasVersion)
            .where(CanvasVersion.canvas_id == canvas_id)
            .order_by(CanvasVersion.created_at.desc())
            .limit(MAX_VERSIONS_PER_CANVAS)
        )
    ).scalars().all()
    names: dict[str, str] = {}
    for item in rows:
        if item.user_id and item.user_id not in names:
            names[item.user_id] = (await _user_brief(db, item.user_id))["name"]
    return envelope(
        {"items": [_version_out(item, names.get(item.user_id or "", "")) for item in rows]}
    )


@router.post("/canvases/{canvas_id}/versions")
async def create_version(
    canvas_id: str,
    payload: VersionCreate,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """手动存档当前画布。"""
    canvas = await access.get_canvas_for(db, user, canvas_id, "write")
    room = collab_hub.peek_room(canvas_id)
    # 协作房间里的状态比库里新（防抖落库有 1.5s 延迟），优先用房间状态
    state = room.state if room is not None and room.peers else canvas.state
    item = await _snapshot(db, canvas, user.id, label=payload.label, kind="manual", state=state)
    await db.commit()
    return envelope(_version_out(item, (await _user_brief(db, user.id))["name"]))


@router.get("/canvases/{canvas_id}/versions/{version_id}")
async def get_version(
    canvas_id: str,
    version_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """取某个版本的完整 state（用于预览/对比）。"""
    await access.get_canvas_for(db, user, canvas_id, "read")
    item = await db.get(CanvasVersion, version_id)
    if item is None or item.canvas_id != canvas_id:
        raise AppError(ErrorCode.NOT_FOUND, "版本不存在")
    return envelope({**_version_out(item), "state": item.state})


@router.post("/canvases/{canvas_id}/versions/{version_id}/restore")
async def restore_version(
    canvas_id: str,
    version_id: str,
    user: User = Depends(require_pro),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """一键恢复到历史版本。

    恢复前**先给当前状态存一版**，这样「恢复错了」还能再回来——
    没有这一步的「一键恢复」是单向门，用户不敢点。
    """
    canvas = await access.get_canvas_for(db, user, canvas_id, "write")
    target = await db.get(CanvasVersion, version_id)
    if target is None or target.canvas_id != canvas_id:
        raise AppError(ErrorCode.NOT_FOUND, "版本不存在")

    await _snapshot(db, canvas, user.id, label="恢复前自动存档", kind="auto")
    canvas.state = target.state or {}
    canvas.version = int(canvas.version or 0) + 1
    canvas.updated_at = utcnow()
    canvas.updated_by = user.id
    restored = await _snapshot(
        db, canvas, user.id, label=f"恢复到「{target.label}」", kind="restore", state=canvas.state
    )
    await db.commit()
    # 通知在线协作者重新拉全量（房间存在时）
    room = collab_hub.peek_room(canvas_id)
    if room is not None and room.peers:
        try:
            await collab_hub.broadcast(
                room,
                {
                    "type": "full_state",
                    "version": canvas.version,
                    "state": canvas.state,
                    "author": "system",
                },
            )
        except Exception:  # noqa: BLE001 - 广播失败不影响恢复结果
            pass
    return envelope({"version": canvas.version, "snapshot_id": restored.id})
