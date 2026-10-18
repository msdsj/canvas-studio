"""B1 传输层韧性：失败分类 / 同模型重试 / 双层 fallback / 三重预算。

覆盖需求
--------
- **R01**：响应体格式识别（网页 / 空体 / 顶层非 dict / JSON 截断）与同模型重试 1 次，
  日志记录 `reason`，用户侧文案不含 json / html / HTTP / 异常类名；
- **R02**：provider 内模型链 + provider 间互备，总尝试次数硬上限；
- **R03**：错误语义后端侧（`UPSTREAM_FORMAT_ERROR` + 结构化 `data`）。

测试策略
--------
起一个真的假上游（`tests/mock_relay.py`）走完整 HTTP 路径，只有「超时 / 连不上」
这类无法在 0.1 秒内复现的故障才用 monkeypatch 注入。
"""
from __future__ import annotations

import json

import httpx
import pytest
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.ai_provider import AIProvider
from app.models.user import User
from app.services import relay_chain, relay_service, relay_types
from app.services.relay_service import build_target_from_draft
from app.services.relay_types import FailureKind
from app.utils.errors import AppError, ErrorCode
from tests.mock_relay import (
    EMPTY,
    HTML,
    NO_CONTENT,
    NOT_OBJECT,
    REFUSED,
    TRUNCATED,
    TRUNCATED_OUTPUT,
    FakeUpstream,
    ok,
    raw,
    status,
)

MESSAGES = [
    {"role": "system", "content": "只输出 JSON"},
    {"role": "user", "content": "做一个咖啡店开业海报"},
]

#: 用户可见文案里绝对不允许出现的字样（R01 硬性要求）
FORBIDDEN_WORDS = (
    "json",
    "JSON",
    "JSONDecodeError",
    "html",
    "HTML",
    "HTTP",
    "Traceback",
    "Exception",
)


def _target(upstream: FakeUpstream, model: str = "primary", fallbacks: list[str] | None = None):
    """构造一个指向假上游的目标。"""
    target = build_target_from_draft(
        base_url=upstream.base_url, api_key="sk-test", model=model
    )
    target.fallback_models = list(fallbacks or [])
    return target


def _assert_clean_text(text: str) -> None:
    """断言一段用户可见文案里没有技术性字样。"""
    for word in FORBIDDEN_WORDS:
        assert word not in text, f"用户文案泄漏了 {word}：{text}"


# --------------------------------------------------------------------------- #
# R01：响应体格式识别 + 同模型重试
# --------------------------------------------------------------------------- #
async def test_html_body_retries_same_model_then_succeeds():
    """上游返回网页 → 同模型重试 1 次（temperature 下调）→ 第二次成功。

    这是「中转站地址填成了网站首页」的最常见形态：第一次必然失败，
    但同一条管道再试一次有一半概率被网关正确路由。
    """
    with FakeUpstream() as upstream:
        upstream.script("primary", HTML, ok('{"a": 1}'))
        outcome = await relay_service.chat_resilient(
            None, "u1", MESSAGES, target=_target(upstream), purpose="compose"
        )

    assert outcome.content == '{"a": 1}'
    assert outcome.total_calls == 2
    assert [item.reason for item in outcome.attempts] == [
        FailureKind.HTML_BODY,
        FailureKind.OK,
    ]
    assert outcome.attempts[0].try_index == 1
    assert outcome.attempts[1].try_index == 2
    # 重试要下调 temperature（让输出更收敛），不能原样重发
    calls = upstream.calls_for("primary")
    assert calls[1]["temperature"] < calls[0]["temperature"]
    assert outcome.degraded is False, "第一个模型就成功了，不算降级"


