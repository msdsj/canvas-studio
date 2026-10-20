"""协作通道测试：元素级合并、房间广播、票据与权限。

重点覆盖三件容易出错的事：
1. 墓碑——删掉的元素不能因为一次迟到的 patch 又长回来；
2. 版本缺口——基于过旧状态的 patch 必须被拒（要求重同步），不能硬合；
3. 权限——只读协作者发 patch 必须被挡，且不能把别人画布整份覆盖。
"""
from __future__ import annotations

import json

import pytest

from app.services import canvas_doc, collab_hub
from app.utils.errors import AppError, ErrorCode
from tests.conftest import register_and_activate

pytestmark = pytest.mark.asyncio


class FakeWS:
    """最小 WebSocket 替身：只记录发出去的消息。"""

    def __init__(self) -> None:
        self.sent: list[dict] = []
        self.closed: bool = False

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)

    async def close(self, code: int = 1000, reason: str = "") -> None:
        self.closed = True


def _rect(element_id: str, version: int = 1, **extra) -> dict:
    return {"id": element_id, "type": "rectangle", "version": version, **extra}


# --------------------------------------------------------------------------- #
# 合并算法
# --------------------------------------------------------------------------- #
async def test_patch_add_update_delete_roundtrip():
    state = canvas_doc.empty_state()
    state = canvas_doc.apply_patch(
        state, canvas_doc.parse_patch({"added": [_rect("a")]})
    )
    assert [item["id"] for item in state["elements"]] == ["a"]

    state = canvas_doc.apply_patch(
        state, canvas_doc.parse_patch({"updated": [_rect("a", 2, x=100)]})
    )
    assert state["elements"][0]["x"] == 100

    state = canvas_doc.apply_patch(state, canvas_doc.parse_patch({"deleted": ["a"]}))
    assert state["elements"] == []


async def test_stale_update_does_not_override_newer_version():
    """版本更小的更新被忽略：否则乱序到达的旧包会把元素拽回旧位置。"""
    state = canvas_doc.empty_state()
    state = canvas_doc.apply_patch(state, canvas_doc.parse_patch({"added": [_rect("a", 5, x=200)]}))
    state = canvas_doc.apply_patch(state, canvas_doc.parse_patch({"updated": [_rect("a", 3, x=10)]}))
    assert state["elements"][0]["x"] == 200


async def test_tombstone_blocks_late_resurrection():
    """删掉的元素收到迟到的更新不应复活。"""
    tombstones: set[str] = set()
    state = canvas_doc.empty_state()
    state = canvas_doc.apply_patch(state, canvas_doc.parse_patch({"added": [_rect("a")]}))
    state = canvas_doc.apply_patch(state, canvas_doc.parse_patch({"deleted": ["a"]}), tombstones)
    assert "a" in tombstones

    state = canvas_doc.apply_patch(state, canvas_doc.parse_patch({"updated": [_rect("a", 9)]}), tombstones)
    state = canvas_doc.apply_patch(state, canvas_doc.parse_patch({"added": [_rect("a", 9)]}), tombstones)
    assert state["elements"] == []


async def test_viewport_keys_are_not_merged():
    """视口/选中状态是各端视角，不能被别人的 appState 覆盖。"""
    state = canvas_doc.empty_state()
    state = canvas_doc.apply_patch(
        state,
        canvas_doc.parse_patch(
            {"app_state": {"viewBackgroundColor": "#fff", "scrollX": 999, "zoom": 3}}
        ),
    )
    assert state["appState"]["viewBackgroundColor"] == "#fff"
    assert "scrollX" not in state["appState"]
    assert "zoom" not in state["appState"]


async def test_update_on_missing_element_is_treated_as_add():
    """客户端认为在改、服务端没有：当新增处理，避免这次修改凭空消失。"""
    state = canvas_doc.apply_patch(
        canvas_doc.empty_state(), canvas_doc.parse_patch({"updated": [_rect("ghost", 2)]})
    )
    assert [item["id"] for item in state["elements"]] == ["ghost"]


