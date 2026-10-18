"""上游响应体解析：把「网页 / 空体 / 非 JSON / 截断 / 顶层非对象」归一为可读错误。

为什么必须单独抽出来：网关原先在 5 处直接 `resp.json()`。上游把网页、半截报文或纯文本
按 200 返回时，抛出的 JSONDecodeError 会被泛化的 `except Exception` 吞成 UPSTREAM_ERROR——
而 UPSTREAM_ERROR 属于 auto 模式的可降级错误，于是「格式坏了」在用户眼里变成「已经画好了」。
这里把格式问题独立分类，使它可重试、可换备用模型，最终对用户如实报错。
"""
from __future__ import annotations

import json
from enum import Enum
from typing import Any

import httpx

from app.utils.errors import ErrorCode, GatewayError

#: 正文预览保留的字符数：够定位问题，又不会把整页 HTML 灌进日志 / 错误详情
_BODY_PREVIEW_CHARS = 160

_HTML_HINTS = (b"<!doctype", b"<html", b"<head", b"<body")


class BodyKind(str, Enum):
    """响应体形态。命名与 backend `relay_types.FailureKind` 对齐，便于两边读日志。"""

    JSON_OBJECT = "json_object"
    EMPTY = "empty_body"
    HTML = "html_body"
    NOT_JSON = "not_json"
    TRUNCATED = "truncated_json"
    NOT_OBJECT = "not_object"


_MESSAGES: dict[BodyKind, str] = {
    BodyKind.EMPTY: "上游返回了空响应，已自动重试",
    BodyKind.HTML: "上游返回的是一张网页，接口地址可能填成了网站首页",
    BodyKind.NOT_JSON: "上游返回的内容不是可用的数据格式",
    BodyKind.TRUNCATED: "上游返回的数据被截断了",
    BodyKind.NOT_OBJECT: "上游返回的数据结构不对，换一个模型再试",
}


def classify_body(raw: bytes) -> BodyKind:
    """识别响应体形态（优先级：空 → 网页 → JSON 可解析 → 截断/非 JSON）。"""
    stripped = raw.strip()
    if not stripped:
        return BodyKind.EMPTY
    if any(hint in stripped[:512].lower() for hint in _HTML_HINTS):
        return BodyKind.HTML
    try:
        parsed: Any = json.loads(stripped.decode("utf-8", "ignore"))
    except ValueError:
        # `{` / `[` 开头却没有正常收尾 → 更可能是「被截断」而不是「根本不是 JSON」，
        # 两者的处置方式不同（前者值得调大 max_tokens / 重试，后者应直接换模型）。
        if stripped[:1] in (b"{", b"[") and stripped[-1:] not in (b"}", b"]"):
            return BodyKind.TRUNCATED
        return BodyKind.NOT_JSON
    return BodyKind.JSON_OBJECT if isinstance(parsed, dict) else BodyKind.NOT_OBJECT


def body_preview(raw: bytes) -> str:
    """截断后的正文预览，挂在错误详情与日志上，便于定位上游究竟返回了什么。"""
    return raw[:_BODY_PREVIEW_CHARS].decode("utf-8", "ignore")


def parse_json_body(resp: httpx.Response) -> dict[str, Any]:
    """安全解析上游 JSON 响应体。

    格式异常时抛 `UPSTREAM_FORMAT_ERROR`（可重试、可换备用模型），
    绝不返回半成品，也绝不让它退化成「成功」。
    """
    raw = resp.content
    kind = classify_body(raw)
    if kind is not BodyKind.JSON_OBJECT:
        raise GatewayError(
            ErrorCode.UPSTREAM_FORMAT_ERROR,
            _MESSAGES[kind],
            data={"body_kind": kind.value, "body_preview": body_preview(raw)},
        )
    return json.loads(raw.decode("utf-8", "ignore"))


def check_stream_prefix(prefix: bytes) -> None:
    """流式转发前先验一次「开头的字节」。

    流式路径不能靠状态码兜底：上游把网页按 200 推下来时，如果不先看开头，
    那张 HTML 会被原样当成 SSE 塞给浏览器，前端的 SSE 解析器拿到一堆乱码，
    用户看到的是「转了半天没反应」。

    只验开头是有意的——正规 SSE 的首字节必然是 `data:`，与 `<`（网页）不会混淆，
    因此这一步零误伤、也零额外延迟（不需要攒满缓冲才敢往下发）。
    """
    probe = prefix.lstrip(b"\xef\xbb\xbf").lstrip()
    if not probe:
        return
    if probe[:1] == b"<":
        raise GatewayError(
            ErrorCode.UPSTREAM_FORMAT_ERROR,
            _MESSAGES[BodyKind.HTML],
            data={"body_kind": BodyKind.HTML.value, "body_preview": body_preview(prefix)},
        )
    if probe[:1] == b"{":
        # 有些中转站用 HTTP 200 包一份 {"error": ...}。它不是可用的流，值得重试 / 换模型。
        try:
            parsed: Any = json.loads(probe.decode("utf-8", "ignore"))
        except ValueError:
            return  # 半截 JSON 帧，交给前端 SSE 解析器处理
        if isinstance(parsed, dict) and parsed.get("error"):
            raise GatewayError(
                ErrorCode.UPSTREAM_ERROR,
                "上游返回了错误，已自动重试",
                data={"upstream_error": str(parsed["error"])[:200]},
                retryable=True,
                switch_model=True,
            )
