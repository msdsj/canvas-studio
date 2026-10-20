"""协作服务：房间与数据库之间的桥。

职责边界
--------
`collab_hub` 只管内存里的房间（合并、广播），不知道数据库存在；
这里负责「进房间前从库里读、离开房间后写回库」。分开的好处是 hub 可以纯内存
单测，而落库策略（防抖、冲突、审计）可以独立演进。

落库为什么防抖
--------------
拖一次矩形 Excalidraw 会连发几十条 patch。每条都 `UPDATE canvases SET state=...`
意味着每秒几十次全量 JSON 序列化 + SQLite 写锁，会直接拖慢同一库里的生成任务进度。
所以攒 1.5 秒写一次，最后一人离开时强制写。
"""
from __future__ import annotations

import asyncio
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal
from app.models.canvas import Canvas
from app.models.user import User
from app.security import create_collab_ticket
from app.services import access, canvas_doc, collab_hub
from app.utils.ids import utcnow
from app.utils.logging import get_logger

logger = get_logger("app.collab_service")


async def open_room(db: AsyncSession, canvas_id: str, user: User) -> collab_hub.Room:
    """取得房间；首次进入时用库里的场景填充。"""
    room = await collab_hub.get_room(canvas_id)
    if not room.history and not room.peers:
        canvas = await access.get_canvas_for(db, user, canvas_id, "read")
        collab_hub.seed(room, canvas.state, canvas.version)
    return room


async def issue_ticket(db: AsyncSession, user: User, canvas_id: str) -> dict[str, Any]:
    """签发协作票据（先做一次权限校验，没权限的人连票据都拿不到）。"""
    canvas = await access.get_canvas_for(db, user, canvas_id, "read")
    ctx = await access.current_context(db, user)
    can_write = await access.can_access_canvas(db, user, canvas, "write", ctx)
    return {
        "ticket": create_collab_ticket(user.id, canvas_id),
        "canvas_id": canvas_id,
        "version": int(canvas.version or 0),
        "can_write": can_write,
        "ws_path": f"/api/collab/ws/{canvas_id}",
    }


async def persist_room(room: collab_hub.Room) -> None:
    """把房间里的场景写回数据库。

    只更新 `state / version / updated_at`，并且**不校验属主**——协作场景下
    写回是系统行为，不是「谁改的」，所以这里直接操作行（权限在入口已校验）。
    """
    async with AsyncSessionLocal() as db:
        canvas = await db.get(Canvas, room.canvas_id)
        if canvas is None:
            logger.warning("协作落库时画布已不存在：%s", room.canvas_id)
            return
        canvas.state = room.state
        canvas.version = room.version
        canvas.updated_at = utcnow()
        await db.commit()
    room.dirty = False


def schedule_persist(room: collab_hub.Room) -> None:
    """防抖落库（同一房间同时只挂一个任务）。"""
    if room._persist_task and not room._persist_task.done():
        return

    async def _worker() -> None:
        try:
            await asyncio.sleep(collab_hub.PERSIST_DEBOUNCE)
            if room.dirty:
                await persist_room(room)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - 落库失败不该影响协作本身
            logger.exception("协作落库失败 canvas=%s", room.canvas_id)

    room._persist_task = asyncio.create_task(_worker())


async def flush_and_close(room: collab_hub.Room) -> None:
    """房间空了：强制落库并释放。"""
    task = room._persist_task
    if task and not task.done():
        task.cancel()
    if room.dirty:
        try:
            await persist_room(room)
        except Exception:  # noqa: BLE001
            logger.exception("协作收尾落库失败 canvas=%s", room.canvas_id)
    await collab_hub.drop_room(room.canvas_id)


async def apply_patch_and_schedule(
    room: collab_hub.Room, peer: collab_hub.Peer, base_version: int, patch: canvas_doc.Patch
) -> tuple[int, dict[str, Any]]:
    """应用 patch 并安排落库。"""
    version, payload = await collab_hub.apply_client_patch(
        room, peer, base_version=base_version, patch=patch
    )
    schedule_persist(room)
    return version, payload


async def apply_full_and_schedule(
    room: collab_hub.Room, peer: collab_hub.Peer, state: Any
) -> tuple[int, dict[str, Any]]:
    """整份覆盖并安排落库。"""
    version, payload = await collab_hub.apply_full_state(room, peer, state)
    schedule_persist(room)
    return version, payload