async def test_parse_patch_rejects_oversized_and_malformed():
    with pytest.raises(AppError) as exc:
        canvas_doc.parse_patch({"added": [_rect(f"e{i}") for i in range(canvas_doc.MAX_PATCH_ELEMENTS + 1)]})
    assert exc.value.code == ErrorCode.VALIDATION_ERROR

    with pytest.raises(AppError):
        canvas_doc.parse_patch("not-a-dict")

    # 缺 id 的元素被静默丢弃，但整体仍可用
    patch = canvas_doc.parse_patch({"added": [{"type": "rect"}, _rect("ok")]})
    assert [item["id"] for item in patch.added] == ["ok"]


async def test_diff_states_produces_incremental_patch():
    before = {"elements": [_rect("a", 1), _rect("b", 1)], "appState": {}, "files": {}}
    after = {"elements": [_rect("a", 2, x=50), _rect("c", 1)], "appState": {}, "files": {}}
    delta = canvas_doc.diff_states(before, after)
    assert [item["id"] for item in delta["updated"]] == ["a"]
    assert [item["id"] for item in delta["added"]] == ["c"]
    assert delta["deleted"] == ["b"]


# --------------------------------------------------------------------------- #
# 房间
# --------------------------------------------------------------------------- #
async def test_room_join_apply_and_broadcast():
    await collab_hub.drop_room("cv-1")
    room = await collab_hub.get_room("cv-1")
    ws_a, ws_b = FakeWS(), FakeWS()
    peer_a = await collab_hub.join(room, user_id="u1", name="甲", websocket=ws_a)
    peer_b = await collab_hub.join(room, user_id="u2", name="乙", websocket=ws_b)

    version, payload = await collab_hub.apply_client_patch(
        room,
        peer_a,
        base_version=0,
        patch=canvas_doc.parse_patch({"added": [_rect("a")]}),
    )
    assert version == 1 and payload["added"][0]["id"] == "a"
    await collab_hub.broadcast(room, {"type": "patch", "version": version}, exclude=peer_a.id)
    assert ws_b.sent[-1]["version"] == 1
    assert ws_a.sent == []

    assert await collab_hub.leave(room, peer_b.id) is False
    assert await collab_hub.leave(room, peer_a.id) is True
    await collab_hub.drop_room("cv-1")


async def test_room_rejects_stale_base_version():
    """落后超过缓冲深度 → 409，要求全量重同步。"""
    await collab_hub.drop_room("cv-2")
    room = await collab_hub.get_room("cv-2")
    peer = await collab_hub.join(room, user_id="u1", name="甲", websocket=FakeWS())
    for _ in range(3):
        await collab_hub.apply_client_patch(
            room, peer, base_version=room.version, patch=canvas_doc.parse_patch({"added": [_rect("a")]})
        )
    # 人为把缓冲清空，模拟「服务端重启过 / 缓冲被淘汰」
    room.history.clear()
    with pytest.raises(AppError) as exc:
        await collab_hub.apply_client_patch(
            room, peer, base_version=0, patch=canvas_doc.parse_patch({"added": [_rect("b")]})
        )
    assert exc.value.code == ErrorCode.CANVAS_VERSION_CONFLICT
    await collab_hub.drop_room("cv-2")


async def test_readonly_peer_cannot_write():
    await collab_hub.drop_room("cv-3")
    room = await collab_hub.get_room("cv-3")
    peer = await collab_hub.join(
        room, user_id="u1", name="访客", websocket=FakeWS(), can_write=False
    )
    with pytest.raises(AppError) as exc:
        await collab_hub.apply_client_patch(
            room, peer, base_version=0, patch=canvas_doc.parse_patch({"added": [_rect("a")]})
        )
    assert exc.value.code == ErrorCode.FORBIDDEN
    await collab_hub.drop_room("cv-3")


