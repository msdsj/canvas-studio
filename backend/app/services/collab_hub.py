"""实时协作：房间管理、增量广播、presence。

单进程房间
----------
房间状态放在进程内存（`_ROOMS`）。这在本项目的部署形态下是对的：后端是单进程
uvicorn + SQLite，没有多实例。一旦要多实例，`broadcast` 换成 Redis Pub/Sub 即可，
上层协议（`join/patch/presence/resync`）不需要改——所以这里刻意把「协议」和
「投递」分开。

持久化策略
----------
- 房间内的 patch **立即**应用到内存文档（保证后续 patch 的合并基准是最新的）；
- 落库走 1.5 秒防抖 + 最后一人离开时强制落库：Excalidraw 拖一个矩形会连发
  几十次 patch，每次都写 SQLite 会把写锁打满（生成任务进度也在写同一个库）。
- 落库失败不丢内存状态，下个 tick 继续重试。

版本号
------
每次 patch 让 `version += 1`，并记进环形缓冲（最近 200 条）。客户端带着
`base_version` 来，若落后超过缓冲范围就要求 `resync`（全量拉一次），
避免基于过旧状态合并出「元素复活」。
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any

from app.services import canvas_doc
from app.utils.errors import AppError, ErrorCode
from app.utils.ids import new_id
from app.utils.logging import get_logger

logger = get_logger("app.collab")

#: 版本缓冲深度：客户端落后超过这个数就要求全量重同步
VERSION_BUFFER = 200
#: 落库防抖（秒）
PERSIST_DEBOUNCE = 1.5
#: 房间空闲多久后回收（秒）——无人时立刻落库并释放内存
IDLE_TTL = 60.0
#: 单房间最大连接数（防止一个画布被无限开标签页拖垮）
MAX_PEERS = 24


@dataclass
class Peer:
    """一个协作连接。"""

    id: str
    user_id: str
    name: str
    color: str
    websocket: Any
    joined_at: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    cursor: dict[str, Any] | None = None
    selection: list[str] = field(default_factory=list)
    # 视口（zoom / scrollX / scrollY）：用于「跟随协作者视角」
    viewport: dict[str, Any] | None = None
    can_write: bool = True

    def public(self) -> dict[str, Any]:
        """广播给其他人的在线信息（不含 ws 对象）。"""
        return {
            "id": self.id,
            "user_id": self.user_id,
            "name": self.name,
            "color": self.color,
            "cursor": self.cursor,
            "selection": self.selection,
            "viewport": self.viewport,
            "can_write": self.can_write,
        }


@dataclass
class Room:
    """一块画布的协作房间。"""

    canvas_id: str
    state: dict[str, Any] = field(default_factory=canvas_doc.empty_state)
    version: int = 0
    peers: dict[str, Peer] = field(default_factory=dict)
    #: version → patch payload（环形）
    history: list[tuple[int, dict[str, Any]]] = field(default_factory=list)
    tombstones: set[str] = field(default_factory=set)
    dirty: bool = False
    last_activity: float = field(default_factory=time.time)
    _persist_task: asyncio.Task | None = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def remember(self, version: int, payload: dict[str, Any]) -> None:
        self.history.append((version, payload))
        if len(self.history) > VERSION_BUFFER:
            self.history = self.history[-VERSION_BUFFER:]

    def can_replay_from(self, base_version: int) -> bool:
        """能否用缓冲里的增量补齐（否则要全量重同步）。"""
        if base_version >= self.version:
            return True
        if not self.history:
            return False
        oldest = self.history[0][0]
        return base_version + 1 >= oldest

    def replay_after(self, since: int) -> list[tuple[int, dict[str, Any]]] | None:
        """返回 `since` 之后的所有增量；`None` 表示补不齐，得走全量。

        补不齐的三种情况：客户端比房间还新（房间被重建过，说明本地状态不可信）、
        落后超过缓冲深度（中间那些版本已经淘汰）、缓冲为空但版本对不上。
        """
        if since == self.version:
            return []
        # 客户端版本高于房间：房间一定被重建过，宁可全量也别让两边各说各话
        if since > self.version:
            return None
        if not self.can_replay_from(since):
            return None
        return [(version, payload) for version, payload in self.history if version > since]


_ROOMS: dict[str, Room] = {}
_ROOMS_LOCK = asyncio.Lock()

#: 协作者头像用的稳定配色（按 user_id 取模，同一个人在任何画布上颜色一致）
PEER_COLORS = (
    "#5B8FF9",
    "#61DDAA",
    "#F6BD16",
    "#7262FD",
    "#78D3F8",
    "#9661BC",
    "#F6903D",
    "#F08BB4",
)


def peer_color(user_id: str) -> str:
    """按 user_id 稳定取色。"""
    total = sum(ord(ch) for ch in user_id)
    return PEER_COLORS[total % len(PEER_COLORS)]


async def get_room(canvas_id: str) -> Room:
    """取（或创建）房间。首次创建时由调用方用 `seed()` 填充磁盘上的场景。"""
    async with _ROOMS_LOCK:
        room = _ROOMS.get(canvas_id)
        if room is None:
            room = Room(canvas_id=canvas_id)
            _ROOMS[canvas_id] = room
        room.last_activity = time.time()
        return room


def peek_room(canvas_id: str) -> Room | None:
    """只读查看房间（不存在返回 None）。"""
    return _ROOMS.get(canvas_id)


def seed(room: Room, state: Any, version: int) -> None:
    """用磁盘上的场景初始化房间（仅首次，且房间里还没有任何 patch 时）。"""
    if room.history or room.peers:
        return
    room.state = canvas_doc.normalize_state(state)
    room.version = max(int(version or 0), 0)


async def drop_room(canvas_id: str) -> None:
    """释放房间（测试与维护用）。"""
    async with _ROOMS_LOCK:
        room = _ROOMS.pop(canvas_id, None)
    if room is not None and room._persist_task and not room._persist_task.done():
        room._persist_task.cancel()


def peer_count(canvas_id: str) -> int:
    room = _ROOMS.get(canvas_id)
    return len(room.peers) if room else 0


async def join(
    room: Room, *, user_id: str, name: str, websocket: Any, can_write: bool = True
) -> Peer:
    """加入房间。"""
    if len(room.peers) >= MAX_PEERS:
        raise AppError(ErrorCode.RATE_LIMITED, "这块画布同时协作的人太多了，稍后再试")
    peer = Peer(
        id=new_id(),
        user_id=user_id,
        name=name or "协作者",
        color=peer_color(user_id),
        websocket=websocket,
        can_write=can_write,
    )
    room.peers[peer.id] = peer
    room.last_activity = time.time()
    return peer


async def leave(room: Room, peer_id: str) -> bool:
    """离开房间；返回房间是否已空。"""
    room.peers.pop(peer_id, None)
    room.last_activity = time.time()
    return not room.peers


async def broadcast(room: Room, message: dict[str, Any], *, exclude: str | None = None) -> None:
    """向房间内所有连接推送。

    单个连接发送失败（浏览器已关页面）只把它踢掉，不影响其他人——
    `asyncio.gather` 里任何一个异常都不该让整轮广播中断。
    """
    dead: list[str] = []
    for peer_id, peer in list(room.peers.items()):
        if exclude is not None and peer_id == exclude:
            continue
        try:
            await peer.websocket.send_json(message)
        except Exception:  # noqa: BLE001 - 断开的连接不值得重试
            dead.append(peer_id)
    for peer_id in dead:
        room.peers.pop(peer_id, None)


async def apply_client_patch(
    room: Room,
    peer: Peer,
    *,
    base_version: int,
    patch: canvas_doc.Patch,
) -> tuple[int, dict[str, Any]]:
    """应用客户端 patch，返回 (新版本, 广播用的 payload)。

    版本缺口不拒绝，而是让客户端自己决定：返回 `resync_required=True` 的响应，
    由前端全量重拉。直接 409 会把一个「网络抖了一下」放大成「编辑失败」。
    """
    if not peer.can_write:
        raise AppError(ErrorCode.FORBIDDEN, "你在这块画布上是只读权限")
    async with room.lock:
        if not room.can_replay_from(int(base_version)):
            # 基于过旧状态：不能安全合并，要求全量重同步
            raise AppError(ErrorCode.CANVAS_VERSION_CONFLICT)
        room.state = canvas_doc.apply_patch(room.state, patch, room.tombstones)
        canvas_doc.trim_tombstones(room.tombstones)
        room.version += 1
        payload = patch.to_payload()
        room.remember(room.version, payload)
        room.dirty = True
        room.last_activity = time.time()
        version = room.version
    return version, payload


async def apply_full_state(room: Room, peer: Peer, state: Any) -> tuple[int, dict[str, Any]]:
    """整份覆盖（兜底通道：客户端无法增量时）。

    只有属主能整份覆盖——否则一个协作者可以把整个画布换成他的版本，
    把所有人的编辑一次性抹掉。
    """
    if not peer.can_write:
        raise AppError(ErrorCode.FORBIDDEN, "你在这块画布上是只读权限")
    async with room.lock:
        room.state = canvas_doc.normalize_state(state)
        room.version += 1
        room.history.clear()
        room.tombstones.clear()
        room.dirty = True
        room.last_activity = time.time()
        version = room.version
    return version, {"full": True}


async def update_presence(
    room: Room,
    peer: Peer,
    cursor: dict[str, Any] | None,
    selection: list[str] | None,
    viewport: dict[str, Any] | None = None,
) -> None:
    """更新光标 / 选区 / 视口并广播。"""
    if cursor is not None:
        peer.cursor = cursor
    if selection is not None:
        peer.selection = [str(item) for item in selection][:200]
    if viewport is not None:
        # 只收白名单字段并夹取范围：视口是客户端输入，不能原样信任
        try:
            peer.viewport = {
                "zoom": max(0.05, min(8.0, float(viewport.get("zoom", 1)))),
                "scrollX": max(-1e7, min(1e7, float(viewport.get("scrollX", 0)))),
                "scrollY": max(-1e7, min(1e7, float(viewport.get("scrollY", 0)))),
            }
        except (TypeError, ValueError):
            pass
    peer.last_seen = time.time()
    room.last_activity = time.time()
    await broadcast(
        room,
        {"type": "presence", "participants": [item.public() for item in room.peers.values()]},
    )


def snapshot(room: Room) -> dict[str, Any]:
    """加入房间时下发的快照。"""
    return {
        "type": "snapshot",
        "version": room.version,
        "state": room.state,
        "participants": [item.public() for item in room.peers.values()],
    }


def replay(room: Room, since: int, patches: list[tuple[int, dict[str, Any]]]) -> dict[str, Any]:
    """断线重连的补齐消息：只补 `since` 之后的增量，不重发整份场景。"""
    return {
        "type": "replay",
        "from": since,
        "version": room.version,
        "patches": [{"version": version, "patch": payload} for version, payload in patches],
        "participants": [item.public() for item in room.peers.values()],
    }
