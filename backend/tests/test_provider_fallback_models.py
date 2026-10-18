"""B2 备用模型配置：读写 / 归一 / 校验 / `chain_preview` 预览。

覆盖需求
--------
- **R02（配置侧）**：`ai_providers.fallback_models` 为可增删的有序列表（0–3 个），
  服务端做 strip / 去空 / 去重 / 去掉等于主模型 / 截断到 3；
- **R21 的数据源**：`GET /api/ai/status` 给出 `fallback_models`（用户配置）与
  `chain_preview`（**实际会遍历的链**，含跨 provider 互备的第 4 个）。

口径提醒（C5）：**存 3、试 2**——配置允许 3 个，运行时只遍历前 2 个，
第 3 个是「主模型被删后自动顶上」的储备。
"""
from __future__ import annotations

import asyncio

import pytest
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.ai_provider import AIProvider
from app.services import relay_chain

ADMIN_EMAIL = "admin@canvas.studio"
ADMIN_PASSWORD = "Admin@12345"


async def _headers(client) -> dict[str, str]:
    resp = await client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}


async def _create(client, headers, **overrides) -> dict:
    payload = {
        "name": "主站",
        "kind": "deepseek",
        "base_url": "http://127.0.0.1:9/v1",
        "api_key": "sk-main",
        "model": "deepseek-chat",
    }
    payload.update(overrides)
    resp = await client.post("/api/ai/providers", json=payload, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


# --------------------------------------------------------------------------- #
# 纯函数：归一规则（写入侧与读取侧共用同一个函数）
# --------------------------------------------------------------------------- #
def test_normalize_strips_drops_and_truncates():
    """strip → 去空 → 去重（保序）→ 去掉等于主模型 → 截断到 3。"""
    assert relay_chain.normalize_fallback_models(
        ["  gpt-4.1-mini  ", "", "gpt-4.1-mini", "deepseek-chat", "qwen-max", "extra"],
        "deepseek-chat",
    ) == ["gpt-4.1-mini", "qwen-max", "extra"]


def test_normalize_tolerates_dirty_input():
    """旧库补列后可能是字符串 '[]' / None / 逗号串：一律不能炸。"""
    assert relay_chain.normalize_fallback_models(None, "m") == []
    assert relay_chain.normalize_fallback_models("[]", "m") == []
    assert relay_chain.normalize_fallback_models('["a", "b"]', "m") == ["a", "b"]
    assert relay_chain.normalize_fallback_models("a", "m") == ["a"]
    assert relay_chain.normalize_fallback_models(123, "m") == []


# --------------------------------------------------------------------------- #
# 读写
# --------------------------------------------------------------------------- #
async def test_fallback_models_roundtrip(client):
    """新增时带上备用模型 → 读回来还是有序的那几个。"""
    headers = await _headers(client)
    created = await _create(
        client, headers, fallback_models=["gpt-4.1-mini", "claude-sonnet-4-5"]
    )
    assert created["fallback_models"] == ["gpt-4.1-mini", "claude-sonnet-4-5"]

    listed = (await client.get("/api/ai/providers", headers=headers)).json()["data"]
    assert listed[0]["fallback_models"] == ["gpt-4.1-mini", "claude-sonnet-4-5"]


async def test_fallback_models_are_normalized_on_write(client):
    """填 4 个只留前 3 个；重复项与「等于主模型」的项被静默丢弃（不报错）。"""
    headers = await _headers(client)
    created = await _create(
        client,
        headers,
        model="deepseek-chat",
        fallback_models=[
            "gpt-4.1-mini",
            "gpt-4.1-mini",
            "deepseek-chat",
            "  ",
            "claude-sonnet-4-5",
            "qwen-max",
            "extra",
        ],
    )
    assert created["fallback_models"] == ["gpt-4.1-mini", "claude-sonnet-4-5", "qwen-max"]


async def test_fallback_models_reject_non_string(client):
    """类型不对要 422（VALIDATION_ERROR），不能被静默转成字符串。"""
    headers = await _headers(client)
    resp = await client.post(
        "/api/ai/providers",
        json={
            "name": "x",
            "kind": "compatible",
            "base_url": "http://127.0.0.1:9/v1",
            "model": "m",
            "fallback_models": ["a", 1],
        },
        headers=headers,
    )
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "VALIDATION_ERROR"


async def test_patch_without_field_keeps_existing(client):
    """PATCH 不带 `fallback_models` = 不改这一项（与「传空数组 = 清空」区分）。"""
    headers = await _headers(client)
    created = await _create(client, headers, fallback_models=["fb1", "fb2"])

    patched = await client.patch(
        f"/api/ai/providers/{created['id']}",
        json={
            "name": "改个名",
            "kind": "deepseek",
            "base_url": "http://127.0.0.1:9/v1",
            "model": "deepseek-chat",
        },
        headers=headers,
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["data"]["fallback_models"] == ["fb1", "fb2"]


async def test_patch_empty_list_clears(client):
    """传空数组 = 清空（回到一期行为：不启用 fallback）。"""
    headers = await _headers(client)
    created = await _create(client, headers, fallback_models=["fb1"])
    patched = await client.patch(
        f"/api/ai/providers/{created['id']}",
        json={
            "name": "主站",
            "kind": "deepseek",
            "base_url": "http://127.0.0.1:9/v1",
            "model": "deepseek-chat",
            "fallback_models": [],
        },
        headers=headers,
    )
    assert patched.json()["data"]["fallback_models"] == []


async def test_changing_primary_model_drops_self_reference(client):
    """主模型被改成与某个备用模型同名时，该项要被移除（否则会自己重试自己）。"""
    headers = await _headers(client)
    created = await _create(client, headers, fallback_models=["fb1", "fb2"])
    patched = await client.patch(
        f"/api/ai/providers/{created['id']}",
        json={
            "name": "主站",
            "kind": "deepseek",
            "base_url": "http://127.0.0.1:9/v1",
            "model": "fb1",
        },
        headers=headers,
    )
    assert patched.json()["data"]["fallback_models"] == ["fb2"]


async def test_stored_value_is_json_list(client):
    """落库形态必须是 JSON 数组（迁移用 `DEFAULT '[]'`，读取处 json.loads 得到 list）。"""
    headers = await _headers(client)
    created = await _create(client, headers, fallback_models=["fb1", "fb2"])
    async with AsyncSessionLocal() as db:
        stored = (
            await db.execute(
                select(AIProvider.fallback_models).where(AIProvider.id == created["id"])
            )
        ).scalar_one()
    assert stored == ["fb1", "fb2"]


# --------------------------------------------------------------------------- #
# /api/ai/status 的链预览
# --------------------------------------------------------------------------- #
async def test_status_chain_preview_and_backup_provider(client):
    """`chain_preview` 是**实际会遍历的链**：主模型 + 试 2 个备用 + 跨 provider 1 个。"""
    headers = await _headers(client)
    backup = await _create(client, headers, name="备用网关", model="qwen-max")
    await asyncio.sleep(0.02)  # 保证 updated_at 有先后
    primary = await _create(
        client,
        headers,
        name="主站",
        model="deepseek-chat",
        fallback_models=["fb-a", "fb-b", "fb-c"],
        is_active=True,
    )

    data = (await client.get("/api/ai/status", headers=headers)).json()["data"]
    assert data["configured"] is True
    assert data["model"] == "deepseek-chat"
    # 用户配置的原始值（存 3）
    assert data["fallback_models"] == ["fb-a", "fb-b", "fb-c"]
    # 实际遍历的链（试 2 + 跨 provider 1）
    assert data["chain_preview"] == ["deepseek-chat", "fb-a", "fb-b", "qwen-max"]
    assert data["backup_provider"] == {
        "id": backup["id"],
        "name": "备用网关",
        "model": "qwen-max",
    }
    assert primary["is_active"] is True


async def test_chain_preview_is_capped_at_four(client):
    """跨 provider 候选可能让链变成 5 个 → 必须截断到 4（MAX_MODELS）。"""
    headers = await _headers(client)
    await _create(client, headers, name="备用网关", model="qwen-max")
    await asyncio.sleep(0.02)
    await _create(
        client,
        headers,
        name="主站",
        model="deepseek-chat",
        fallback_models=["fb-a", "fb-b", "fb-c"],
        is_active=True,
    )
    data = (await client.get("/api/ai/status", headers=headers)).json()["data"]
    assert len(data["chain_preview"]) == 4


async def test_status_without_config_has_empty_chain(client):
    """未配置时不能伪造链：`chain_preview` 为空，前端据此走配置引导。"""
    headers = await _headers(client)
    data = (await client.get("/api/ai/status", headers=headers)).json()["data"]
    assert data["configured"] is False
    assert data["fallback_models"] == []
    assert data["chain_preview"] == []
    assert data["backup_provider"] is None


async def test_chain_does_not_include_duplicate_models(client):
    """两个 provider 配了同名模型时只试一次（ADR-3：同名不同 Key 差异极小，不值得多花 90s）。"""
    headers = await _headers(client)
    await _create(client, headers, name="备用网关", model="deepseek-chat")
    await asyncio.sleep(0.02)
    await _create(
        client,
        headers,
        name="主站",
        model="deepseek-chat",
        fallback_models=[],
        is_active=True,
    )
    data = (await client.get("/api/ai/status", headers=headers)).json()["data"]
    assert data["chain_preview"] == ["deepseek-chat"]


@pytest.mark.parametrize("count", [0, 1, 2, 3])
async def test_fallback_models_length_is_accepted(client, count: int):
    """0–3 个都合法（0 = 不启用 fallback，保持一期行为）。"""
    headers = await _headers(client)
    models = [f"fb{i}" for i in range(1, count + 1)]
    created = await _create(client, headers, fallback_models=models)
    assert created["fallback_models"] == models
