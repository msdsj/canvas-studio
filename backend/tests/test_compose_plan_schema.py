"""B3 输出契约与校验：R04 单一 schema 源 / R05 校验→纠错→兜底 / R06 出图硬约束。

覆盖
----
- R04：`ComposePlan` 是唯一契约源，导出的 JSON Schema 字段集合被断言（改字段只改一处）；
- R05：缺字段 / 类型错 / 枚举越界 / 多余字段四类都能给出「字段路径 + 期望」的纠错清单，
  `_call_json` 最多纠错 2 次，3 次仍不合法退到 `template_fallback` 且**不抛异常**；
- R06：`aspect` 有值 / 最终提示词尾部含负向段 / 长度与 style_tag，任一不满足**拒绝建任务**。

关键区分（两层重试不能互相抵消）
--------------------------------
- **传输重试**（网页 / 空体 / 截断）在 `relay_service.chat_resilient` 内部，不消耗纠错预算；
- **语义纠错**（能解析但不符合契约）在本文件覆盖的 `_call_json` 循环里，最多 2 次。
"""
from __future__ import annotations

import json

import pytest

from app.schemas.compose_plan import (
    ASPECTS,
    ASPECT_TO_SIZE,
    MAX_DISPATCH_PROMPT_CHARS,
    MAX_PROMPT_CHARS,
    MIN_PROMPT_CHARS,
    NEGATIVE_MARKER,
    PLAN_SCHEMA_VERSION,
    QUALITY_SUFFIX,
    ComposePlan,
)
from app.services import compose_service, plan_validator, relay_service, relay_types
from app.utils.errors import AppError, ErrorCode

#: 契约字段集合（导出 schema 的断言基准，也是「多余字段」用例的过滤器）
CONTRACT_KEYS = {
    "schema_version",
    "title",
    "subject",
    "aspect",
    "negative",
    "final_prompt",
    "skill_id",
    "style_tags",
    "reasoning",
    "source",
    "prompt_truncated",
    "extra_notes",
}

TEXT = "帮我做一张咖啡店开业海报，暖色调，突出手冲咖啡与木质吧台"


def _skills() -> list:
    """真实的技能初筛结果（用生产函数，不手写假数据）。"""
    hits = compose_service.shortlist_skills(TEXT)
    assert hits, "测试前置：这句话必须命中技能"
    return hits


def _valid_plan() -> dict:
    """一份**契约形状**的合法 plan（去掉模板兜底附带的派生字段）。"""
    plan = plan_validator.template_fallback_plan(TEXT, _skills())
    return {key: value for key, value in plan.items() if key in CONTRACT_KEYS}


def _outcome(content: str) -> relay_types.RelayOutcome:
    """构造一个成功的 RelayOutcome（绕过 HTTP，只测语义层）。"""
    return relay_types.RelayOutcome(
        content=content,
        model="test-model",
        provider="测试中转站",
        source="user",
        elapsed_ms=1,
        attempts=[],
        chain=["test-model"],
        total_calls=1,
        degraded=False,
    )


# --------------------------------------------------------------------------- #
# R04：单一契约源
# --------------------------------------------------------------------------- #
def test_plan_schema_field_set_is_the_contract():
    """导出的 JSON Schema 字段集合 == 契约字段集合（前端断言脚本的同一基准）。"""
    schema = ComposePlan.model_json_schema()
    assert set(schema["properties"]) == CONTRACT_KEYS
    assert schema["additionalProperties"] is False, "extra='forbid' 必须落到 schema 上"


def test_aspect_enum_has_single_definition():
    """`aspect` 只允许 5 个值，且枚举只有一处定义。"""
    assert ASPECTS == ("1:1", "3:4", "4:3", "9:16", "16:9")
    schema = ComposePlan.model_json_schema()
    assert schema["properties"]["aspect"]["enum"] == list(ASPECTS)


