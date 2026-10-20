"""团队模式接口测试：建团、席位、邀请、权限矩阵、共享额度、模型统一配置。

这些用例刻意围绕「权限边界」写，而不是「接口能通」——团队功能出问题几乎都是
越权（成员改了管理员才能改的东西）或者配额记错账（花了团队的钱记到个人头上）。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.ai_provider import AIProvider
from app.models.team import Team
from app.utils.errors import ErrorCode
from tests.conftest import register_and_activate

pytestmark = pytest.mark.asyncio


async def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_team(client, token: str, name: str = "示例科技") -> dict:
    resp = await client.post("/api/teams", json={"name": name}, headers=await _headers(token))
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


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


async def test_team_name_required(client):
    token = await register_and_activate(client, "team-badname@example.com")
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
async def test_owner_configures_model_and_member_cannot(client):
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
    saved = await client.put(
        f"/api/teams/{team['id']}/model-config", json=payload, headers=await _headers(owner)
    )
    assert saved.status_code == 200, saved.text
    # 密钥永不回明文
    assert "sk-team-secret" not in saved.text

    view = await client.get(
        f"/api/teams/{team['id']}/model-config", headers=await _headers(member)
    )
    assert view.status_code == 200
    assert view.json()["data"]["model"] == "gpt-image-2"
    assert view.json()["data"]["editable"] is False

    denied = await client.put(
        f"/api/teams/{team['id']}/model-config", json=payload, headers=await _headers(member)
    )
    assert denied.status_code == 403


async def test_member_cannot_edit_personal_provider_when_team_managed(client):
    """团队接管后，成员的个人配置入口必须被拦掉（否则「全员用统一模型」形同虚设）。"""
    owner = await register_and_activate(client, "team-f-owner@example.com")
    member = await register_and_activate(client, "team-f-member@example.com")
    team = await _create_team(client, owner, "己团队")
    await _invite_and_join(client, owner, team["id"], member, "team-f-member@example.com")
    await client.put(
        f"/api/teams/{team['id']}/model-config",
        json={
            "name": "公司中转",
            "kind": "openai",
            "base_url": "https://api.example.com/v1",
            "api_key": "sk-x",
            "model": "gpt-image-2",
        },
        headers=await _headers(owner),
    )

    resp = await client.post(
        "/api/ai/providers",
        json={
            "name": "我的中转",
            "kind": "openai",
            "base_url": "https://my.example.com/v1",
            "api_key": "sk-mine",
            "model": "gpt-image-2",
        },
        headers=await _headers(member),
    )
    assert resp.status_code == 403
    assert resp.json()["code"] == ErrorCode.MODEL_CONFIG_FORBIDDEN.value

    status = await client.get("/api/ai/status", headers=await _headers(member))
    assert status.status_code == 200
    data = status.json()["data"]
    assert data["editable"] is False
    assert data["source"] == "team"


async def test_team_model_config_is_single_active_row(client):
    owner = await register_and_activate(client, "team-g-owner@example.com")
    team = await _create_team(client, owner, "庚团队")
    headers = await _headers(owner)
    for model in ("model-a", "model-b"):
        resp = await client.put(
            f"/api/teams/{team['id']}/model-config",
            json={
                "name": "公司中转",
                "kind": "openai",
                "base_url": "https://api.example.com/v1",
                "api_key": "sk-1",
                "model": model,
            },
            headers=headers,
        )
        assert resp.status_code == 200, resp.text

    async with AsyncSessionLocal() as db:
        rows = (
            await db.execute(
                select(AIProvider).where(
                    AIProvider.team_id == team["id"], AIProvider.scope == "team"
                )
            )
        ).scalars().all()
        assert len([row for row in rows if row.is_active]) == 1
        assert rows[0].model == "model-b"


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


async def test_models_endpoint_reports_team_management(client):
    """GET /api/ai/models：成员看到团队的模型清单，且标记为不可编辑。"""
    owner = await register_and_activate(client, "team-models-owner@example.com")
    member = await register_and_activate(client, "team-models-member@example.com")
    team = await _create_team(client, owner, "模型清单团队")
    await _invite_and_join(client, owner, team["id"], member, "team-models-member@example.com")

    await client.put(
        f"/api/teams/{team['id']}/model-config",
        json={
            "name": "公司中转",
            "kind": "openai",
            "base_url": "https://api.example.com/v1",
            "api_key": "sk-team",
            "model": "gpt-image-2",
        },
        headers=await _headers(owner),
    )

    await client.post("/api/teams/active", json={"team_id": team["id"]}, headers=await _headers(member))
    resp = await client.get("/api/ai/models", headers=await _headers(member))
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["configured"] is True
    assert data["editable"] is False
    assert data["source"] == "team"
    assert data["team_name"] == "模型清单团队"
    assert "gpt-image-2" in data["image"]


async def test_owner_is_told_where_to_manage_team_model(client):
    """超级管理员在团队空间里也必须知道「去哪儿改模型」。

    团队模式下 `editable=False` 对所有人成立（团队模型只有一个真源，就是
    `/teams/{id}/model-config`），但如果只给这一个字段，前端就只能对 owner
    也说「请联系超级管理员」——而他自己就是那个人，等于把人绕进死胡同。
    `can_manage` 就是用来区分「你没权限」和「你有权限但这里不是入口」。
    """
    owner = await register_and_activate(client, "team-manage-owner@example.com")
    team = await _create_team(client, owner, "管理入口团队")

    await client.post("/api/teams/active", json={"team_id": team["id"]}, headers=await _headers(owner))

    # 还没配模型：owner 仍然要能看出自己是能配的人
    status = await client.get("/api/ai/status", headers=await _headers(owner))
    assert status.status_code == 200, status.text
    payload = status.json()["data"]
    assert payload["editable"] is False, "团队模式下个人配置入口应关闭"
    assert payload["can_manage"] is True, "owner 必须能看出自己可以管理团队模型"

    models = await client.get("/api/ai/models", headers=await _headers(owner))
    assert models.json()["data"]["can_manage"] is True

    # 配好之后仍然 can_manage=True，且读到的就是团队那套
    await client.put(
        f"/api/teams/{team['id']}/model-config",
        json={
            "name": "老板配的",
            "kind": "openai",
            "base_url": "https://api.example.com/v1",
            "api_key": "sk-boss",
            "model": "gpt-image-2",
        },
        headers=await _headers(owner),
    )
    after = await client.get("/api/ai/status", headers=await _headers(owner))
    data = after.json()["data"]
    assert data["source"] == "team"
    assert data["can_manage"] is True
    assert data["editable"] is False


async def test_member_cannot_manage_team_model(client):
    """成员拿到 `can_manage=False`：前端据此显示「联系超级管理员」。"""
    owner = await register_and_activate(client, "team-nomanage-owner@example.com")
    member = await register_and_activate(client, "team-nomanage-member@example.com")
    team = await _create_team(client, owner, "无管理权团队")
    await _invite_and_join(
        client, owner, team["id"], member, "team-nomanage-member@example.com"
    )
    await client.post("/api/teams/active", json={"team_id": team["id"]}, headers=await _headers(member))

    status = await client.get("/api/ai/status", headers=await _headers(member))
    payload = status.json()["data"]
    assert payload["editable"] is False
    assert payload["can_manage"] is False

    models = await client.get("/api/ai/models", headers=await _headers(member))
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