@pytest.mark.parametrize(
    ("behavior", "expected_reason", "expected_calls"),
    [
        (HTML, FailureKind.HTML_BODY, 2),
        (EMPTY, FailureKind.EMPTY_BODY, 2),
        (raw(b"hello world"), FailureKind.NOT_JSON, 2),
        (TRUNCATED, FailureKind.TRUNCATED_JSON, 2),
        (NOT_OBJECT, FailureKind.NOT_OBJECT, 2),
        (NO_CONTENT, FailureKind.NO_CONTENT, 2),
        (TRUNCATED_OUTPUT, FailureKind.TRUNCATED_OUTPUT, 2),
        # 上游明确拒绝不值得重试：换模型才有意义
        (REFUSED, FailureKind.UPSTREAM_REFUSED, 1),
    ],
)
async def test_body_shape_failures_are_classified(
    behavior: dict, expected_reason: FailureKind, expected_calls: int
):
    """六类响应体形态都要被正确分类，并按策略决定是否重试。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", behavior)
        with pytest.raises(AppError) as exc_info:
            await relay_service.chat_resilient(
                None, "u1", MESSAGES, target=_target(upstream)
            )

    error = exc_info.value
    assert error.data["reason"] == expected_reason.value
    assert error.data["total_calls"] == expected_calls
    assert error.data["attempts"][0]["tries"] == expected_calls
    assert len(upstream.calls) == expected_calls


async def test_truncated_json_retry_boosts_max_tokens():
    """截断的根因是 token 不够，原样重试必然再截断 → 必须放大 max_tokens。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", TRUNCATED, ok('{"a": 1}'))
        outcome = await relay_service.chat_resilient(
            None, "u1", MESSAGES, target=_target(upstream), max_tokens=1000
        )

    calls = upstream.calls_for("primary")
    assert calls[0]["max_tokens"] == 1000
    assert calls[1]["max_tokens"] == 1500, "截断类重试要把 max_tokens 放大 1.5 倍"
    assert outcome.total_calls == 2


async def test_html_body_is_not_mistaken_for_empty_content():
    """必须先判响应体形态再判内容抽取，否则会误判成「模型没给正文」。"""
    kind, _, _ = relay_service._classify_failure(
        200, b"<!DOCTYPE html><html><body>welcome</body></html>"
    )
    assert kind is FailureKind.HTML_BODY


# --------------------------------------------------------------------------- #
# R02：双层 fallback
# --------------------------------------------------------------------------- #
async def test_html_twice_switches_to_fallback_model():
    """主模型两次都返回网页 → 换 fallback_models[0] 并成功（标记降级）。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", HTML, HTML)
        upstream.script("fb1", ok('{"a": 2}'))
        outcome = await relay_service.chat_resilient(
            None, "u1", MESSAGES, target=_target(upstream, fallbacks=["fb1", "fb2"])
        )

    assert outcome.content == '{"a": 2}'
    assert outcome.model == "fb1"
    assert outcome.degraded is True
    assert outcome.chain == ["primary", "fb1", "fb2"]
    assert outcome.total_calls == 3
    assert len(upstream.calls_for("primary")) == 2
    assert len(upstream.calls_for("fb1")) == 1
    assert upstream.calls_for("fb2") == [], "fb1 成功就不该再试 fb2"


async def test_chain_dedupes_and_truncates_to_budget():
    """同名模型去重、空串丢弃、链长度硬上限 4。"""
    target = build_target_from_draft(
        base_url="http://127.0.0.1:9/v1", api_key="k", model="primary"
    )
    target.fallback_models = ["primary", "fb1", "fb1", "", "fb2", "fb3", "fb4"]
    plan = await relay_chain.build_chain_plan(None, "u1", target)

    assert plan.fallback_models == ["fb1", "fb2", "fb3"], "存 3（去重、去掉等于主模型）"
    assert plan.models == ["primary", "fb1", "fb2"], "试 2 + 主模型"


async def test_timeout_does_not_retry_and_switches_model(monkeypatch):
    """超时**不重试**直接换模型：重试一次就把等待拉到 180s+，体验上等价于卡死。"""
    real_post = relay_service._post_capped

    async def fake_post(client, target, body):
        if body.get("model") == "slow":
            raise httpx.ReadTimeout("read timeout", request=None)
        return await real_post(client, target, body)

    monkeypatch.setattr(relay_service, "_post_capped", fake_post)

    with FakeUpstream() as upstream:
        upstream.script("fb1", ok('{"a": 3}'))
        outcome = await relay_service.chat_resilient(
            None, "u1", MESSAGES, target=_target(upstream, model="slow", fallbacks=["fb1"])
        )

    assert outcome.model == "fb1"
    assert outcome.total_calls == 2, "超时模型只该被调用 1 次"
    assert outcome.attempts[0].reason is FailureKind.TIMEOUT
    assert [item.model for item in outcome.attempts] == ["slow", "fb1"]
    assert len([item for item in outcome.attempts if item.model == "slow"]) == 1


async def test_connect_error_terminates_whole_chain(monkeypatch):
    """连不上 = 配置错误：立即终止整链，不浪费 fallback 预算。"""
    async def fake_post(client, target, body):
        raise httpx.ConnectError("refused")

    monkeypatch.setattr(relay_service, "_post_capped", fake_post)

    with FakeUpstream() as upstream:
        with pytest.raises(AppError) as exc_info:
            await relay_service.chat_resilient(
                None,
                "u1",
                MESSAGES,
                target=_target(upstream, fallbacks=["fb1", "fb2"]),
            )

    error = exc_info.value
    assert error.code is ErrorCode.PROXY_UNREACHABLE
    assert error.data["reason"] == "connect_error"
    assert error.data["total_calls"] == 1
    assert error.data["chain"] == ["primary", "fb1", "fb2"], "链照常展示，只是没往下走"
    _assert_clean_text(error.message)


async def test_auth_error_terminates_whole_chain():
    """401/403 = Key 错：换模型、换 provider 都救不了。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", status(401, "invalid api key"))
        upstream.script("fb1", ok())
        with pytest.raises(AppError) as exc_info:
            await relay_service.chat_resilient(
                None, "u1", MESSAGES, target=_target(upstream, fallbacks=["fb1"])
            )

    error = exc_info.value
    assert error.code is ErrorCode.UPSTREAM_ERROR
    assert error.data["reason"] == "auth_error"
    assert upstream.calls_for("fb1") == []
    _assert_clean_text(error.message)