def test_aspect_to_size_mapping_degrades_gracefully():
    """C1：`9:16` 与 `16:9` 落到最接近的上游尺寸（上游能力上限，不是缺陷）。"""
    assert ASPECT_TO_SIZE == {
        "1:1": "1024x1024",
        "3:4": "1024x1536",
        "4:3": "1536x1024",
        "9:16": "1024x1536",
        "16:9": "1536x1024",
    }
    assert plan_validator.aspect_to_size("9:16") == "1024x1536"
    assert plan_validator.aspect_to_size("16:9") == "1536x1024"
    assert plan_validator.aspect_to_size("") == "1024x1024"


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("1:1", "1:1"),
        ("4:5", "3:4"),  # 技能库里的小红书比例
        ("1:1.414", "3:4"),  # A4 竖版
        ("9:19.5", "9:16"),  # 手机全屏
        ("16:10", "16:9"),
        ("1:3", "9:16"),  # 极窄 → 最接近的竖版
        ("", "1:1"),
        ("garbage", "1:1"),
    ],
)
def test_normalize_aspect_maps_skill_ratios(raw: str, expected: str):
    """技能库里的比例写法要被收敛到 5 个合法值，而不是丢弃。"""
    assert plan_validator.normalize_aspect(raw) == expected


# --------------------------------------------------------------------------- #
# R05：四类校验失败都能给出「字段路径 + 期望」
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    ("mutate", "expected_path"),
    [
        # 缺字段
        (lambda plan: plan.pop("aspect"), "aspect"),
        # 类型错
        (lambda plan: plan.update(style_tags="大字报"), "style_tags"),
        # 枚举越界
        (lambda plan: plan.update(aspect="4:5"), "aspect"),
        # 多余字段
        (lambda plan: plan.update(size="1024x1024"), "size"),
    ],
)
def test_validate_plan_rejects_four_kinds_of_drift(mutate, expected_path: str):
    """R05 要求单测覆盖四类：缺字段 / 类型错 / 枚举越界 / 多余字段。"""
    plan = _valid_plan()
    mutate(plan)
    report = plan_validator.validate_plan(plan, _skills())

    assert report.ok is False
    assert report.plan is None
    assert expected_path in report.paths, report.paths
    for issue in report.errors:
        assert issue.path, "每条问题都必须带字段路径"
        assert issue.message, "每条问题都必须带期望说明"


def test_validate_plan_rejects_unknown_skill_id():
    """`skill_id` 未命中技能库 → 校验失败（不再静默回退 shortlisted[0]）。"""
    plan = _valid_plan()
    plan["skill_id"] = "not-a-real-skill"
    report = plan_validator.validate_plan(plan, _skills())

    assert report.ok is False
    assert "skill_id" in report.paths


def test_validate_plan_requires_style_tag_in_prompt():
    """`final_prompt` 必须含 ≥1 个 style_tag（跨字段约束，Pydantic 表达不了）。"""
    plan = _valid_plan()
    plan["style_tags"] = ["赛博朋克"]
    plan["final_prompt"] = "一张咖啡店开业海报，暖色调，木质吧台，手冲咖啡特写，构图均衡，光线自然，细节锐利"
    report = plan_validator.validate_plan(plan, _skills())

    assert report.ok is False
    assert "final_prompt" in report.paths


def test_validate_plan_rejects_prompt_out_of_range():
    """C2：契约上限 800、下限 40。"""
    too_long = _valid_plan()
    too_long["final_prompt"] = "画" * (MAX_PROMPT_CHARS + 1)
    assert plan_validator.validate_plan(too_long, _skills()).ok is False

    too_short = _valid_plan()
    too_short["final_prompt"] = "画"
    assert plan_validator.validate_plan(too_short, _skills()).ok is False


def test_repair_hint_carries_path_and_expectation():
    """纠错提示必须写清「哪个字段、期望什么」，否则模型改不动（R05）。"""
    plan = _valid_plan()
    plan.pop("aspect")
    plan.update(size="1024x1024")
    report = plan_validator.validate_plan(plan, _skills())

    hint = plan_validator.build_repair_hint(report.errors)
    assert "不符合要求" in hint
    assert "`aspect`" in hint, "必须点名具体字段"
    assert "`size`" in hint
    assert "extra_notes" in hint, "要明确「除 extra_notes 外不要多加字段」"


