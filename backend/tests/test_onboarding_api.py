"""引导与技能包接口测试。

覆盖：场景目录完整性、引导幂等、技能包选择持久化、团队包继承、
以及「提示词注入」这条最容易悄悄坏掉的链路（注错了用户看到的是跑偏的图）。
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.team import TeamInvitation
from app.models.user import User
from app.security import decode_access_token
from app.services import skill_packs
from app.services import team_service
from tests.conftest import register_and_activate

pytestmark = pytest.mark.asyncio


def _headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


async def _create_team(token: str, name: str) -> dict:
    claims = decode_access_token(token)
    async with AsyncSessionLocal() as db:
        owner = await db.get(User, claims["sub"])
        assert owner is not None
        team = await team_service.create_team(db, owner, name)
        await db.commit()
        ctx = await team_service.get_context(db, owner, team.id)
        return await team_service.get_team_detail(db, ctx)


# --------------------------------------------------------------------------- #
# 数据层
# --------------------------------------------------------------------------- #
async def test_all_packs_load_with_items():
    packs = skill_packs.load_packs()
    assert len(packs) >= 15
    for key, pack in packs.items():
        assert pack.items, f"{key} 是空包"
        for item in pack.items:
            assert item.prompt.strip()
            assert item.title.strip()


async def test_every_persona_points_at_real_packs():
    personas = skill_packs.load_personas()
    assert len(personas) >= 6
    packs = skill_packs.load_packs()
    for persona in personas:
        assert persona["packs"], f"{persona['key']} 没有推荐包"
        for key in persona["packs"]:
            assert key in packs, f"{persona['key']} 引用了不存在的包 {key}"
        assert persona["skill_count"] > 0


async def test_fallback_pack_exists():
    assert skill_packs.FALLBACK_PACK in skill_packs.load_packs()


async def test_render_for_prompt_is_bounded():
    pack = skill_packs.get_pack(skill_packs.FALLBACK_PACK)
    assert pack is not None
    text = skill_packs.render_for_prompt(list(pack.items))
    assert text
    # 每条截断到 200 字，整体不能把对话上下文挤掉
    for line in text.splitlines()[1:]:
        body = line.split("参考骨架：", 1)[-1]
        assert len(body) <= skill_packs.MAX_INJECT_CHARS


async def test_match_items_prefers_title_hit():
    pack = skill_packs.get_pack("ecommerce_detail")
    assert pack is not None
    target = pack.items[0]
    matched = skill_packs.match_items(list(pack.items), target.title)
    assert matched[0].id == target.id


async def test_match_items_falls_back_to_head_when_no_signal():
    pack = skill_packs.get_pack(skill_packs.FALLBACK_PACK)
    assert pack is not None
    matched = skill_packs.match_items(list(pack.items), "zzzzz-毫无关系的词-qqqq")
    assert matched == list(pack.items)[: skill_packs.MAX_INJECT_ITEMS]


# --------------------------------------------------------------------------- #
# 引导
# --------------------------------------------------------------------------- #
async def test_personas_endpoint_is_public(client):
    """场景目录对未登录用户开放：注册页要能展示「你是哪类用户」，此时还没 token。"""
    resp = await client.get("/api/onboarding/personas")
    assert resp.status_code == 200
    assert resp.json()["data"]["total"] >= 6


async def test_personas_endpoint_lists_catalog(client):
    token = await register_and_activate(client, "onb-persona@example.com")
    resp = await client.get("/api/onboarding/personas", headers=_headers(token))
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["total"] >= 6
    first = data["items"][0]
    for field in ("key", "name", "tagline", "packs", "skill_count", "pack_names"):
        assert field in first
    # 场景里推荐的包必须真实存在，否则用户点了「启用」什么都不会发生
    assert first["pack_names"]


async def test_state_before_onboarding_is_incomplete(client):
    token = await register_and_activate(client, "onb-state@example.com")
    resp = await client.get("/api/onboarding/state", headers=_headers(token))
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["completed"] is False
    # 新用户也应该有兜底技能，而不是空列表
    assert data["pack_keys"]
    assert data["skill_count"] > 0


async def test_complete_with_persona_is_idempotent(client):
    token = await register_and_activate(client, "onb-complete@example.com")
    headers = _headers(token)

    first = await client.post(
        "/api/onboarding/complete", json={"persona_key": "ecommerce"}, headers=headers
    )
    assert first.status_code == 200, first.text
    data = first.json()["data"]
    assert data["completed"] is True
    assert data["persona_key"] == "ecommerce"
    assert data["pack_keys"]

    second = await client.post(
        "/api/onboarding/complete", json={"persona_key": "ecommerce"}, headers=headers
    )
    assert second.status_code == 200
    assert second.json()["data"]["pack_keys"] == data["pack_keys"]

    state = await client.get("/api/onboarding/state", headers=headers)
    assert state.json()["data"]["completed"] is True


async def test_complete_rejects_unknown_persona(client):
    token = await register_and_activate(client, "onb-badpersona@example.com")
    resp = await client.post(
        "/api/onboarding/complete",
        json={"persona_key": "not-a-persona"},
        headers=_headers(token),
    )
    assert resp.status_code == 422


async def test_complete_rejects_unknown_pack(client):
    token = await register_and_activate(client, "onb-badpack@example.com")
    resp = await client.post(
        "/api/onboarding/complete",
        json={"pack_keys": ["no-such-pack"]},
        headers=_headers(token),
    )
    assert resp.status_code == 422


async def test_onboarding_does_not_create_an_enterprise(client):
    token = await register_and_activate(client, "onb-team@example.com")
    headers = _headers(token)
    resp = await client.post(
        "/api/onboarding/complete", json={"persona_key": "developer"}, headers=headers
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["team"] is None

    teams = await client.get("/api/teams", headers=headers)
    assert teams.json()["data"]["items"] == []


# --------------------------------------------------------------------------- #
# 技能包
# --------------------------------------------------------------------------- #
async def test_list_packs_marks_enabled(client):
    token = await register_and_activate(client, "skill-list@example.com")
    headers = _headers(token)
    await client.post(
        "/api/onboarding/complete", json={"persona_key": "ui_designer"}, headers=headers
    )
    resp = await client.get("/api/skills/packs", headers=headers)
    assert resp.status_code == 200
    items = resp.json()["data"]["items"]
    enabled = [item["key"] for item in items if item["enabled"]]
    assert enabled
    for item in items:
        assert item["count"] > 0


async def test_pack_detail_and_404(client):
    token = await register_and_activate(client, "skill-detail@example.com")
    headers = _headers(token)
    resp = await client.get("/api/skills/packs/ecommerce_detail", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["data"]["items"]

    missing = await client.get("/api/skills/packs/nope", headers=headers)
    assert missing.status_code == 404


async def test_set_my_packs_replaces_previous(client):
    token = await register_and_activate(client, "skill-set@example.com")
    headers = _headers(token)

    first = await client.put(
        "/api/skills/mine", json={"pack_keys": ["brand_vi"]}, headers=headers
    )
    assert first.status_code == 200
    assert first.json()["data"]["pack_keys"] == ["brand_vi"]

    second = await client.put(
        "/api/skills/mine", json={"pack_keys": ["dev_ui", "photo_edit"]}, headers=headers
    )
    assert second.json()["data"]["pack_keys"] == ["dev_ui", "photo_edit"]

    mine = await client.get("/api/skills/mine", headers=headers)
    assert mine.json()["data"]["personal_packs"] == ["dev_ui", "photo_edit"]


async def test_toggle_skill_removes_from_effective_set(client):
    token = await register_and_activate(client, "skill-toggle@example.com")
    headers = _headers(token)
    await client.put("/api/skills/mine", json={"pack_keys": ["dev_ui"]}, headers=headers)

    pack = skill_packs.get_pack("dev_ui")
    assert pack is not None
    target = pack.items[0].id

    before = await client.get("/api/skills/mine", headers=headers)
    assert target in [item["id"] for item in before.json()["data"]["items"]]

    off = await client.post(
        "/api/skills/mine/toggle", json={"skill_id": target, "enabled": False}, headers=headers
    )
    assert off.status_code == 200

    after = await client.get("/api/skills/mine", headers=headers)
    assert target not in [item["id"] for item in after.json()["data"]["items"]]

    # 再打开又回来了
    await client.post(
        "/api/skills/mine/toggle", json={"skill_id": target, "enabled": True}, headers=headers
    )
    again = await client.get("/api/skills/mine", headers=headers)
    assert target in [item["id"] for item in again.json()["data"]["items"]]


async def test_toggle_unknown_skill_rejected(client):
    token = await register_and_activate(client, "skill-toggle-bad@example.com")
    resp = await client.post(
        "/api/skills/mine/toggle",
        json={"skill_id": "does-not-exist", "enabled": False},
        headers=_headers(token),
    )
    assert resp.status_code == 422


async def test_team_packs_union_with_personal(client):
    """团队包与个人包是并集：企业既要团队规范，也要成员自己的偏好。"""
    owner = await register_and_activate(client, "skill-team-owner@example.com")
    member = await register_and_activate(client, "skill-team-member@example.com")
    headers_owner, headers_member = _headers(owner), _headers(member)

    team = await _create_team(owner, "技能团队")

    # 邀请成员
    inv = await client.post(
        f"/api/teams/{team['id']}/invitations",
        json={"email": "skill-team-member@example.com"},
        headers=headers_owner,
    )
    async with AsyncSessionLocal() as db:
        token_value = (
            await db.execute(
                select(TeamInvitation.token).where(TeamInvitation.id == inv.json()["data"]["id"])
            )
        ).scalar_one()
    await client.post(
        f"/api/teams/invitations/{token_value}/accept", headers=headers_member
    )

    # 超管设团队包
    set_team = await client.put(
        f"/api/skills/team/{team['id']}", json={"pack_keys": ["brand_vi"]}, headers=headers_owner
    )
    assert set_team.status_code == 200

    # 成员自己再选一个
    await client.put("/api/skills/mine", json={"pack_keys": ["dev_ui"]}, headers=headers_member)

    mine = await client.get("/api/skills/mine", headers=headers_member)
    data = mine.json()["data"]
    assert "brand_vi" in data["team_packs"]
    assert "dev_ui" in data["personal_packs"]
    keys = {item["pack_key"] for item in data["items"]}
    assert {"brand_vi", "dev_ui"} <= keys


async def test_member_cannot_set_team_packs(client):
    owner = await register_and_activate(client, "skill-perm-owner@example.com")
    member = await register_and_activate(client, "skill-perm-member@example.com")
    team = await _create_team(owner, "权限团队")
    inv = await client.post(
        f"/api/teams/{team['id']}/invitations",
        json={"email": "skill-perm-member@example.com"},
        headers=_headers(owner),
    )
    async with AsyncSessionLocal() as db:
        token_value = (
            await db.execute(
                select(TeamInvitation.token).where(TeamInvitation.id == inv.json()["data"]["id"])
            )
        ).scalar_one()
    await client.post(f"/api/teams/invitations/{token_value}/accept", headers=_headers(member))

    resp = await client.put(
        f"/api/skills/team/{team['id']}", json={"pack_keys": ["dev_ui"]}, headers=_headers(member)
    )
    assert resp.status_code == 403


async def test_search_filters_within_effective_set(client):
    token = await register_and_activate(client, "skill-search@example.com")
    headers = _headers(token)
    await client.put("/api/skills/mine", json={"pack_keys": ["ecommerce_detail"]}, headers=headers)

    pack = skill_packs.get_pack("ecommerce_detail")
    assert pack is not None
    target = pack.items[0]

    resp = await client.get(f"/api/skills/search?q={target.title}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["data"]["items"][0]["id"] == target.id


async def test_search_does_not_leak_other_packs(client):
    """搜索范围必须限制在用户启用的包里，不能把没启用的技能搜出来。"""
    token = await register_and_activate(client, "skill-scope@example.com")
    headers = _headers(token)
    await client.put("/api/skills/mine", json={"pack_keys": ["dev_ui"]}, headers=headers)

    other = skill_packs.get_pack("font_effect")
    assert other is not None
    foreign_id = other.items[0].id

    resp = await client.get("/api/skills/search?q=&limit=60", headers=headers)
    assert resp.status_code == 200, resp.text
    ids = [item["id"] for item in resp.json()["data"]["items"]]
    assert foreign_id not in ids
    assert ids
