"""纯生图改造的接口契约测试：中转站配置 / 技能库 / 润色 / 全链路降级。

覆盖的产品约束：
- 未配置中转站时 **不生成图片**、也不伪造 AI 结论（compose 返回 unconfigured）；
- API Key 只回掩码，前端回填掩码保存不会覆盖真实 Key；
- 技能库是真实资产（≥40 条、10 类），能按分类/关键词检索；
- 润色在未配置中转站时走本地规则，并如实标记 `engine=local`。
"""
from __future__ import annotations

import json

from sqlalchemy import func, select

from app.database import AsyncSessionLocal
from app.models.ai_provider import AIProvider
from app.models.generation import GenerationTask
from app.services.compose_service import _dedupe_key, shortlist_skills
from app.services.relay_service import (
    _extract_text,
    _finish_reason,
    build_target_from_draft,
    guard_url,
)
from app.services.relay_service import test_target as relay_test_target
from app.utils.errors import AppError

import pytest

ADMIN_EMAIL = "admin@canvas.studio"
ADMIN_PASSWORD = "Admin@12345"


async def _headers(client) -> dict[str, str]:
    resp = await client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}


async def _new_session(client, headers) -> str:
    resp = await client.post("/api/chat/sessions", json={"new_canvas": True}, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]["id"]


# ---------------------------------------------------------------------------
# 中转站配置
# ---------------------------------------------------------------------------
async def test_relay_status_unconfigured_by_default(client):
    """默认没有任何配置：status 必须明确说「没配」，而不是假装可用。"""
    headers = await _headers(client)
    resp = await client.get("/api/ai/status", headers=headers)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["configured"] is False
    assert data["source"] == "none"
    assert data["skills_count"] >= 40


async def test_provider_crud_and_key_mask(client):
    """新增 → 自动激活 → Key 掩码 → 掩码回写不覆盖真实 Key → 删除。"""
    headers = await _headers(client)

    created = await client.post(
        "/api/ai/providers",
        json={
            "name": "我的 DeepSeek",
            "kind": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": "sk-real-abcdef123456",
            "model": "deepseek-chat",
        },
        headers=headers,
    )
    assert created.status_code == 200, created.text
    row = created.json()["data"]
    assert row["is_active"] is True, "第一条配置应自动激活，否则用户填完仍是「未配置」"
    assert row["key_hint"] != "sk-real-abcdef123456"
    assert row["key_hint"].startswith("sk-r")
    assert row["has_key"] is True

    # 前端会把掩码回填到表单，保存时必须跳过
    patched = await client.patch(
        f"/api/ai/providers/{row['id']}",
        json={
            "name": "改个名",
            "kind": "deepseek",
            "base_url": "https://api.deepseek.com/v1",
            "api_key": row["key_hint"],
            "model": "deepseek-chat",
        },
        headers=headers,
    )
    assert patched.status_code == 200
    async with AsyncSessionLocal() as db:
        stored = (
            await db.execute(select(AIProvider.api_key).where(AIProvider.id == row["id"]))
        ).scalar_one()
    assert stored == "sk-real-abcdef123456", "掩码不能覆盖真实 Key"

    status = await client.get("/api/ai/status", headers=headers)
    assert status.json()["data"]["configured"] is True
    assert status.json()["data"]["source"] == "user"

    deleted = await client.delete(f"/api/ai/providers/{row['id']}", headers=headers)
    assert deleted.status_code == 200
    listed = await client.get("/api/ai/providers", headers=headers)
    assert listed.json()["data"] == []


async def test_provider_activation_is_exclusive(client):
    """同一时刻只能有一个激活项。"""
    headers = await _headers(client)
    ids = []
    for name in ("A", "B"):
        resp = await client.post(
            "/api/ai/providers",
            json={"name": name, "kind": "compatible", "base_url": "", "api_key": "", "model": ""},
            headers=headers,
        )
        ids.append(resp.json()["data"]["id"])
    await client.post(f"/api/ai/providers/{ids[1]}/activate", headers=headers)
    listed = (await client.get("/api/ai/providers", headers=headers)).json()["data"]
    assert [item["is_active"] for item in listed] == [False, True]


