"""前置需求分析（流式）+ 按张数并发派发。

覆盖三件事：
1. 分析流：思考文字实时推出、`<<<JSON>>>` 之后只报进度、最终 JSON 能解析；
2. 张数解析：通用规则（单张保留原话、不同画面用专属描述、超限明确失败）；
3. 派发：N 张 = N 个独立任务（n=1、幂等键各不相同），全部建好后一起起跑；
   整批完整提交后再执行，任一创建失败须回滚所有新任务。
"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from app.services import compose_service, relay_service, relay_types, task_service
from app.services.relay_service import build_target_from_draft
from app.utils.errors import AppError, ErrorCode

ANALYSIS = {
    "summary": "四季主题插画",
    "subject": "四季风景",
    "image_count": 2,
    "count_reason": "用户要春、夏两张",
    "images": [
        {"label": "春", "prompt": "春天的樱花小路，水彩插画风格"},
        {"label": "夏", "prompt": "夏天的海边落日，水彩插画风格"},
    ],
    "ambiguity": {"is_ambiguous": False},
}


def _events(chunks: list[str]) -> list[dict]:
    return [json.loads(chunk[6:].strip()) for chunk in chunks]


async def _pieces(*chunks: str):
    """Inject protocol content without binding a local TCP listener."""
    for chunk in chunks:
        yield chunk


def _target():
    return build_target_from_draft(base_url="https://relay.test/v1", api_key="test", model="m")


# --------------------------------------------------------------------------- #
# 1) 流式分析
# --------------------------------------------------------------------------- #
async def test_stream_analysis_does_not_expose_raw_model_prose():
    body = json.dumps(ANALYSIS, ensure_ascii=False)
    sink: dict = {}
    chunks = [c async for c in compose_service._stream_analysis(
        _target(), [{"role": "user", "content": "x"}], sink,
        text_stream=_pieces("private chain must stay hidden {note}\n<<<", "JSON>>>\n", body[:30], body[30:]),
    )]

    events = _events(chunks)
    assert not [event for event in events if event["event"] == "thought"]
    assert all("private chain" not in chunk for chunk in chunks)
    assert sink["analysis"]["image_count"] == 2
    assert sink["analysis"]["_meta"]["streamed"] is True
    assert sink["thought"] == ""


async def test_stream_analysis_tolerates_plain_json_without_marker():
    sink: dict = {}
    chunks = [c async for c in compose_service._stream_analysis(
        _target(), [{"role": "user", "content": "x"}], sink,
        text_stream=_pieces(json.dumps(ANALYSIS, ensure_ascii=False)),
    )]
    assert not [e for e in _events(chunks) if e["event"] == "thought"], "纯 JSON 不能刷成思考"
    assert sink["analysis"]["summary"] == "四季主题插画"
    assert sink["thought"] == ""


async def test_stream_analysis_raises_when_no_json():
    with pytest.raises(AppError):
        async for _ in compose_service._stream_analysis(
            _target(), [{"role": "user", "content": "x"}], {},
            text_stream=_pieces("已经识别需求，但未返回结构化结果"),
        ):
            pass


def test_extract_json_ignores_braces_in_thought():
    text = "思考里提到了 {花括号}\n<<<JSON>>>\n" + json.dumps({"a": 1})
    assert compose_service._extract_json(text) == {"a": 1}


# --------------------------------------------------------------------------- #
# 2) 张数解析
# --------------------------------------------------------------------------- #
def test_resolve_jobs_single_image_always_uses_base_prompt():
    jobs = compose_service.resolve_jobs(
        {"image_count": 1, "images": [{"prompt": "模型改写过的提示词不该被采用"}]}, "用户原话"
    )
    assert jobs == [{"index": 1, "label": "", "prompt": "用户原话", "custom": False}]


def test_resolve_jobs_distinct_scenes_use_per_image_prompts():
    jobs = compose_service.resolve_jobs(ANALYSIS, "用户原话")
    assert [job["prompt"] for job in jobs] == [item["prompt"] for item in ANALYSIS["images"]]
    assert all(job["custom"] for job in jobs)


def test_resolve_jobs_variants_preserve_requested_count():
    jobs = compose_service.resolve_jobs({"image_count": compose_service.MAX_IMAGES, "images": []}, "用户原话")
    assert len(jobs) == compose_service.MAX_IMAGES
    assert {job["prompt"] for job in jobs} == {"用户原话"}, "同一画面多版本：每张都用原话"
    assert len(compose_service.resolve_jobs({}, "x")) == 1


@pytest.mark.parametrize("count", ["abc", True, 2.5, None, []])
def test_resolve_jobs_rejects_invalid_model_count(count):
    with pytest.raises(AppError) as info:
        compose_service.resolve_jobs({"image_count": count}, "x")
    assert info.value.code == ErrorCode.UPSTREAM_FORMAT_ERROR


def test_resolve_jobs_rejects_unsupported_count_instead_of_truncating():
    with pytest.raises(AppError) as info:
        compose_service.resolve_jobs({"image_count": compose_service.MAX_IMAGES + 1, "images": []}, "用户原话")
    assert info.value.code == ErrorCode.VALIDATION_ERROR


# --------------------------------------------------------------------------- #
# 3) 派发
# --------------------------------------------------------------------------- #
class _FakeDb:
    def __init__(self) -> None:
        self.commits = 0
        self.refreshed: list = []

    async def commit(self) -> None:
        self.commits += 1

    async def refresh(self, obj) -> None:
        self.refreshed.append(obj)


def _run() -> SimpleNamespace:
    return SimpleNamespace(id="run1", session_id="s1", canvas_id=None)


@pytest.fixture
def fake_create(monkeypatch):
    from app.services import batch_service

    calls: list[dict] = []
    spawned: list[str] = []
    refunds: list[str] = []
    fail_from: dict = {"index": None}
    capacity_mode: dict[str, str | None] = {"value": None}

    async def create_image_task(db, user_id, **kwargs):
        if fail_from["index"] is not None and len(calls) + 1 >= fail_from["index"]:
            raise AppError(ErrorCode.QUOTA_INSUFFICIENT)
        calls.append(kwargs)
        task = SimpleNamespace(
            id=f"t{len(calls)}", type="generate", status="running", prompt=kwargs["prompt"], cost=10
        )
        return task, True

    monkeypatch.setattr(compose_service.generate_service, "create_image_task", create_image_task)
    monkeypatch.setattr(compose_service, "_spawn_run", spawned.append)

    async def fail_and_refund(db, task_id, code, message):
        refunds.append(task_id)

    async def preflight(*args, **kwargs):
        return capacity_mode["value"]

    async def resolve_cost(*args, **kwargs):
        return 10

    monkeypatch.setattr(task_service, "fail_and_refund", fail_and_refund)
    monkeypatch.setattr(batch_service, "preflight", preflight)
    monkeypatch.setattr(compose_service.generate_service, "resolve_cost", resolve_cost)
    return SimpleNamespace(
        calls=calls, spawned=spawned, fail_from=fail_from, refunds=refunds,
        capacity_mode=capacity_mode,
    )


async def test_dispatch_creates_one_independent_task_per_image(fake_create):
    jobs = compose_service.resolve_jobs(ANALYSIS, "用户原话")
    tasks = await compose_service._dispatch(
        _FakeDb(), SimpleNamespace(id="u1"), _run(),
        final_prompt="用户原话", negative="", size="1024x1024", refs=[],
        idempotency_key="compose:k", jobs=jobs,
    )
    assert [t["id"] for t in tasks] == ["t1", "t2"]
    assert all(call["n"] == 1 for call in fake_create.calls), "每个任务只出 1 张，各走一次网关"
    keys = [call["idempotency_key"] for call in fake_create.calls]
    assert keys == ["compose:k:1", "compose:k:2"], "幂等键各不相同，才不会互相 replay"
    assert fake_create.calls[0]["extra"]["batch_total"] == 2
    assert {call["extra"]["pool_batch_id"] for call in fake_create.calls} == {"run1"}
    assert [call["extra"]["pool_task_id"] for call in fake_create.calls] == ["1", "2"]
    assert all(call["extra"]["pool_batch_total"] == 2 for call in fake_create.calls)
    assert fake_create.spawned == ["t1", "t2"], "全部建好后一起起跑"
    assert [t["label"] for t in tasks] == ["春", "夏"]


async def test_upstream_dispatch_uses_parallel_non_strict_account_routing(fake_create):
    fake_create.capacity_mode["value"] = "upstream"
    tasks = await compose_service._dispatch(
        _FakeDb(), SimpleNamespace(id="u1"), _run(),
        final_prompt="用户原话", negative="", size="1024x1024", refs=[],
        idempotency_key="compose:k", jobs=compose_service.resolve_jobs(ANALYSIS, "用户原话"),
    )
    assert len(tasks) == 2
    assert all(call["n"] == 1 for call in fake_create.calls)
    assert all(call["extra"]["pool_strict"] is False for call in fake_create.calls)
    assert fake_create.spawned == ["t1", "t2"]


async def test_dispatch_single_image_keeps_original_key(fake_create):
    await compose_service._dispatch(
        _FakeDb(), SimpleNamespace(id="u1"), _run(),
        final_prompt="用户原话", negative="", size="1024x1024", refs=[],
        idempotency_key="compose:k",
    )
    assert fake_create.calls[0]["idempotency_key"] == "compose:k"
    assert "batch_total" not in fake_create.calls[0]["extra"]


async def test_dispatch_partial_failure_refunds_entire_batch_without_execution(fake_create):
    fake_create.fail_from["index"] = 2
    db = _FakeDb()
    run = _run()
    with pytest.raises(AppError) as info:
        await compose_service._dispatch(
            db, SimpleNamespace(id="u1"), run,
            final_prompt="用户原话", negative="", size="1024x1024", refs=[],
            idempotency_key="compose:k", jobs=compose_service.resolve_jobs({"image_count": 3}, "用户原话"),
        )
    assert info.value.code == ErrorCode.QUOTA_INSUFFICIENT
    assert fake_create.refunds == ["t1"]
    assert fake_create.spawned == []
    assert run in db.refreshed, "rollback 之后要把 run 重新载入"


async def test_dispatch_raises_when_nothing_submitted(fake_create):
    fake_create.fail_from["index"] = 1
    with pytest.raises(AppError) as info:
        await compose_service._dispatch(
            _FakeDb(), SimpleNamespace(id="u1"), _run(),
            final_prompt="用户原话", negative="", size="1024x1024", refs=[],
            idempotency_key="compose:k", jobs=compose_service.resolve_jobs({"image_count": 2}, "x" * 10),
        )
    assert info.value.code == ErrorCode.QUOTA_INSUFFICIENT
    assert fake_create.spawned == []


async def test_schedule_jobs_preserves_all_outputs_when_slots_are_insufficient(monkeypatch):
    async def free_slots(db, user_id):
        return 2

    async def no_pool():
        return {"total": 3, "normal": 3}

    monkeypatch.setattr(compose_service, "_free_slots", free_slots)
    monkeypatch.setattr(compose_service, "_pool_capacity", no_pool)
    jobs = compose_service.resolve_jobs({"image_count": 4}, "用户原话")
    scheduled, items = await compose_service._schedule_jobs(None, "u1", jobs, "要四张")
    assert len(scheduled) == 4, "缺并发槽位时应明确失败或排队，不能悄悄漏掉产出"
    assert items[0] == "需要生成 4 张：要四张"
    assert any("并发槽位" in item for item in items)
    assert any("3/3" in item for item in items)


# --------------------------------------------------------------------------- #
# 4) 端到端：真实接口 + 假中转站，验证「流式分析 → 张数判定 → N 个任务」
# --------------------------------------------------------------------------- #
async def test_compose_endpoint_streams_public_analysis_and_dispatches_n_tasks(client, monkeypatch):
    from sqlalchemy import select

    from app.database import AsyncSessionLocal
    from app.models.generation import GenerationTask
    from app.services.gateway_client import gateway_client

    spawned: list[str] = []
    monkeypatch.setattr(compose_service, "_spawn_run", spawned.append)

    login = await client.post(
        "/api/auth/login", json={"email": "admin@canvas.studio", "password": "Admin@12345"}
    )
    headers = {"Authorization": f"Bearer {login.json()['data']['access_token']}"}
    analysis = {**ANALYSIS, "confidence": 0.95, "missing": [], "thinking": ["主体明确"]}
    body = json.dumps(analysis, ensure_ascii=False)

    async def resolve(*args, **kwargs):
        return _target()

    async def stream(target, messages, **kwargs):
        if any("本轮事实（JSON）" in str(message.get("content")) for message in messages):
            yield "好的，两张一起开画。"
            return
        async for piece in _pieces("用户要春夏两张，", "主体明确。\n<<<JSON>>>\n", body):
            yield piece

    async def resilient(*args, **kwargs):
        return relay_types.RelayOutcome(
            content=body, model="m", provider="测试中转站", source="user", elapsed_ms=1,
            attempts=[], chain=["m"], total_calls=1, degraded=False,
        )

    async def capacity(*args, **kwargs):
        return {"total": 2, "healthy": 2, "available": 2, "independent_routing": True}

    async def pool_stats():
        return {"total": 2, "normal": 2, "routable_available": 2, "routable_known": 1}

    monkeypatch.setattr(relay_service, "resolve", resolve)
    monkeypatch.setattr(relay_service, "chat_stream", stream)
    monkeypatch.setattr(relay_service, "chat_resilient", resilient)
    monkeypatch.setattr(gateway_client, "pool_capacity", capacity)
    monkeypatch.setattr(compose_service, "_pool_capacity", pool_stats)
    session = await client.post("/api/chat/sessions", json={"new_canvas": True}, headers=headers)
    session_id = session.json()["data"]["id"]
    resp = await client.post(
        "/api/chat/compose",
        json={"session_id": session_id, "content": "画两张水彩插画：春天的樱花小路和夏天的海边落日"},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    events = [json.loads(line[6:]) for line in resp.text.splitlines() if line.startswith("data: ")]
    kinds = [e["event"] for e in events]
    assert "analysis" in kinds, "结构化需求分析应在最终结果前展示"
    assert kinds.index("analysis") < kinds.index("result")
    assert "thought" not in kinds, "自由文本推理不应透传"
    steps = {e["step"]["id"]: e["step"] for e in events if e["event"] == "step"}
    assert "thought" not in steps["analyze"]
    assert steps["analyze"]["meta"]["streamed"] is True
    assert steps["schedule"]["status"] == "done"
    result = next(e["result"] for e in events if e["event"] == "result")
    assert result["status"] == "direct"
    assert len(result["tasks"]) == 2
    assert len(spawned) == 2

    async with AsyncSessionLocal() as db:
        tasks = (
            await db.execute(select(GenerationTask).where(GenerationTask.session_id == session_id))
        ).scalars().all()
    assert sorted(t.params["batch_label"] for t in tasks) == ["夏", "春"]
    assert all(t.params["n"] == 1 for t in tasks)