async def test_http_5xx_retries_once_then_switches():
    """5xx 值得再给同一个模型一次机会。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", status(502, "bad gateway"), ok('{"a": 4}'))
        outcome = await relay_service.chat_resilient(
            None, "u1", MESSAGES, target=_target(upstream, fallbacks=["fb1"])
        )

    assert outcome.model == "primary"
    assert outcome.total_calls == 2
    assert outcome.attempts[0].reason is FailureKind.HTTP_5XX


async def test_http_4xx_model_name_error_switches_model():
    """4xx 里提到模型名 → 换模型有意义；其它 4xx 直接终止。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", status(400, "The model does not exist"))
        upstream.script("fb1", ok('{"a": 5}'))
        outcome = await relay_service.chat_resilient(
            None, "u1", MESSAGES, target=_target(upstream, fallbacks=["fb1"])
        )

    assert outcome.model == "fb1"
    assert len(upstream.calls_for("primary")) == 1


async def test_http_4xx_other_reason_is_fatal():
    """参数/额度类 4xx：换模型无用，直接终止（错误卡给「换模型重试」让用户手动绕过）。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", status(400, "insufficient quota"))
        upstream.script("fb1", ok())
        with pytest.raises(AppError) as exc_info:
            await relay_service.chat_resilient(
                None, "u1", MESSAGES, target=_target(upstream, fallbacks=["fb1"])
            )

    assert exc_info.value.data["reason"] == "http_4xx"
    assert upstream.calls_for("fb1") == []


async def test_bad_url_is_fatal():
    """地址不合法（file:// 等）→ BAD_URL，一次调用都不发。"""
    target = build_target_from_draft(base_url="file:///etc/passwd", api_key="k", model="m")
    with pytest.raises(AppError) as exc_info:
        await relay_service.chat_resilient(None, "u1", MESSAGES, target=target)

    assert exc_info.value.code is ErrorCode.VALIDATION_ERROR
    assert exc_info.value.data["reason"] == "bad_url"
    assert exc_info.value.data["total_calls"] == 0