# ---------------------------------------------------------------------------
# 技能库
# ---------------------------------------------------------------------------
async def test_skill_library_catalog(client):
    """技能库要够用：≥40 条、≥8 类，且能按分类与关键词过滤。"""
    headers = await _headers(client)
    resp = await client.get("/api/ai/skills", headers=headers)
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["total"] >= 40
    assert len(data["categories"]) >= 8
    assert all(item["count"] >= 1 for item in data["categories"])

    posters = await client.get("/api/ai/skills?category=poster", headers=headers)
    items = posters.json()["data"]["items"]
    assert items and all(item["category"] == "poster" for item in items)
    assert all(item["prompt_scaffold"] for item in items), "技能必须带可执行的骨架"

    searched = await client.get("/api/ai/skills?q=海报", headers=headers)
    assert len(searched.json()["data"]["items"]) >= 1


async def test_skill_library_uses_admin_catalog_immediately(client):
    headers = await _headers(client)
    skills = [
        {
            "id": "custom.wallpaper",
            "name": "自定义壁纸",
            "category": "custom",
            "description": "管理员配置的技能",
            "prompt_scaffold": "保持用户指定的画幅与主体",
            "style_tags": ["自定义"],
        }
    ]
    saved = await client.put(
        "/api/admin/config",
        json={"DESIGN_SKILLS_JSON": json.dumps(skills, ensure_ascii=False)},
        headers=headers,
    )
    assert saved.status_code == 200, saved.text

    response = await client.get("/api/ai/skills", headers=headers)
    data = response.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["id"] == "custom.wallpaper"
    assert data["categories"] == [
        {"id": "custom", "name": "custom", "description": "", "count": 1}
    ]


def test_shortlist_picks_poster_skill():
    """确定性初筛：说「咖啡店开业海报」时不该给到 3D 材质技能。"""
    hits = shortlist_skills("帮我做一张咖啡店开业海报")
    assert hits, "应当命中技能"
    assert hits[0].category == "poster"


# ---------------------------------------------------------------------------
# 幂等键与地址校验（纯函数，防回归）
# ---------------------------------------------------------------------------
def test_dedupe_key_stable_within_minute():
    """双击 / 重试同一句需求必须落到同一个幂等键，否则会重复建任务。"""
    first = _dedupe_key("s1", "咖啡店海报", ["a"])
    second = _dedupe_key("s1", "咖啡店海报", ["a"])
    assert first == second
    assert first != _dedupe_key("s1", "咖啡店海报", ["b"])
    assert first != _dedupe_key("s1", "咖啡店海报 2", ["a"])


async def test_guard_url_blocks_metadata_and_self_ports():
    """SSRF：云元数据与平台自身端口必须拒绝；本地中转站必须放行。"""
    for blocked in (
        "http://169.254.169.254/latest/meta-data",
        "http://127.0.0.1:27181/api",
        "http://localhost:27182/gw/config",
        "file:///etc/passwd",
    ):
        with pytest.raises(AppError):
            await guard_url(blocked)

    # 自托管用户接本地中转站是合法用法
    await guard_url("http://127.0.0.1:8000/v1")


# ---------------------------------------------------------------------------
# 思考型模型（deepseek-v4.x）：正文为空 ≠ 配置错误
# ---------------------------------------------------------------------------
def test_extract_text_never_exposes_private_reasoning_content():
    """私有推理不能作为公开回复的兜底正文。"""
    payload = {
        "choices": [
            {
                "message": {"role": "assistant", "content": "", "reasoning_content": "先想一下"},
                "finish_reason": "length",
            }
        ]
    }
    target = build_target_from_draft(base_url="http://127.0.0.1:9/v1", api_key="k", model="m")
    assert _extract_text(target, payload) == ""
    assert _finish_reason(payload) == "length"


