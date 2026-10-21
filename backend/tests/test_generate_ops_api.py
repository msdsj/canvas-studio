"""编辑能力 / 意图分析接口层测试（HTTP 契约）。"""
from __future__ import annotations

import io
import json

import pytest
from PIL import Image

from tests.conftest import register_and_activate


def _png_bytes(size: tuple[int, int] = (32, 32), color=(255, 0, 0)) -> bytes:
    """构造一张测试 PNG。"""
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


async def _auth(client, email: str) -> dict[str, str]:
    """注册激活并返回鉴权头。"""
    token = await register_and_activate(client, email)
    return {"Authorization": f"Bearer {token}"}


async def test_capabilities_lists_builtin_handlers(client):
    """能力清单接口返回注册表内容（前端据此渲染，不写死）。"""
    headers = await _auth(client, "cap@example.com")
    resp = await client.get("/api/generate/capabilities", headers=headers)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["code"] == "OK"
    handlers = body["data"]["handlers"]
    ids = {item["id"] for item in handlers}
    assert {"restyle", "cutout", "transparent", "remove", "enhance"} <= ids
    assert "chroma" in body["data"]["cutout_strategies"]
    cutout = next(item for item in handlers if item["id"] == "cutout")
    # 产品口径（2026-10-21）：抠图走本地确定性像素处理，不送上游重绘
    # （上游会按「完整人物」补画框外内容，实测把框到膝盖的人补上了腿和鞋）
    assert cutout["output"] == "sprite"
    assert cutout["engine"] == "local"
    assert cutout["executor"] == "cutout"
    assert cutout["billable"] is False


async def test_edit_accepts_ops_and_plans_outputs(client):
    """结构化 ops 提交后，任务参数中记录操作与产出预估。"""
    headers = await _auth(client, "ops@example.com")
    ops = [
        {"region": {"x": 0.0, "y": 0.0, "w": 0.5, "h": 0.5}, "handler": "restyle", "prompt": "换成蓝色"},
        {"region": {"x": 0.5, "y": 0.5, "w": 0.4, "h": 0.4}, "handler": "cutout", "prompt": ""},
    ]
    resp = await client.post(
        "/api/generate/edit",
        data={"prompt": "按区域处理", "ops": json.dumps(ops)},
        files={"file": ("base.png", _png_bytes(), "image/png")},
        headers={**headers, "Idempotency-Key": "ops-api-1"},
    )
    assert resp.status_code == 200, resp.text
    task = resp.json()["data"]
    assert task["type"] == "edit"
    params = task["params"]
    assert len(params["ops"]) == 2
    assert params["ops"][1]["handler"] == "cutout"
    kinds = [(item["kind"], item["count"]) for item in params["outputs"]]
    assert kinds == [("composite", 1), ("sprite", 1)]


async def test_edit_cutout_is_billed(client):
    """抠图同样调用上游模型，必须计费（不再有「本地免费」路径）。"""
    headers = await _auth(client, "free@example.com")
    ops = [{"region": {"x": 0.0, "y": 0.0, "w": 1.0, "h": 1.0}, "handler": "cutout", "prompt": ""}]
    resp = await client.post(
        "/api/generate/edit",
        data={"prompt": "抠图", "ops": json.dumps(ops)},
        files={"file": ("base.png", _png_bytes(), "image/png")},
        headers={**headers, "Idempotency-Key": "ops-api-cutout-billed"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["data"]["cost"] > 0


async def test_edit_legacy_region_still_accepted(client):
    """旧版纯几何 region 参数保持兼容。"""
    headers = await _auth(client, "legacy@example.com")
    resp = await client.post(
        "/api/generate/edit",
        data={
            "prompt": "改一下",
            "region": json.dumps([{"x": 0.1, "y": 0.1, "w": 0.2, "h": 0.2}]),
        },
        files={"file": ("base.png", _png_bytes(), "image/png")},
        headers={**headers, "Idempotency-Key": "ops-api-legacy"},
    )
    assert resp.status_code == 200, resp.text
    params = resp.json()["data"]["params"]
    assert params["ops"][0]["handler"] == "restyle"


async def test_edit_requires_prompt(client):
    """缺少 prompt 时按契约返回 422。"""
    headers = await _auth(client, "noprompt@example.com")
    resp = await client.post(
        "/api/generate/edit",
        files={"file": ("base.png", _png_bytes(), "image/png")},
        headers={**headers, "Idempotency-Key": "ops-api-noprompt"},
    )
    assert resp.status_code == 422


async def test_plan_endpoint_returns_structured_plan(client, monkeypatch):
    """意图分析接口：自然语言 → 结构化计划 + 产出预估。"""

    async def fake_chat(payload):
        return {
            "choices": [
                {
                    "message": {
                        "content": json.dumps(
                            {
                                "reply": "区域1 换红裙，区域2 抠成素材",
                                "ops": [
                                    {
                                        "region_index": 1,
                                        "handler": "restyle",
                                        "prompt": "换成红色连衣裙",
                                        "intensity": "fine",
                                    },
                                    {"region_index": 2, "handler": "cutout", "prompt": ""},
                                ],
                            },
                            ensure_ascii=False,
                        )
                    }
                }
            ],
            "demo": False,
        }

    monkeypatch.setattr(
        "app.services.gateway_client.gateway_client.llm_completions", fake_chat
    )

    headers = await _auth(client, "plan@example.com")
    resp = await client.post(
        "/api/generate/plan",
        json={
            "message": "把左边的人换成红裙，右边的猫抠出来",
            "regions": [
                {"index": 1, "region": {"x": 0.0, "y": 0.0, "w": 0.3, "h": 0.5}},
                {"index": 2, "region": {"x": 0.6, "y": 0.6, "w": 0.3, "h": 0.3}},
            ],
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert len(data["ops"]) == 2
    assert data["ops"][0]["handler"] == "restyle"
    assert data["ops"][0]["region"]["w"] == pytest.approx(0.3)
    assert data["ops"][1]["handler"] == "cutout"
    assert [(item["kind"], item["count"]) for item in data["outputs"]] == [
        ("composite", 1),
        ("sprite", 1),
    ]


async def test_plan_endpoint_requires_message(client):
    """空需求按契约拒绝。"""
    headers = await _auth(client, "planempty@example.com")
    resp = await client.post("/api/generate/plan", json={"message": ""}, headers=headers)
    assert resp.status_code == 422