# --------------------------------------------------------------------------- #
# 三重预算
# --------------------------------------------------------------------------- #
async def test_total_http_calls_budget_is_enforced():
    """4 个模型各 2 次 = 8 次会拖到 12 分钟 → 硬上限 5 次。"""
    with FakeUpstream() as upstream:
        upstream.script_default(HTML)
        with pytest.raises(AppError) as exc_info:
            await relay_service.chat_resilient(
                None,
                "u1",
                MESSAGES,
                target=_target(upstream, fallbacks=["fb1", "fb2", "fb3"]),
            )

    error = exc_info.value
    assert error.data["total_calls"] == relay_types.MAX_HTTP_CALLS == 5
    assert len(upstream.calls) == 5
    # 5 次 = primary 2 次 + fb1 2 次 + fb2 1 次；fb3 一次都没轮到
    assert upstream.models_called == ["primary", "primary", "fb1", "fb1", "fb2"]
    # 预算耗尽优先于「最后一次失败分类」：链已经走完，原因就是没预算了（ADR-3）
    assert error.data["reason"] == "budget_exhausted"
    assert error.data["next_actions"] == ["retry_later", "check_api_key"]


async def test_retry_per_model_budget():
    """同一模型最多 1 次重试（=2 次调用）。"""
    with FakeUpstream() as upstream:
        upstream.script_default(EMPTY)
        with pytest.raises(AppError):
            await relay_service.chat_resilient(None, "u1", MESSAGES, target=_target(upstream))

    assert len(upstream.calls_for("primary")) == 2


