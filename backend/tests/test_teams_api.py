"""团队模式接口测试：建团、席位、邀请、权限矩阵、共享额度、模型统一配置。

这些用例刻意围绕「权限边界」写，而不是「接口能通」——团队功能出问题几乎都是
越权（成员改了管理员才能改的东西）或者配额记错账（花了团队的钱记到个人头上）。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.team import Team
from app.models.user import User
from app.security import decode_access_token
from app.services import config_service, team_service
from app.utils.errors import ErrorCode
from tests.conftest import register_and_activate

pytestmark = pytest.mark.asyncio


async def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_team(client, token: str, name: str = "示例科技") -> dict:
    """Build a team fixture directly; API authorization is covered separately."""
    claims = decode_access_token(token)
    async with AsyncSessionLocal() as db:
        owner = await db.get(User, claims["sub"])
        assert owner is not None
        team = await team_service.create_team(db, owner, name)
        await db.commit()
        ctx = await team_service.get_context(db, owner, team.id)
        return await team_service.get_team_detail(db, ctx)


async def _configure_platform_chat_model() -> None:
    async with AsyncSessionLocal() as db:
        await config_service.set_many(
            db,
            {
                "TEXT_API_BASE_URL": "https://chat.example.com/v1",
                "TEXT_API_KEY": "sk-platform-chat",
                "TEXT_MODEL": "platform-chat-v1",
                "TEXT_MODEL_FALLBACKS": "platform-chat-backup",
            },
            operator_id=None,
        )
        await db.commit()


async def _configure_legacy_team_model(team_id: str, token: str) -> None:
    claims = decode_access_token(token)
    async with AsyncSessionLocal() as db:
        owner = await db.get(User, claims["sub"])
        assert owner is not None
        ctx = await team_service.get_context(db, owner, team_id)
        await team_service.upsert_team_provider(
            db,
            ctx,
            owner,
            {
                "name": "Legacy image relay",
                "kind": "compatible",
                "base_url": "https://image.example.com/v1",
                "api_key": "sk-image",
                "model": "legacy-image-v1",
            },
        )
        await db.commit()


async def _invite_and_join(client, owner_token: str, team_id: str, member_token: str, email: str) -> None:
    """邀请 → 取出 token → 接受。测试里直接读库拿 token（不走邮件）。"""
    resp = await client.post(
        f"/api/teams/{team_id}/invitations",
        json={"email": email, "role": "member"},
        headers=await _headers(owner_token),
    )
    assert resp.status_code == 200, resp.text
    invitation_id = resp.json()["data"]["id"]

    from app.models.team import TeamInvitation

    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(select(TeamInvitation).where(TeamInvitation.id == invitation_id))
        ).scalar_one()
        token = row.token

    accept = await client.post(
        f"/api/teams/invitations/{token}/accept", headers=await _headers(member_token)
    )
    assert accept.status_code == 200, accept.text


# --------------------------------------------------------------------------- #
# 建团与席位
# --------------------------------------------------------------------------- #
async def test_create_team_makes_creator_owner(client):
    token = await register_and_activate(client, "team-owner@example.com")
    team = await _create_team(client, token)
    assert team["role"] == "owner"
    assert team["seat_limit"] >= 1
    assert team["name"] == "示例科技"

    listed = await client.get("/api/teams", headers=await _headers(token))
    assert listed.status_code == 200
    assert len(listed.json()["data"]["items"]) == 1


async def test_only_platform_admin_can_create_team(client):
    user = await register_and_activate(client, "team-create-denied@example.com")
    denied = await client.post(
        "/api/teams", json={"name": "不应创建"}, headers=await _headers(user)
    )
    assert denied.status_code == 403

    login = await client.post(
        "/api/auth/login", json={"email": "admin@canvas.studio", "password": "Admin@12345"}
    )
    assert login.status_code == 200
    admin = login.json()["data"]["access_token"]
    allowed = await client.post(
        "/api/teams", json={"name": "平台创建"}, headers=await _headers(admin)
    )
    assert allowed.status_code == 200, allowed.text
    assert allowed.json()["data"]["role"] == "owner"


async def test_team_name_required(client):
    login = await client.post(
        "/api/auth/login", json={"email": "admin@canvas.studio", "password": "Admin@12345"}
    )
    token = login.json()["data"]["access_token"]
    resp = await client.post("/api/teams", json={"name": "   "}, headers=await _headers(token))
    assert resp.status_code == 422


async def test_seat_limit_blocks_extra_invites(client):
    owner = await register_and_activate(client, "team-seat-owner@example.com")
    team = await _create_team(client, owner, "席位测试")
    headers = await _headers(owner)

    # 把席位压到 1（只有 owner 自己），再邀请就该被挡
    updated = await client.patch(
        f"/api/teams/{team['id']}", json={"seat_limit": 1}, headers=headers
    )
    assert updated.status_code == 200, updated.text

    resp = await client.post(
        f"/api/teams/{team['id']}/invitations",
        json={"email": "nobody@example.com"},
        headers=headers,
    )
    assert resp.status_code == 422
    assert resp.json()["code"] == ErrorCode.SEAT_LIMIT_EXCEEDED.value


async def test_link_invites_are_independent_and_join_after_login(client):
    owner = await register_and_activate(client, "team-link-owner@example.com")
    member = await register_and_activate(client, "team-link-member@example.com")
    team = await _create_team(client, owner, "链接邀请")
    headers = await _headers(owner)

    created = []
    for _ in range(2):
        response = await client.post(
            f"/api/teams/{team['id']}/invitations",
            json={"role": "member"},
            headers=headers,
        )
        assert response.status_code == 200, response.text
        created.append(response.json()["data"])
    assert created[0]["token"] != created[1]["token"]

    pending = await client.get(f"/api/teams/{team['id']}/invitations", headers=headers)
    assert len(pending.json()["data"]) == 2
    assert len({row["id"] for row in pending.json()["data"]}) == 2
    assert {row["token"] for row in pending.json()["data"]} == {row["token"] for row in created}

    preview = await client.get(f"/api/teams/invitations/{created[0]['token']}")
    assert preview.status_code == 200
    assert preview.json()["data"]["email"] is None
    joined = await client.post(
        f"/api/teams/invitations/{created[0]['token']}/accept", headers=await _headers(member)
    )
    assert joined.status_code == 200, joined.text
    teams = await client.get("/api/teams", headers=await _headers(member))
    assert teams.json()["data"]["active_team_id"] == team["id"]


# --------------------------------------------------------------------------- #
# 成员与权限
# --------------------------------------------------------------------------- #
async def test_member_joins_and_cannot_manage(client):
    owner = await register_and_activate(client, "team-a-owner@example.com")
    member = await register_and_activate(client, "team-a-member@example.com")
    team = await _create_team(client, owner, "甲团队")
    await _invite_and_join(client, owner, team["id"], member, "team-a-member@example.com")

    members = await client.get(
        f"/api/teams/{team['id']}/members", headers=await _headers(owner)
    )
    assert members.status_code == 200
    assert len(members.json()["data"]) == 2

    # 普通成员不能邀请别人
    resp = await client.post(
        f"/api/teams/{team['id']}/invitations",
        json={"email": "x@example.com"},
        headers=await _headers(member),
    )
    assert resp.status_code == 403

    # 也不能改团队设置
    resp = await client.patch(
        f"/api/teams/{team['id']}", json={"name": "改名"}, headers=await _headers(member)
    )
    assert resp.status_code == 403


async def test_outsider_sees_team_as_not_found(client):
    owner = await register_and_activate(client, "team-b-owner@example.com")
    outsider = await register_and_activate(client, "team-b-out@example.com")
    team = await _create_team(client, owner, "乙团队")

    resp = await client.get(f"/api/teams/{team['id']}", headers=await _headers(outsider))
    # 非成员必须表现得像「没有这个团队」，否则能用来探测企业是否在用本平台
    assert resp.status_code == 404


async def test_owner_can_promote_and_transfer(client):
    owner = await register_and_activate(client, "team-c-owner@example.com")
    member = await register_and_activate(client, "team-c-member@example.com")
    team = await _create_team(client, owner, "丙团队")
    # 记下原超管的 user_id，转移后要确认 owner 真的换人了
    from app.models.user import User as _User

    async with AsyncSessionLocal() as _db:
        owner_id = (
            await _db.execute(select(_User.id).where(_User.email == "team-c-owner@example.com"))
        ).scalar_one()
    await _invite_and_join(client, owner, team["id"], member, "team-c-member@example.com")

    members = (
        await client.get(f"/api/teams/{team['id']}/members", headers=await _headers(owner))
    ).json()["data"]
    member_row = next(item for item in members if item["role"] == "member")

    promoted = await client.patch(
        f"/api/teams/{team['id']}/members/{member_row['id']}",
        json={"role": "admin"},
        headers=await _headers(owner),
    )
    assert promoted.status_code == 200, promoted.text
    updated = next(
        item for item in promoted.json()["data"] if item["id"] == member_row["id"]
    )
    assert updated["role"] == "admin"

    # 只有 owner 能转移超管
    denied = await client.post(
        f"/api/teams/{team['id']}/members/{member_row['id']}/transfer",
        headers=await _headers(member),
    )
    assert denied.status_code == 403

    transferred = await client.post(
        f"/api/teams/{team['id']}/members/{member_row['id']}/transfer",
        headers=await _headers(owner),
    )
    assert transferred.status_code == 200, transferred.text

    from app.models.user import User

    async with AsyncSessionLocal() as db:
        row = (await db.execute(select(Team).where(Team.id == team["id"]))).scalar_one()
        new_owner = (
            await db.execute(select(User).where(User.email == "team-c-member@example.com"))
        ).scalar_one()
        assert row.owner_user_id == new_owner.id
        assert row.owner_user_id != owner_id


async def test_owner_cannot_be_removed(client):
    owner = await register_and_activate(client, "team-d-owner@example.com")
    team = await _create_team(client, owner, "丁团队")
    members = (
        await client.get(f"/api/teams/{team['id']}/members", headers=await _headers(owner))
    ).json()["data"]
    owner_row = next(item for item in members if item["role"] == "owner")

    resp = await client.delete(
        f"/api/teams/{team['id']}/members/{owner_row['id']}", headers=await _headers(owner)
    )
    assert resp.status_code == 422


# --------------------------------------------------------------------------- #
# 模型统一配置
# --------------------------------------------------------------------------- #
async def test_enterprise_users_cannot_configure_models(client):
    owner = await register_and_activate(client, "team-e-owner@example.com")
    member = await register_and_activate(client, "team-e-member@example.com")
    team = await _create_team(client, owner, "戊团队")
    await _invite_and_join(client, owner, team["id"], member, "team-e-member@example.com")

    payload = {
        "name": "公司中转",
        "kind": "openai",
        "base_url": "https://api.example.com/v1",
        "api_key": "sk-team-secret",
        "model": "gpt-image-2",
    }
    owner_write = await client.put(
        f"/api/teams/{team['id']}/model-config", json=payload, headers=await _headers(owner)
    )
    denied = await client.put(
        f"/api/teams/{team['id']}/model-config", json=payload, headers=await _headers(member)
    )
    assert owner_write.status_code == 403
    assert denied.status_code == 403


async def test_enterprise_accounts_cannot_edit_personal_provider_even_for_legacy_teams(client):
    """旧团队的自带模型开关不能 restore personal model writes."""
    owner = await register_and_activate(client, "team-f-owner@example.com")
    member = await register_and_activate(client, "team-f-member@example.com")
    team = await _create_team(client, owner, "己团队")
    await _invite_and_join(client, owner, team["id"], member, "team-f-member@example.com")
    async with AsyncSessionLocal() as db:
        row = await db.get(Team, team["id"])
        assert row is not None
        row.settings = {**row.settings_dict(), "allow_personal_provider": True}
        await db.commit()

    for user_token in (owner, member):
        resp = await client.post(
            "/api/ai/providers",
            json={
                "name": "个人中转",
                "kind": "compatible",
                "base_url": "https://my.example.com/v1",
                "api_key": "sk-mine",
                "model": "chat-v1",
            },
            headers=await _headers(user_token),
        )
        assert resp.status_code == 403
        assert resp.json()["code"] == ErrorCode.MODEL_CONFIG_FORBIDDEN.value

    status = await client.get("/api/ai/status", headers=await _headers(member))
    assert status.status_code == 200
    data = status.json()["data"]
    assert data["editable"] is False
    assert data["source"] == "none"
    assert data["can_manage"] is False


async def test_enterprise_chat_uses_platform_model_and_keeps_image_model_route(client):
    owner = await register_and_activate(client, "team-g-owner@example.com")
    member = await register_and_activate(client, "team-g-member@example.com")
    team = await _create_team(client, owner, "平台对话模型")
    await _invite_and_join(client, owner, team["id"], member, "team-g-member@example.com")
    await _configure_platform_chat_model()
    await _configure_legacy_team_model(team["id"], owner)

    for user_token in (owner, member):
        status = await client.get("/api/ai/status", headers=await _headers(user_token))
        data = status.json()["data"]
        assert data["configured"] is True
        assert data["source"] == "platform"
        assert data["model"] == "platform-chat-v1"
        assert data["editable"] is False
        assert data["can_manage"] is False

    image_catalog = await client.get("/api/ai/models", headers=await _headers(member))
    data = image_catalog.json()["data"]
    assert data["source"] == "team"
    assert data["editable"] is False
    assert "legacy-image-v1" in data["image"]


# --------------------------------------------------------------------------- #
# 共享额度
# --------------------------------------------------------------------------- #
async def test_shared_quota_opt_in_and_usage(client):
    owner = await register_and_activate(client, "team-h-owner@example.com")
    team = await _create_team(client, owner, "辛团队")
    headers = await _headers(owner)

    usage = await client.get(f"/api/teams/{team['id']}/usage", headers=headers)
    assert usage.status_code == 200
    assert usage.json()["data"]["shared_quota"] is False

    enabled = await client.patch(
        f"/api/teams/{team['id']}", json={"shared_quota": True}, headers=headers
    )
    assert enabled.status_code == 200, enabled.text

    usage = await client.get(f"/api/teams/{team['id']}/usage", headers=headers)
    data = usage.json()["data"]
    assert data["shared_quota"] is True
    assert data["balance"] > 0  # 开启时给了初始额度


async def test_topup_requires_owner(client):
    owner = await register_and_activate(client, "team-i-owner@example.com")
    member = await register_and_activate(client, "team-i-member@example.com")
    team = await _create_team(client, owner, "壬团队")
    await _invite_and_join(client, owner, team["id"], member, "team-i-member@example.com")

    denied = await client.post(
        f"/api/teams/{team['id']}/quota", json={"amount": 100}, headers=await _headers(member)
    )
    assert denied.status_code == 403

    ok = await client.post(
        f"/api/teams/{team['id']}/quota", json={"amount": 100}, headers=await _headers(owner)
    )
    assert ok.status_code == 200, ok.text
    assert ok.json()["data"]["balance"] >= 100


# --------------------------------------------------------------------------- #
# 团队可见资源
# --------------------------------------------------------------------------- #
async def test_team_project_visible_to_members(client):
    owner = await register_and_activate(client, "team-j-owner@example.com")
    member = await register_and_activate(client, "team-j-member@example.com")
    team = await _create_team(client, owner, "癸团队")
    await _invite_and_join(client, owner, team["id"], member, "team-j-member@example.com")

    created = await client.post(
        "/api/projects",
        json={"name": "共享项目", "share_with_team": True},
        headers=await _headers(owner),
    )
    assert created.status_code == 200, created.text
    project_id = created.json()["data"]["id"]

    # 成员能读到
    read = await client.get(f"/api/projects/{project_id}", headers=await _headers(member))
    assert read.status_code == 200, read.text

    # 也能在列表里看到
    listed = await client.get("/api/projects", headers=await _headers(member))
    ids = [item["id"] for item in listed.json()["data"]["items"]]
    assert project_id in ids


async def test_private_project_stays_private_within_team(client):
    owner = await register_and_activate(client, "team-k-owner@example.com")
    member = await register_and_activate(client, "team-k-member@example.com")
    team = await _create_team(client, owner, "子团队")
    await _invite_and_join(client, owner, team["id"], member, "team-k-member@example.com")

    created = await client.post(
        "/api/projects",
        json={"name": "我的草稿", "share_with_team": False},
        headers=await _headers(owner),
    )
    project_id = created.json()["data"]["id"]

    resp = await client.get(f"/api/projects/{project_id}", headers=await _headers(member))
    assert resp.status_code == 403


async def test_team_member_gets_pro_capabilities(client):
    """团队成员自动获得 Pro 能力（画布/对话等），不需要单独购买。"""
    owner = await register_and_activate(client, "team-l-owner@example.com")
    member = await register_and_activate(client, "team-l-member@example.com", role="user")
    team = await _create_team(client, owner, "丑团队")
    await _invite_and_join(client, owner, team["id"], member, "team-l-member@example.com")

    resp = await client.post("/api/chat/sessions", json={}, headers=await _headers(member))
    assert resp.status_code == 200, resp.text


# --------------------------------------------------------------------------- #
# 团队画布协作
# --------------------------------------------------------------------------- #
async def test_team_canvas_collaboration_ticket(client):
    """团队画布：成员能拿到协作票据，非成员拿不到。"""
    owner = await register_and_activate(client, "collab-owner@example.com")
    member = await register_and_activate(client, "collab-member@example.com")
    outsider = await register_and_activate(client, "collab-outsider@example.com")
    team = await _create_team(client, owner, "协作测试")
    await _invite_and_join(client, owner, team["id"], member, "collab-member@example.com")

    # 团队共享项目 → 画布继承 team_id
    resp = await client.post(
        "/api/projects",
        json={"name": "协作项目", "share_with_team": True},
        headers=await _headers(owner),
    )
    assert resp.status_code == 200, resp.text
    project_id = resp.json()["data"]["id"]

    created = await client.post(
        f"/api/projects/{project_id}/canvases",
        json={"name": "协作画布"},
        headers=await _headers(owner),
    )
    assert created.status_code == 200, created.text
    canvas_id = created.json()["data"]["id"]

    own = await client.post(f"/api/collab/{canvas_id}/ticket", headers=await _headers(owner))
    assert own.status_code == 200, own.text
    assert own.json()["data"]["can_write"] is True

    # 成员切到团队空间后也能拿到票据
    await client.post("/api/teams/active", json={"team_id": team["id"]}, headers=await _headers(member))
    peer = await client.post(f"/api/collab/{canvas_id}/ticket", headers=await _headers(member))
    assert peer.status_code == 200, peer.text

    # 团队外的人连票据都换不到
    await client.post("/api/teams/active", json={"team_id": None}, headers=await _headers(outsider))
    denied = await client.post(f"/api/collab/{canvas_id}/ticket", headers=await _headers(outsider))
    assert denied.status_code in (403, 404)


async def test_private_canvas_not_collaborative_for_members(client):
    """团队里的私有画布不因为同属一个团队就对其他成员开放。"""
    owner = await register_and_activate(client, "priv-owner@example.com")
    member = await register_and_activate(client, "priv-member@example.com")
    team = await _create_team(client, owner, "私有测试")
    await _invite_and_join(client, owner, team["id"], member, "priv-member@example.com")

    resp = await client.post(
        "/api/projects",
        json={"name": "私有项目", "share_with_team": False},
        headers=await _headers(owner),
    )
    assert resp.status_code == 200, resp.text
    project_id = resp.json()["data"]["id"]
    created = await client.post(
        f"/api/projects/{project_id}/canvases",
        json={"name": "私有画布"},
        headers=await _headers(owner),
    )
    canvas_id = created.json()["data"]["id"]

    await client.post("/api/teams/active", json={"team_id": team["id"]}, headers=await _headers(member))
    denied = await client.post(f"/api/collab/{canvas_id}/ticket", headers=await _headers(member))
    assert denied.status_code in (403, 404)


async def test_enterprise_roles_see_platform_model_lock(client):
    owner = await register_and_activate(client, "team-nomanage-owner@example.com")
    member = await register_and_activate(client, "team-nomanage-member@example.com")
    team = await _create_team(client, owner, "无管理权团队")
    await _invite_and_join(
        client, owner, team["id"], member, "team-nomanage-member@example.com"
    )
    await client.post("/api/teams/active", json={"team_id": team["id"]}, headers=await _headers(member))

    for token in (owner, member):
        status = await client.get("/api/ai/status", headers=await _headers(token))
        payload = status.json()["data"]
        assert payload["editable"] is False
        assert payload["can_manage"] is False
        assert payload["configured"] is False
        assert "平台" in payload["reason"]

        models = await client.get("/api/ai/models", headers=await _headers(token))
        assert models.json()["data"]["editable"] is False
        assert models.json()["data"]["can_manage"] is False


async def test_personal_space_owner_keeps_personal_config(client):
    """回到个人空间后，个人配置入口必须恢复。

    否则用户会发现「进了团队就再也配不了自己的模型」，而且切换空间也救不回来——
    这类「状态粘住」的 bug 在切换逻辑里很常见，值得一条断言。
    """
    owner = await register_and_activate(client, "team-space-owner@example.com")
    team = await _create_team(client, owner, "空间切换团队")

    await client.post("/api/teams/active", json={"team_id": team["id"]}, headers=await _headers(owner))
    in_team = (await client.get("/api/ai/status", headers=await _headers(owner))).json()["data"]
    assert in_team["editable"] is False

    await client.post("/api/teams/active", json={"team_id": None}, headers=await _headers(owner))
    personal = (await client.get("/api/ai/status", headers=await _headers(owner))).json()["data"]
    assert personal["editable"] is True, "回到个人空间后应能配自己的模型"
    assert personal["can_manage"] is False