async def test_peer_color_is_stable_per_user():
    assert collab_hub.peer_color("user-1") == collab_hub.peer_color("user-1")
    assert collab_hub.peer_color("user-1") in collab_hub.PEER_COLORS


# --------------------------------------------------------------------------- #
# 接口
# --------------------------------------------------------------------------- #
async def _make_canvas(client, token: str) -> str:
    headers = {"Authorization": f"Bearer {token}"}
    project = await client.post("/api/projects", json={"name": "协作项目"}, headers=headers)
    assert project.status_code == 200, project.text
    canvas = await client.post(
        f"/api/projects/{project.json()['data']['id']}/canvases",
        json={"name": "协作画布"},
        headers=headers,
    )
    assert canvas.status_code == 200, canvas.text
    return canvas.json()["data"]["id"]


async def test_ticket_requires_auth_and_permission(client):
    token = await register_and_activate(client, "collab-owner@example.com")
    canvas_id = await _make_canvas(client, token)

    anonymous = await client.post(f"/api/collab/{canvas_id}/ticket")
    assert anonymous.status_code == 401

    other = await register_and_activate(client, "collab-other@example.com")
    forbidden = await client.post(
        f"/api/collab/{canvas_id}/ticket",
        headers={"Authorization": f"Bearer {other}"},
    )
    assert forbidden.status_code == 403

    ok = await client.post(
        f"/api/collab/{canvas_id}/ticket",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert ok.status_code == 200, ok.text
    data = ok.json()["data"]
    assert data["canvas_id"] == canvas_id
    assert data["can_write"] is True
    assert data["ticket"]

    from app.security import decode_collab_ticket

    payload = decode_collab_ticket(data["ticket"])
    assert payload["canvas_id"] == canvas_id


async def test_ticket_is_bound_to_one_canvas(client):
    token = await register_and_activate(client, "collab-bound@example.com")
    canvas_a = await _make_canvas(client, token)
    canvas_b = await _make_canvas(client, token)
    headers = {"Authorization": f"Bearer {token}"}
    ticket = (
        await client.post(f"/api/collab/{canvas_a}/ticket", headers=headers)
    ).json()["data"]["ticket"]

    from app.routers import collab as collab_router
    from app.security import decode_collab_ticket

    # 票据本身能解出来，但绑定的是 A 画布；换 B 画布必须被拒
    assert decode_collab_ticket(ticket)["canvas_id"] == canvas_a
    with pytest.raises(AppError):
        await collab_router._authenticate(ticket, canvas_b)


async def test_participants_empty_when_nobody_online(client):
    token = await register_and_activate(client, "collab-idle@example.com")
    canvas_id = await _make_canvas(client, token)
    resp = await client.get(
        f"/api/collab/{canvas_id}/participants",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["count"] == 0


async def test_handle_message_ping_and_bad_json():
    """协议层：非法 JSON 只回错误，不断连接。"""
    from app.routers.collab import _handle_message

    await collab_hub.drop_room("cv-msg")
    room = await collab_hub.get_room("cv-msg")
    ws = FakeWS()
    peer = await collab_hub.join(room, user_id="u1", name="甲", websocket=ws)

    await _handle_message(room, peer, "not json")
    assert ws.sent[-1]["type"] == "error"

    await _handle_message(room, peer, json.dumps({"type": "ping"}))
    assert ws.sent[-1] == {"type": "pong"}

    await _handle_message(room, peer, json.dumps({"type": "unknown"}))
    assert ws.sent[-1]["code"] == "UNKNOWN_TYPE"
    await collab_hub.drop_room("cv-msg")


async def test_handle_message_patch_applies_and_broadcasts():
    from app.routers.collab import _handle_message

    await collab_hub.drop_room("cv-patch")
    room = await collab_hub.get_room("cv-patch")
    ws_a, ws_b = FakeWS(), FakeWS()
    peer_a = await collab_hub.join(room, user_id="u1", name="甲", websocket=ws_a)
    await collab_hub.join(room, user_id="u2", name="乙", websocket=ws_b)

    await _handle_message(
        room,
        peer_a,
        json.dumps(
            {
                "type": "patch",
                "base_version": 0,
                "patch": {"added": [_rect("a")]},
            }
        ),
    )
    assert ws_b.sent[-1]["type"] == "patch"
    assert ws_b.sent[-1]["patch"]["added"][0]["id"] == "a"
    assert room.version == 1
    await collab_hub.drop_room("cv-patch")


# --------------------------------------------------------------------------- #
# 落库：协作改动必须真的存下来
# --------------------------------------------------------------------------- #
async def test_collab_patch_is_persisted_to_database(client):
    """协作 patch 走完 flush_and_close 后必须能在画布里读到。

    这是最容易「看起来能跑但数据全丢」的一段：房间在内存里合并得很欢，
    一旦防抖任务没触发、或者离开时忘了强制写，用户刷新就发现同事的改动没了。
    """
    from app.database import AsyncSessionLocal
    from app.models.user import User
    from app.services import collab_hub, collab_service
    from app.models.canvas import Canvas
    from sqlalchemy import select

    token = await register_and_activate(client, "collab-persist@example.com")
    canvas_id = await _make_canvas(client, token)

    async with AsyncSessionLocal() as db:
        user = (
            await db.execute(select(User).where(User.email == "collab-persist@example.com"))
        ).scalar_one()

        room = await collab_service.open_room(db, canvas_id, user)
        peer = await collab_hub.join(room, user_id=user.id, name="我", websocket=FakeWS())

        element = {
            "id": "el-persist-1",
            "type": "rectangle",
            "x": 10,
            "y": 20,
            "width": 100,
            "height": 60,
            "version": 1,
            "versionNonce": 12345,
        }
        version, _ = await collab_service.apply_patch_and_schedule(
            room,
            peer,
            base_version=room.version,
            patch=canvas_doc.Patch(added=[element], updated=[], deleted=[]),
        )
        assert version == room.version

        # 不等待防抖，直接走「最后一人离开」的收尾路径
        await collab_service.flush_and_close(room)

    async with AsyncSessionLocal() as db:
        canvas = (await db.execute(select(Canvas).where(Canvas.id == canvas_id))).scalar_one()
        ids = [item.get("id") for item in (canvas.state or {}).get("elements", [])]
        assert "el-persist-1" in ids, canvas.state
        assert canvas.version == version


async def test_collab_room_is_dropped_after_last_peer_leaves(client):
    """最后一人离开后房间必须释放，否则内存会随画布数无限增长。"""
    from app.database import AsyncSessionLocal
    from app.models.user import User
    from app.services import collab_hub, collab_service
    from sqlalchemy import select

    token = await register_and_activate(client, "collab-drop@example.com")
    canvas_id = await _make_canvas(client, token)

    async with AsyncSessionLocal() as db:
        user = (
            await db.execute(select(User).where(User.email == "collab-drop@example.com"))
        ).scalar_one()
        room = await collab_service.open_room(db, canvas_id, user)
        await collab_hub.join(room, user_id=user.id, name="我", websocket=FakeWS())
        assert collab_hub.peek_room(canvas_id) is not None
        await collab_service.flush_and_close(room)

    assert collab_hub.peek_room(canvas_id) is None


# --------------------------------------------------------------------------- #
# 断线重连：补增量而不是重传整份场景
# --------------------------------------------------------------------------- #
async def test_replay_returns_only_missing_patches():
    """`since` 只落后几版时，补齐的是那几版增量，而不是整份 state。"""
    await collab_hub.drop_room("cv-replay")
    room = await collab_hub.get_room("cv-replay")
    room.version = 5
    room.history = [
        (4, {"added": [_rect("d")], "updated": [], "deleted": []}),
        (5, {"added": [_rect("e")], "updated": [], "deleted": []}),
    ]

    patches = room.replay_after(3)
    assert patches is not None
    assert [version for version, _ in patches] == [4, 5]
    # 已经是最新：补一条也不用发
    assert room.replay_after(5) == []
    # 客户端比房间还新：房间被重建过，必须全量
    assert room.replay_after(9) is None
    await collab_hub.drop_room("cv-replay")


async def test_replay_gives_up_when_history_too_old():
    """落后超过缓冲深度 → 返回 None，让调用方下发快照。"""
    await collab_hub.drop_room("cv-replay-old")
    room = await collab_hub.get_room("cv-replay-old")
    room.version = 30
    # 缓冲里只剩 28 之后的了
    room.history = [(version, {"added": [], "updated": [], "deleted": []}) for version in (28, 29, 30)]
    assert room.replay_after(3) is None
    assert room.replay_after(27) is not None
    assert [version for version, _ in room.replay_after(27)] == [28, 29, 30]
    await collab_hub.drop_room("cv-replay-old")


async def test_authenticate_resolves_active_user(client):
    """票据换用户的正向路径（真实 WS 握手就走这里）。

    这条曾经是空白：只有「票据画布不匹配」的负向用例，成功路径没人走到，
    结果 `_authenticate` 里读了 User 上不存在的 `deleted_at`，
    线上每次 WS 握手都 500 —— 协作功能整个不可用，测试却全绿。
    """
    from app.routers import collab as collab_router

    token = await register_and_activate(client, "collab-auth-ok@example.com")
    canvas_id = await _make_canvas(client, token)
    ticket = (
        await client.post(
            f"/api/collab/{canvas_id}/ticket",
            headers={"Authorization": f"Bearer {token}"},
        )
    ).json()["data"]["ticket"]

    user = await collab_router._authenticate(ticket, canvas_id)
    assert user.email == "collab-auth-ok@example.com"


async def test_authenticate_rejects_banned_user(client):
    """被禁用（banned）的账号不能拿旧票据连协作通道继续写画布。"""
    from sqlalchemy import select

    from app.database import AsyncSessionLocal
    from app.models.user import User
    from app.routers import collab as collab_router

    token = await register_and_activate(client, "collab-banned@example.com")
    canvas_id = await _make_canvas(client, token)
    ticket = (
        await client.post(
            f"/api/collab/{canvas_id}/ticket",
            headers={"Authorization": f"Bearer {token}"},
        )
    ).json()["data"]["ticket"]

    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(select(User).where(User.email == "collab-banned@example.com"))
        ).scalar_one()
        row.status = "banned"
        await db.commit()

    with pytest.raises(AppError):
        await collab_router._authenticate(ticket, canvas_id)


async def test_canvas_payload_exposes_team_owner(client):
    """画布返回值必须带 `team_id`。

    前端靠它判断「这块画布要不要开实时协作」。字段缺失时协作通道永远
    不会启动（`enabled` 恒为 false），而 HTTP 层测试一切正常——
    这类「前后端契约少一个字段」的坑只能靠断言响应体发现。
    """
    token = await register_and_activate(client, "collab-team-field@example.com")
    headers = {"Authorization": f"Bearer {token}"}

    team = await client.post("/api/teams", json={"name": "字段团队"}, headers=headers)
    assert team.status_code == 200, team.text
    team_id = team.json()["data"]["id"]

    project = await client.post(
        "/api/projects", json={"name": "共享项目", "share_with_team": True}, headers=headers
    )
    assert project.status_code == 200, project.text
    canvas = await client.post(
        f"/api/projects/{project.json()['data']['id']}/canvases",
        json={"name": "共享画布"},
        headers=headers,
    )
    assert canvas.status_code == 200, canvas.text
    body = canvas.json()["data"]
    assert body["team_id"] == team_id, body
    assert body["visibility"] == "team", body
    assert "version" in body, body

    # 详情接口同样要带（画布页走的是 GET 而不是创建时的响应）
    detail = await client.get(f"/api/canvases/{body['id']}", headers=headers)
    assert detail.status_code == 200
    assert detail.json()["data"]["team_id"] == team_id