async def test_connection_test_does_not_blame_model_when_output_truncated():
    """复现用户现场：上游 200 但 content 为空、finish_reason=length。

    旧实现会报「返回内容为空，检查模型名是否被支持」——把「我们测得太省」
    说成「用户配置错了」。新实现必须判为「连接正常 + 输出被截断」。
    """
    import json
    import threading
    from http.server import BaseHTTPRequestHandler, HTTPServer

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length") or 0)
            self.rfile.read(length)
            data = json.dumps(
                {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": "",
                            },
                            "finish_reason": "length",
                        }
                    ]
                }
            ).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *args) -> None:
            return

    server = HTTPServer(("127.0.0.1", 18997), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        target = build_target_from_draft(
            base_url="http://127.0.0.1:18997/v1",
            api_key="sk-test",
            model="deepseek-v4.1-flash",
        )
        result = await relay_test_target(target)
    finally:
        server.shutdown()

    assert result["ok"] is True, result
    assert "截断" in result["message"] or "思考" in result["message"]
    assert "模型名" not in result["message"]


# ---------------------------------------------------------------------------
# 润色（未配置中转站 → 本地规则）
# ---------------------------------------------------------------------------
async def test_polish_local_engine_when_unconfigured(client):
    """未配置中转站：润色仍可用，但必须标明是本地规则，并给出多个变体。"""
    headers = await _headers(client)
    resp = await client.post(
        "/api/ai/polish",
        json={"text": "帮我做一个好看点的海报，就是那种高级点的", "scene": "composer", "variants": 2},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["engine"] == "local"
    assert data["variants"], "至少要给一个可用的润色结果"
    first = data["variants"][0]
    assert "帮我" not in first["text"], "口语诉求词应当去掉"
    # 保真规则：评价词不整词抹掉，而是在原词后追加具体描述，用户才看得出哪部分是自己说的
    assert "好看" in first["text"], "用户原话里的评价词必须保留"
    assert "构图均衡" in first["text"], "评价词后应当补上可执行的视觉描述"
    assert first["notes"]
    assert data["text"] == first["text"], "兼容字段应等于第一个变体"


async def test_polish_modes_behave_differently(client):
    """「更简洁」必须真的更短但主体不变；「英文」本地做不了要如实说明，而不是假装翻译。"""
    headers = await _headers(client)
    long_text = "帮我做一张咖啡店开业的海报，就是那种比较温暖、有生活感、看起来高级一点的那种"

    concise = await client.post(
        "/api/ai/polish",
        json={"text": long_text, "scene": "composer", "mode": "concise", "variants": 1},
        headers=headers,
    )
    short_text = concise.json()["data"]["text"]
    assert len(short_text) < len(long_text), "简洁模式应当去掉口语与冗余限定"
    # 保真的部分：主体（咖啡店开业海报）一个字都不许少
    assert "咖啡店开业的海报" in short_text

    english = await client.post(
        "/api/ai/polish",
        json={"text": long_text, "scene": "composer", "mode": "english", "variants": 1},
        headers=headers,
    )
    payload = english.json()["data"]
    assert payload["engine"] == "local"
    assert any("英文" in note for note in payload["variants"][0]["notes"])


async def test_polish_region_appends_isolation_constraint(client):
    """区域润色必须补「只改这一块」，否则模型会整图重绘。"""
    headers = await _headers(client)
    resp = await client.post(
        "/api/ai/polish",
        json={"text": "把这里换成红色", "scene": "region"},
        headers=headers,
    )
    text = resp.json()["data"]["text"]
    assert "仅修改该区域" in text


# ---------------------------------------------------------------------------
# 全链路：未配置时停在原地
# ---------------------------------------------------------------------------
async def test_compose_unconfigured_does_not_generate(client):
    """未配置中转站 → SSE 返回 unconfigured，且不创建任何生成任务。

    直接查库而不是查接口：接口可能因为参数/权限返回空列表，那种「空」是假绿。
    """
    headers = await _headers(client)
    session_id = await _new_session(client, headers)
    resp = await client.post(
        "/api/chat/compose",
        json={"session_id": session_id, "content": "做一个咖啡店开业海报"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.text
    assert '"unconfigured"' in body
    assert "event" in body

    async with AsyncSessionLocal() as db:
        count = (
            await db.execute(
                select(func.count())
                .select_from(GenerationTask)
                .where(GenerationTask.session_id == session_id)
            )
        ).scalar_one()
    assert count == 0, "未配置中转站时不得直接生图"