def test_valid_plan_roundtrip_is_contract_shaped():
    """合法输入返回的 plan 只有契约字段（前端可直接消费）。"""
    report = plan_validator.validate_plan(_valid_plan(), _skills())
    assert report.ok is True
    assert set(report.plan or {}) == CONTRACT_KEYS
    assert report.plan["schema_version"] == PLAN_SCHEMA_VERSION


# --------------------------------------------------------------------------- #
# R05：纠错重试 → 模板兜底（语义层，不经 HTTP）
# --------------------------------------------------------------------------- #
async def test_call_json_repairs_then_succeeds(monkeypatch):
    """第 1 次缺字段 → 追加纠错提示 → 第 2 次合法，返回 plan 与纠错记录。"""
    calls: list[list[dict]] = []
    invalid = _valid_plan()
    invalid.pop("aspect")
    valid = _valid_plan()

    async def fake_chat_resilient(db, user_id, messages, **kwargs):
        calls.append(list(messages))
        return _outcome(json.dumps(invalid if len(calls) == 1 else valid, ensure_ascii=False))

    monkeypatch.setattr(relay_service, "chat_resilient", fake_chat_resilient)

    plan, outcome, repair_log = await compose_service._call_json(
        None,
        "u1",
        [{"role": "system", "content": "sys"}, {"role": "user", "content": TEXT}],
        schema=ComposePlan,
        stage="reason",
        shortlisted=_skills(),
    )

    assert len(calls) == 2, "第 1 次不合法、第 2 次合法"
    assert plan["aspect"] in ASPECTS
    assert outcome.model == "test-model"
    assert len(repair_log) == 1
    assert "aspect" in repair_log[0]
    # 纠错提示必须真的进了第 2 次请求
    assert "不符合要求" in calls[1][-1]["content"]
    assert calls[1][0]["content"] == "sys", "原始 messages 必须保留"


async def test_call_json_falls_back_to_template_after_three_attempts(monkeypatch):
    """3 次仍不合法 → 模板兜底，**不抛异常**（R05：不阻塞建任务）。"""
    invalid = _valid_plan()
    invalid["aspect"] = "4:5"  # 枚举越界
    calls: list[list[dict]] = []

    async def fake_chat_resilient(db, user_id, messages, **kwargs):
        calls.append(list(messages))
        return _outcome(json.dumps(invalid, ensure_ascii=False))

    monkeypatch.setattr(relay_service, "chat_resilient", fake_chat_resilient)

    plan, _outcome_obj, repair_log = await compose_service._call_json(
        None,
        "u1",
        [{"role": "user", "content": TEXT}],
        schema=ComposePlan,
        stage="prompt",
        shortlisted=_skills(),
    )

    assert len(calls) == compose_service.MAX_SEMANTIC_ATTEMPTS == 3, "1 次原始 + 2 次纠错"
    assert plan["source"] == "template_fallback"
    assert plan["aspect"] in ASPECTS, "兜底产出必须自己合法"
    assert repair_log[-1] == "template_fallback"
    # 兜底产出也要能直接派发（否则等于把问题推给下游）
    assembled = plan_validator.assemble_dispatch_prompt(plan["final_prompt"], plan["negative"])
    plan_validator.assert_dispatchable(plan, assembled)


async def test_transport_failure_does_not_consume_repair_budget(monkeypatch):
    """传输层彻底失败（链耗尽）→ 如实抛错，**不**用模板顶替、不消耗纠错预算。

    这是「两层重试不能互相抵消」的关键：上游连不上时，拿同一条坏管道做语义纠错
    毫无意义，也不该让用户看到一份「模板兜底」的假产出。
    """
    calls: list[list[dict]] = []

    async def fake_chat_resilient(db, user_id, messages, **kwargs):
        calls.append(list(messages))
        raise AppError(
            ErrorCode.UPSTREAM_FORMAT_ERROR,
            "这次没能拿到可用的结果，换一个模型再试一次",
            data={"reason": "html_body"},
        )

    monkeypatch.setattr(relay_service, "chat_resilient", fake_chat_resilient)

    with pytest.raises(AppError) as exc_info:
        await compose_service._call_json(
            None,
            "u1",
            [{"role": "user", "content": TEXT}],
            schema=ComposePlan,
            stage="reason",
            shortlisted=_skills(),
        )

    assert exc_info.value.code is ErrorCode.UPSTREAM_FORMAT_ERROR
    assert len(calls) == 1, "传输失败不该触发语义纠错重试"