# --------------------------------------------------------------------------- #
# R03：错误语义
# --------------------------------------------------------------------------- #
async def test_error_data_is_structured_and_clean():
    """错误卡要的三要素都在 `data` 里，且 `data` 不含自由文本。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", HTML, HTML)
        upstream.script("fb1", TRUNCATED, TRUNCATED)
        with pytest.raises(AppError) as exc_info:
            await relay_service.chat_resilient(
                None, "u1", MESSAGES, target=_target(upstream, fallbacks=["fb1"])
            )

    error = exc_info.value
    assert error.code is ErrorCode.UPSTREAM_FORMAT_ERROR
    assert error.status_code == 502
    data = error.data
    assert set(data) == {
        "reason",
        "chain",
        "attempts",
        "total_calls",
        "elapsed_ms",
        "next_actions",
        "trace_id",
    }
    assert data["reason"] == "truncated_json", "取最后一次失败的分类"
    assert data["chain"] == ["primary", "fb1"]
    assert data["attempts"] == [
        {
            "model": "primary",
            "provider": "草稿",
            "tries": 2,
            "reason": "html_body",
            "elapsed_ms": data["attempts"][0]["elapsed_ms"],
        },
        {
            "model": "fb1",
            "provider": "草稿",
            "tries": 2,
            "reason": "truncated_json",
            "elapsed_ms": data["attempts"][1]["elapsed_ms"],
        },
    ]
    assert data["next_actions"] == ["raise_max_tokens", "switch_model"]
    assert data["trace_id"].startswith("relay_")
    # 文案必须干净；`data` 里没有一个自由文本字段——
    # 字符串值只有「枚举值 / 用户自己填的模型名与 provider 名 / trace_id」三类
    _assert_clean_text(error.message)
    enum_values = {kind.value for kind in FailureKind}
    allowed_actions = {"check_base_url", "switch_model", "raise_max_tokens", "check_api_key", "retry_later"}
    assert data["reason"] in enum_values
    assert set(data["next_actions"]) <= allowed_actions
    for attempt in data["attempts"]:
        assert set(attempt) == {"model", "provider", "tries", "reason", "elapsed_ms"}
        assert attempt["reason"] in enum_values
        assert isinstance(attempt["tries"], int)
        assert isinstance(attempt["elapsed_ms"], int)
    for model in data["chain"]:
        assert model in {"primary", "fb1"}


def test_every_failure_kind_has_policy_and_message():
    """新增 `FailureKind` 时必须同步策略与文案，否则会静默按「终止」处理。"""
    for kind in FailureKind:
        assert kind in relay_types.FAILURE_POLICIES, kind
        if kind is FailureKind.OK:
            continue  # OK 不是失败，没有文案与错误码
        assert kind in relay_types.USER_MESSAGES, kind
        assert kind in relay_types.ERROR_CODE_FOR, kind
        _assert_clean_text(relay_types.USER_MESSAGES[kind])


def test_next_actions_are_from_closed_set():
    """`next_actions` 是枚举：前端按 key 映射 i18n，不能出现新值。"""
    allowed = {"check_base_url", "switch_model", "raise_max_tokens", "check_api_key", "retry_later"}
    for kind in FailureKind:
        assert set(relay_types.next_actions_for(kind)) <= allowed, kind


# --------------------------------------------------------------------------- #
# 兼容性：chat() 的签名与返回结构不变
# --------------------------------------------------------------------------- #
async def test_chat_keeps_legacy_return_shape():
    """`compose_service` / `polish_service` 依赖这个结构，一个字段都不能变。"""
    with FakeUpstream() as upstream:
        upstream.script("primary", ok('{"a": 6}'))
        result = await relay_service.chat(
            None, "u1", MESSAGES, target=_target(upstream), json_mode=True
        )

    assert set(result) == {"content", "model", "provider", "source", "elapsed_ms"}
    assert result["content"] == '{"a": 6}'
    assert result["model"] == "primary"
    assert isinstance(result["elapsed_ms"], int)


async def test_chat_unconfigured_raises_validation_error():
    """没有中转站时必须如实报错，不能伪造结论。"""
    with pytest.raises(AppError) as exc_info:
        await relay_service.chat(None, "u1", MESSAGES, target=None)
    assert exc_info.value.code is ErrorCode.VALIDATION_ERROR


# --------------------------------------------------------------------------- #
# 跨 provider 互备（读同用户其他 provider，按 updated_at desc）
# --------------------------------------------------------------------------- #
async def test_cross_provider_backup_is_appended(client):
    """主 provider 全链失败后，取同用户另一个 provider 作为二级候选。"""
    await _seed_providers(client)
    async with AsyncSessionLocal() as db:
        user_id = (await db.execute(select(User.id))).scalars().first()
        target = await relay_service.resolve(db, user_id)
        assert target is not None and target.provider_id, "resolve 必须带 provider_id"
        plan = await relay_chain.build_chain_plan(db, user_id, target)

    assert plan.models == ["deepseek-chat", "fb-a", "fb-b", "qwen-max"]
    assert plan.backup_provider is not None
    assert plan.backup_provider["model"] == "qwen-max"
    assert "base_url" not in plan.backup_provider, "错误卡/状态里不许出现地址"
    assert "api_key" not in plan.backup_provider


async def _seed_providers(client) -> None:
    """建两条 provider：主站（带 3 个备用模型）+ 备用网关（作为跨 provider 候选）。"""
    import asyncio

    resp = await client.post(
        "/api/auth/login",
        json={"email": "admin@canvas.studio", "password": "Admin@12345"},
    )
    assert resp.status_code == 200, resp.text
    headers = {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}

    backup = await client.post(
        "/api/ai/providers",
        json={
            "name": "备用网关",
            "kind": "compatible",
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": "sk-backup",
            "model": "qwen-max",
        },
        headers=headers,
    )
    assert backup.status_code == 200, backup.text
    # 保证 updated_at 有先后（跨 provider 互备按 updated_at desc 取）
    await asyncio.sleep(0.02)
    primary = await client.post(
        "/api/ai/providers",
        json={
            "name": "主站",
            "kind": "deepseek",
            "base_url": "http://127.0.0.1:9/v1",
            "api_key": "sk-main",
            "model": "deepseek-chat",
            "fallback_models": ["fb-a", "fb-b", "fb-c"],
            "is_active": True,
        },
        headers=headers,
    )
    assert primary.status_code == 200, primary.text
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(
                select(AIProvider).where(AIProvider.id == primary.json()["data"]["id"])
            )
        ).scalar_one()
        assert row.fallback_models == ["fb-a", "fb-b", "fb-c"]
