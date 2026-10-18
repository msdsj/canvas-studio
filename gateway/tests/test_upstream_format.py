"""上游返回非 JSON / 格式异常：分类 → 重试 → 切换备用模型 → 如实报错。

这些用例锁住的行为，正是「中转站返回格式异常」暴露出来的三个问题：
1. 网页 / 空体 / 截断这类 200 响应不再被当成成功；
2. 格式异常会先原地重试，再换备用模型；
3. 只有「上游根本连不上」才降级为演示内容，格式异常必须如实报错。
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.services import resilience
from app.state import runtime_config
from app.utils.errors import ErrorCode
from app.utils.upstream_json import BodyKind, classify_body

HTML_PAGE = b"<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>oops</body></html>"
TRUNCATED_JSON = b'{"data": [{"b64_json": "AAAA'
BARE_LIST = b'["not", "an", "object"]'
GOOD_IMAGE = b'{"created": 1, "data": [{"b64_json": "QUJD"}]}'

_IMAGE_URL = "/gw/images/generations"
_CHAT_URL = "/gw/chat/completions"


@pytest.fixture
def restore_runtime():
    """用例会改运行时配置，结束必须还原，否则污染后续用例。"""
    keys = (
        "demo_mode",
        "image_model",
        "image_model_fallbacks",
        "text_model",
        "text_model_fallbacks",
    )
    saved = {key: getattr(runtime_config, key) for key in keys}
    yield
    for key, value in saved.items():
        setattr(runtime_config, key, value)


@pytest.fixture
def single_retry(monkeypatch):
    """把重试次数压到 1，既覆盖重试分支又不让用例等太久。"""
    monkeypatch.setattr(resilience.settings, "max_retries", 1, raising=False)


def _json(request: httpx.Request) -> dict:
    try:
        return json.loads(request.content.decode("utf-8", "ignore"))
    except ValueError:
        return {}


def _json_response(body: bytes) -> httpx.Response:
    return httpx.Response(200, content=body, headers={"content-type": "application/json"})


def _image_payload(prompt: str = "一只猫") -> dict:
    return {"prompt": prompt, "size": "64x64", "n": 1}


# --------------------------------------------------------------------------
# 响应体分类（纯函数，最快暴露「网页被当成 JSON」这类问题）
# --------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (GOOD_IMAGE, BodyKind.JSON_OBJECT),
        (b"", BodyKind.EMPTY),
        (b"   \n  ", BodyKind.EMPTY),
        (HTML_PAGE, BodyKind.HTML),
        (b"<html><body>gateway timeout</body></html>", BodyKind.HTML),
        (TRUNCATED_JSON, BodyKind.TRUNCATED),
        (BARE_LIST, BodyKind.NOT_OBJECT),
        (b"upstream exploded", BodyKind.NOT_JSON),
    ],
)
def test_classify_body(raw: bytes, expected: BodyKind):
    assert classify_body(raw) is expected


def test_classify_body_preview_is_bounded():
    """错误详情里的正文预览必须截断，不能把整页 HTML 灌进日志。"""
    from app.utils.upstream_json import body_preview

    assert len(body_preview(HTML_PAGE * 50)) <= 160


# --------------------------------------------------------------------------
# 生图链路
# --------------------------------------------------------------------------
async def test_html_body_reports_format_error_instead_of_demo(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    """上游返回网页 + demo=auto：必须如实报 UPSTREAM_FORMAT_ERROR，不能伪装成功。"""
    runtime_config.demo_mode = "auto"
    mock_upstream(lambda request: httpx.Response(200, content=HTML_PAGE))

    resp = await client.post(_IMAGE_URL, headers=headers, json=_image_payload())

    assert resp.status_code == 502
    body = resp.json()
    assert body["code"] == ErrorCode.UPSTREAM_FORMAT_ERROR.value
    assert body["data"]["body_kind"] == "html_body"


async def test_truncated_json_reports_format_error(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    """截断 JSON 与「压根不是 JSON」要能区分开。"""
    runtime_config.demo_mode = "off"
    mock_upstream(lambda request: httpx.Response(200, content=TRUNCATED_JSON))

    resp = await client.post(_IMAGE_URL, headers=headers, json=_image_payload())

    assert resp.status_code == 502
    assert resp.json()["data"]["body_kind"] == "truncated_json"


async def test_retries_and_recovers_on_second_attempt(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    """首次返回网页、重试即成功：用户不该看到任何错误。"""
    runtime_config.demo_mode = "off"
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, content=HTML_PAGE) if calls["n"] == 1 else _json_response(GOOD_IMAGE)

    mock_upstream(handler)
    resp = await client.post(_IMAGE_URL, headers=headers, json=_image_payload())

    assert resp.status_code == 200
    assert resp.json()["data"]["demo"] is False
    assert resp.json()["data"]["data"][0]["b64_json"] == "QUJD"
    assert calls["n"] == 2


async def test_switches_to_fallback_model_after_primary_exhausted(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    """主模型持续返回网页时，应切到备用模型并成功返回。"""
    runtime_config.demo_mode = "off"
    runtime_config.image_model = "primary-model"
    runtime_config.image_model_fallbacks = ["backup-model", "third-model"]
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        model = str(_json(request).get("model") or "")
        seen.append(model)
        return httpx.Response(200, content=HTML_PAGE) if model == "primary-model" else _json_response(GOOD_IMAGE)

    mock_upstream(handler)
    resp = await client.post(_IMAGE_URL, headers=headers, json=_image_payload())

    assert resp.status_code == 200
    assert resp.json()["data"]["demo"] is False
    # 主模型试了 (1 + max_retries) 次，然后才换到备用模型
    assert seen[:2] == ["primary-model", "primary-model"]
    assert seen[-1] == "backup-model"
    assert "third-model" not in seen


async def test_all_models_broken_reports_error_not_demo(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    """主备模型全坏：如实报错，不得降级成占位图。"""
    runtime_config.demo_mode = "auto"
    runtime_config.image_model = "primary-model"
    runtime_config.image_model_fallbacks = ["backup-model"]
    models: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        models.append(str(_json(request).get("model") or ""))
        return httpx.Response(200, content=HTML_PAGE)

    mock_upstream(handler)
    resp = await client.post(_IMAGE_URL, headers=headers, json=_image_payload())

    assert resp.status_code == 502
    assert resp.json()["code"] == ErrorCode.UPSTREAM_FORMAT_ERROR.value
    assert set(models) == {"primary-model", "backup-model"}


async def test_auth_failure_is_not_retried(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    """401 是 Key 配错，重试与换模型都没意义，应当只调一次就报错。"""
    runtime_config.demo_mode = "off"
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(401, content=b'{"error": "invalid key"}')

    mock_upstream(handler)
    resp = await client.post(_IMAGE_URL, headers=headers, json=_image_payload())

    assert resp.status_code == 502
    assert calls["n"] == 1


# --------------------------------------------------------------------------
# 对话链路
# --------------------------------------------------------------------------
async def test_chat_nonstream_non_json_reports_format_error(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    """对话非流式同样要拦住网页响应。"""
    runtime_config.demo_mode = "auto"
    mock_upstream(lambda request: httpx.Response(200, content=b"<html>nope</html>"))

    resp = await client.post(
        _CHAT_URL, headers=headers, json={"messages": [{"role": "user", "content": "你好"}]}
    )

    assert resp.status_code == 502
    assert resp.json()["code"] == ErrorCode.UPSTREAM_FORMAT_ERROR.value


async def test_chat_nonstream_recovers_after_retry(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    runtime_config.demo_mode = "off"
    calls = {"n": 0}
    # 中文必须先编码成字节：bytes 字面量只能装 ASCII，直接写中文是语法错误
    upstream_ok = json.dumps(
        {"choices": [{"message": {"role": "assistant", "content": "你好呀"}}]}
    ).encode("utf-8")

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return _json_response(upstream_ok) if calls["n"] > 1 else httpx.Response(200, content=b"")

    mock_upstream(handler)
    resp = await client.post(
        _CHAT_URL, headers=headers, json={"messages": [{"role": "user", "content": "你好"}]}
    )

    assert resp.status_code == 200
    assert resp.json()["data"]["choices"][0]["message"]["content"] == "你好呀"
    assert calls["n"] == 2


async def test_chat_stream_reports_error_when_all_models_broken(
    client, headers, mock_upstream, restore_runtime, single_retry
):
    """流式且一个字都没吐出来：应推一条 error_code 收尾，而不是静默装成功。"""
    runtime_config.demo_mode = "auto"
    mock_upstream(lambda request: httpx.Response(200, content=HTML_PAGE))

    resp = await client.post(
        _CHAT_URL,
        headers=headers,
        json={"stream": True, "messages": [{"role": "user", "content": "你好"}]},
    )

    assert resp.status_code == 200
    text = resp.text
    assert ErrorCode.UPSTREAM_FORMAT_ERROR.value in text
    assert "[DONE]" in text
    # 没有降级成演示内容
    assert "demo" not in text


def test_model_chain_dedupes_and_orders():
    """主模型 + 备用链：去重保序，空值剔除。"""
    runtime_config.image_model = "m1"
    runtime_config.image_model_fallbacks = ["m2", "m1", "  ", "m3"]
    try:
        assert runtime_config.model_chain("image") == ["m1", "m2", "m3"]
    finally:
        runtime_config.image_model = ""
        runtime_config.image_model_fallbacks = []