async def test_call_json_passes_purpose_and_json_mode(monkeypatch):
    """L1 的 `purpose` 用于日志与 R21 统计，不能漏传。"""
    seen: dict = {}

    async def fake_chat_resilient(db, user_id, messages, **kwargs):
        seen.update(kwargs)
        return _outcome(json.dumps(_valid_plan(), ensure_ascii=False))

    monkeypatch.setattr(relay_service, "chat_resilient", fake_chat_resilient)

    await compose_service._call_json(
        None, "u1", [{"role": "user", "content": TEXT}], schema=ComposePlan, stage="analyze"
    )

    assert seen["purpose"] == "analyze"
    assert seen["json_mode"] is True


# --------------------------------------------------------------------------- #
# R06：出图参数硬约束
# --------------------------------------------------------------------------- #
def test_assert_dispatchable_rejects_missing_aspect():
    plan = _valid_plan()
    plan["aspect"] = "4:5"
    assembled = plan_validator.assemble_dispatch_prompt(plan["final_prompt"], plan["negative"])
    with pytest.raises(AppError) as exc_info:
        plan_validator.assert_dispatchable(plan, assembled)
    assert exc_info.value.data["missing"] == ["aspect"]


def test_assert_dispatchable_rejects_missing_negative_segment():
    """`negative` 是折进尾部的：校验对象是拼装后的提示词，不是 plan 原始字段。"""
    plan = _valid_plan()
    assembled_without_tail = plan["final_prompt"]
    with pytest.raises(AppError) as exc_info:
        plan_validator.assert_dispatchable(plan, assembled_without_tail)
    assert "negative" in exc_info.value.data["missing"]


def test_assert_dispatchable_rejects_short_prompt_and_missing_style_tag():
    plan = _valid_plan()
    plan["final_prompt"] = "太短了"
    plan["style_tags"] = ["赛博朋克"]
    assembled = plan_validator.assemble_dispatch_prompt(plan["final_prompt"], plan["negative"])
    with pytest.raises(AppError) as exc_info:
        plan_validator.assert_dispatchable(plan, assembled)
    missing = exc_info.value.data["missing"]
    assert "final_prompt" in missing
    assert "style_tags" in missing


def test_assert_dispatchable_accepts_valid_plan():
    plan = _valid_plan()
    assembled = plan_validator.assemble_dispatch_prompt(plan["final_prompt"], plan["negative"])
    plan_validator.assert_dispatchable(plan, assembled)  # 不抛异常即通过


def test_verbatim_path_keeps_user_words_and_still_enforces_aspect_and_negative():
    """verbatim 是「用户原话一字不改」的一期基线：不追加长度/风格词，但仍要 aspect 与负向段。"""
    plan = plan_validator.normalize_plan(
        {"final_prompt": "一只橘猫在窗台上晒太阳"}, _skills(), prompt_source="verbatim"
    )
    assert plan["source"] == "verbatim"
    assert plan["final_prompt"] == "一只橘猫在窗台上晒太阳", "一个字都不许改"
    assert plan["aspect"] in ASPECTS
    assert plan["negative"], "负向段仍然必须有（取技能默认值）"
    assembled = plan_validator.assemble_dispatch_prompt(plan["final_prompt"], plan["negative"])
    plan_validator.assert_dispatchable(plan, assembled)  # 不因长度 <40 被拒


def test_template_plan_is_always_dispatchable():
    """本地模板 / 兜底产出必须自己就满足 R06（否则等于把问题推给下游）。"""
    for text in ("做个图", "帮我弄好看点", TEXT):
        plan = plan_validator.normalize_plan(
            {"final_prompt": text}, _skills(), prompt_source="template"
        )
        assert len(plan["final_prompt"]) >= MIN_PROMPT_CHARS
        assert plan["aspect"] in ASPECTS
        assembled = plan_validator.assemble_dispatch_prompt(
            plan["final_prompt"], plan["negative"]
        )
        plan_validator.assert_dispatchable(plan, assembled)


