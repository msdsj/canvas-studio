"""实时协作路由：`/api/collab/*`。

连接流程
--------
1. `POST /api/collab/{canvas_id}/ticket` 用 HTTP 登录态换一张 30 秒有效、
   绑定单一画布的票据；
2. `WS /api/collab/ws/{canvas_id}?ticket=...` 建连，服务端下发 `snapshot`；
3. 客户端发 `patch`（增量）/ `presence`（光标）/ `resync`（全量重拉）。

为什么 WS 不用 Authorization 头：浏览器 WebSocket API 不允许自定义头。把 access
token 放进 query 会写进浏览器历史、代理日志和 Referer，所以改用一次性票据。

连接断了会怎样：前端自动重连，重连时带 `?since=<version>`，服务端若能用手里的
环形缓冲补齐就直接补，否则让客户端重新拉全量。这样短暂断网不会丢编辑。
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, Query, WebSocket, WebSocketDisconnect
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal, get_db
from app.deps import get_current_user
from app.models.user import User
from app.security import decode_collab_ticket
from app.services import access, canvas_doc, collab_hub, collab_service
from app.utils.errors import AppError, ErrorCode, envelope
from app.utils.logging import get_logger

logger = get_logger("app.collab")

router = APIRouter(prefix="/api/collab", tags=["collab"])

#: 客户端心跳间隔上限（超过这个时间没消息就认为连接已死）
HEARTBEAT_TIMEOUT = 90.0


@router.post("/{canvas_id}/ticket")
async def create_ticket(
    canvas_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """换取协作票据（同时告诉前端「你有没有写权限」）。"""
    payload = await collab_service.issue_ticket(db, user, canvas_id)
    return envelope(payload)


@router.get("/{canvas_id}/participants")
async def participants(
    canvas_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """当前在线协作者（用于画布列表上的「谁在编辑」）。"""
    await access.get_canvas_for(db, user, canvas_id, "read")
    room = collab_hub.peek_room(canvas_id)
    return envelope(
        {
            "canvas_id": canvas_id,
            "count": len(room.peers) if room else 0,
            "participants": [peer.public() for peer in room.peers.values()] if room else [],
        }
    )


async def _authenticate(ticket: str, canvas_id: str) -> User:
    """用票据换出用户并校验画布权限。"""
    payload = decode_collab_ticket(ticket)
    if payload.get("canvas_id") != canvas_id:
        # 票据绑定单一画布：拿 A 画布的票据连 B 画布必须拒绝
        raise AppError(ErrorCode.UNAUTHORIZED, "这张协作票据不属于该画布")
    user_id = str(payload.get("sub") or "")
    async with AsyncSessionLocal() as db:
        user = await db.get(User, user_id)
        # 注意：User 没有软删除字段，禁用走 `status`（banned / 非 active）。
        # 这里必须和 deps.get_current_user 用同一套判据，否则被禁用的账号
        # 还能拿旧票据连协作通道继续写画布。
        if user is None or user.status == "banned":
            raise AppError(ErrorCode.UNAUTHORIZED)
        if user.status != "active":
            raise AppError(ErrorCode.UNAUTHORIZED)
        await access.get_canvas_for(db, user, canvas_id, "read")
        return user


@router.websocket("/ws/{canvas_id}")
async def collab_ws(
    websocket: WebSocket,
    canvas_id: str,
    ticket: str = Query(default=""),
    since: int = Query(default=-1),
) -> None:
    """协作主通道。

    `since` 是断线重连时客户端手里的版本号：能用手里的环形缓冲补齐就只补增量，
    补不齐才下发整份快照。一条 patch 通常几百字节，整份场景可能几 MB——
    网络抖动一下就要重传全部，是最容易让协作「感觉卡」的地方。
    """
    try:
        user = await _authenticate(ticket, canvas_id)
    except AppError as exc:
        await websocket.close(code=4401, reason=exc.message[:120])
        return

    async with AsyncSessionLocal() as db:
        try:
            room = await collab_service.open_room(db, canvas_id, user)
            ctx = await access.current_context(db, user)
            canvas = await access.get_canvas_for(db, user, canvas_id, "read")
            can_write = await access.can_access_canvas(db, user, canvas, "write", ctx)
        except AppError as exc:
            await websocket.close(code=4403, reason=exc.message[:120])
            return

        await websocket.accept()
        try:
            peer = await collab_hub.join(
                room,
                user_id=user.id,
                name=(user.display_name or user.email or "协作者"),
                websocket=websocket,
                can_write=can_write,
            )
        except AppError as exc:
            await websocket.close(code=4429, reason=exc.message[:120])
            return

        # 优先补增量；补不齐（首次连接 / 落后太多 / 服务端重启过）才发全量
        patches = room.replay_after(since) if since >= 0 else None
        if patches is None:
            await websocket.send_json(collab_hub.snapshot(room))
        else:
            await websocket.send_json(collab_hub.replay(room, since, patches))
        await collab_hub.broadcast(
            room,
            {
                "type": "peer_joined",
                "peer": peer.public(),
                "participants": [item.public() for item in room.peers.values()],
            },
            exclude=peer.id,
        )

        try:
            while True:
                raw = await asyncio.wait_for(
                    websocket.receive_text(), timeout=HEARTBEAT_TIMEOUT
                )
                await _handle_message(room, peer, raw)
        except asyncio.TimeoutError:
            logger.info("协作连接心跳超时 canvas=%s peer=%s", canvas_id, peer.id)
        except WebSocketDisconnect:
            pass
        except Exception:  # noqa: BLE001 - 单条连接异常不该影响房间
            logger.exception("协作连接异常 canvas=%s", canvas_id)
        finally:
            empty = await collab_hub.leave(room, peer.id)
            await collab_hub.broadcast(
                room,
                {
                    "type": "peer_left",
                    "peer_id": peer.id,
                    "participants": [item.public() for item in room.peers.values()],
                },
            )
            if empty:
                await collab_service.flush_and_close(room)


async def _handle_message(room: collab_hub.Room, peer: collab_hub.Peer, raw: str) -> None:
    """处理一条客户端消息。

    任何格式错误都只回一条 error，不断连接——断线重连的代价远大于让用户
    重发一次操作，而且 Excalidraw 会把错误当致命问题弹出整个画布。
    """
    try:
        message = json.loads(raw)
    except ValueError:
        await _send_error(peer, "BAD_JSON", "消息格式不对")
        return
    if not isinstance(message, dict):
        await _send_error(peer, "BAD_JSON", "消息格式不对")
        return

    kind = str(message.get("type") or "")

    if kind == "ping":
        await peer.websocket.send_json({"type": "pong"})
        return

    if kind == "presence":
        await collab_hub.update_presence(
            room,
            peer,
            message.get("cursor") if isinstance(message.get("cursor"), dict) else None,
            message.get("selection") if isinstance(message.get("selection"), list) else None,
        )
        return

    if kind == "resync":
        await peer.websocket.send_json(collab_hub.snapshot(room))
        return

    if kind == "patch":
        try:
            patch = canvas_doc.parse_patch(message.get("patch"))
            version, payload = await collab_service.apply_patch_and_schedule(
                room, peer, int(message.get("base_version") or 0), patch
            )
        except AppError as exc:
            await _send_error(peer, exc.code, exc.message, resync=exc.code == ErrorCode.CANVAS_VERSION_CONFLICT)
            return
        await collab_hub.broadcast(
            room,
            {
                "type": "patch",
                "version": version,
                "patch": payload,
                "author": peer.id,
                "user_id": peer.user_id,
            },
            exclude=peer.id,
        )
        return

    if kind == "full_state":
        try:
            version, _ = await collab_service.apply_full_and_schedule(
                room, peer, message.get("state")
            )
        except AppError as exc:
            await _send_error(peer, exc.code, exc.message)
            return
        await collab_hub.broadcast(
            room,
            {"type": "full_state", "version": version, "state": room.state, "author": peer.id},
            exclude=peer.id,
        )
        return

    await _send_error(peer, "UNKNOWN_TYPE", f"不认识的消息类型：{kind}")


async def _send_error(
    peer: collab_hub.Peer, code: str, message: str, *, resync: bool = False
) -> None:
    """回一条错误（尽力而为，连接已断就忽略）。"""
    try:
        await peer.websocket.send_json(
            {"type": "error", "code": code, "message": message, "resync": resync}
        )
    except Exception:  # noqa: BLE001
        pass