# --------------------------------------------------------------------------- #
# 提示词拼装
# --------------------------------------------------------------------------- #
def test_assemble_dispatch_prompt_puts_negative_at_tail():
    """负向段必须在尾部，且用固定标记（R06 的校验对象就是它）。"""
    assembled = plan_validator.assemble_dispatch_prompt("主体描述" * 10, "模糊、畸变")
    assert assembled.endswith(f"{NEGATIVE_MARKER}模糊、畸变")
    assert "\n\n" in assembled


def test_assemble_dispatch_prompt_truncates_negative_not_body():
    """超长时优先截断负向段，保住主体（ADR-4）。"""
    body = "画" * (MAX_DISPATCH_PROMPT_CHARS - 20)
    assembled = plan_validator.assemble_dispatch_prompt(body, "模糊" * 200)
    assert len(assembled) <= MAX_DISPATCH_PROMPT_CHARS
    assert assembled.startswith(body), "主体不能被截断"
    assert NEGATIVE_MARKER in assembled


def test_empty_negative_adds_only_quality_suffix():
    """没有负向词时不追加空段，但平台内置画质词仍要补上。"""
    assembled = plan_validator.assemble_dispatch_prompt("主体", "")
    assert assembled.startswith("主体"), "用户内容必须原样在前"
    assert assembled.endswith(QUALITY_SUFFIX), "内置画质词追加在末尾"
    assert NEGATIVE_MARKER not in assembled, "空负向词不应产生半截标记"


def test_quality_suffix_is_not_repeated():
    """用户已经写了画质词时不再叠加内置画质词。"""
    body = "一只橘猫，超高清 8K 画质"
    assert plan_validator.assemble_dispatch_prompt(body, "") == body


# --------------------------------------------------------------------------- #
# 归一：业务层半成品 → 契约形状
# --------------------------------------------------------------------------- #
def test_normalize_plan_derives_size_from_aspect():
    """C1：`size` 是派生字段，只从 aspect 推，不允许两个字段各说一套。"""
    plan = plan_validator.normalize_plan(
        {"final_prompt": TEXT, "aspect": "9:16"}, _skills(), prompt_source="template"
    )
    assert plan["aspect"] == "9:16"
    assert plan["size"] == "1024x1536", "9:16 降级到 3:4 的上游尺寸"
    assert plan["schema_version"] == PLAN_SCHEMA_VERSION


def test_normalize_plan_fills_empty_prompt_from_skill_scaffold():
    """空提示词也要产出可派发的 plan：用技能骨架补全，而不是抛错或空着派发。"""
    plan = plan_validator.normalize_plan({"final_prompt": ""}, _skills(), prompt_source="template")
    assert plan["source"] == "template_fallback", "契约里没有 'template'，本地模板归到 template_fallback"
    assert plan["prompt_source"] == "template", "保留一期的 prompt_source，前端据此显示降级提示"
    assert len(plan["final_prompt"]) >= MIN_PROMPT_CHARS
    assembled = plan_validator.assemble_dispatch_prompt(plan["final_prompt"], plan["negative"])
    plan_validator.assert_dispatchable(plan, assembled)


def test_compose_option_drift_detection_keeps_option():
    """澄清方案不符合契约时**只记日志不丢弃**（丢一个方案 = 少一个方向）。"""
    options = compose_service._normalize_options(
        [
            {"id": "a", "label": "暖色调", "description": "温暖生活感", "prompt": "一张温暖的海报" * 3, "size": "1024x1536"},
            {"id": "b", "label": "冷色调", "description": "清冷高级", "prompt": "一张清冷的海报" * 3, "size": "1536x1024"},
        ]
    )
    assert len(options) == 2
    assert options[0]["aspect"] == "3:4"
    assert options[1]["aspect"] == "4:3"
    assert options[0]["size"] == "1024x1536", "一期字段必须保留（前端还在读）"
