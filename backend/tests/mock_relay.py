"""可注入故障的假上游（仅测试用）。

为什么需要它
------------
R01 要求「上游返回网页 / 空体 / 截断 / 顶层非 dict / 5xx / 超时」六类故障下仍能
完成任务。用真实中转站测不了，用 `unittest.mock` 又会把「HTTP 层」也一起 mock 掉，
测不出 `_post_capped` / 响应头 / 状态码的真实路径。所以起一个真的 HTTP 服务，
按脚本逐次吐出不同的响应体。

用法::

    with FakeUpstream() as upstream:
        upstream.script("deepseek-chat", HTML, ok('{"a": 1}'))
        target = build_target_from_draft(
            base_url=upstream.base_url, api_key="k", model="deepseek-chat"
        )
        outcome = await chat_resilient(None, "u1", messages, target=target)

    upstream.calls  # [{"model": ..., "max_tokens": ..., "temperature": ...}, ...]
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

#: 200 + 网关首页（最常见的「地址填成了网站首页」）
HTML: dict[str, Any] = {"kind": "html"}
#: 200 + 0 字节
EMPTY: dict[str, Any] = {"kind": "empty"}
#: 200 + 被截断的 JSON（`Unterminated string`）
TRUNCATED: dict[str, Any] = {"kind": "truncated"}
#: 200 + 顶层是数组
NOT_OBJECT: dict[str, Any] = {"kind": "not_object"}
#: 200 + 标准响应体但正文为空、finish_reason=stop
NO_CONTENT: dict[str, Any] = {"kind": "no_content"}
#: 200 + 正文为空、finish_reason=length（token 被思考过程吃光）
TRUNCATED_OUTPUT: dict[str, Any] = {"kind": "truncated_output"}
#: 200 + 顶层只有 error（上游明确拒绝）
REFUSED: dict[str, Any] = {"kind": "refused"}


def ok(content: str = '{"ok": true}') -> dict[str, Any]:
    """一次正常响应（正文由调用方指定）。"""
    return {"kind": "ok", "content": content}


def status(code: int, message: str = "boom") -> dict[str, Any]:
    """一次错误状态码响应。"""
    return {"kind": "status", "code": code, "message": message}


def raw(body: bytes) -> dict[str, Any]:
    """原样吐出一段字节（用于「纯文本而非 JSON」这类场景）。"""
    return {"kind": "raw", "body": body}


class _Handler(BaseHTTPRequestHandler):
    """按脚本响应的最小 OpenAI 兼容端点。"""

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(length) or b"{}"
        try:
            body = json.loads(payload.decode("utf-8", "ignore"))
        except (ValueError, TypeError):
            body = {}
        model = str(body.get("model") or "")
        # 上游实例挂在 server 上：多个假上游并行时互不串台
        upstream = self.server.upstream  # type: ignore[attr-defined]
        upstream.calls.append(
            {
                "model": model,
                "max_tokens": body.get("max_tokens"),
                "temperature": body.get("temperature"),
                "json_mode": "response_format" in body,
                "path": self.path,
            }
        )
        behavior = upstream.next_behavior(model)
        code, ctype, content = _render(behavior)
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def log_message(self, *args: Any) -> None:
        """静音：测试输出里不需要 HTTP 访问日志。"""
        return


def _render(behavior: dict[str, Any]) -> tuple[int, str, bytes]:
    """把一个 behavior 渲染成 `(status, content-type, body)`。"""
    kind = behavior.get("kind")
    if kind == "html":
        return 200, "text/html; charset=utf-8", b"<!doctype html><html><body>gateway</body></html>"
    if kind == "empty":
        return 200, "application/json", b""
    if kind == "truncated":
        return 200, "application/json", b'{"choices": [{"message": {"content": "abc'
    if kind == "not_object":
        return 200, "application/json", b"[1, 2, 3]"
    if kind == "raw":
        return 200, "text/plain; charset=utf-8", bytes(behavior.get("body") or b"")
    if kind == "refused":
        return 200, "application/json", json.dumps({"error": {"message": "refused"}}).encode()
    if kind == "no_content":
        payload = {"choices": [{"message": {"content": ""}, "finish_reason": "stop"}]}
        return 200, "application/json", json.dumps(payload).encode()
    if kind == "truncated_output":
        payload = {"choices": [{"message": {"content": ""}, "finish_reason": "length"}]}
        return 200, "application/json", json.dumps(payload).encode()
    if kind == "status":
        code = int(behavior.get("code") or 500)
        payload = {"error": {"message": str(behavior.get("message") or "boom")}}
        return code, "application/json", json.dumps(payload).encode()
    content = str(behavior.get("content") or "")
    payload = {"choices": [{"message": {"role": "assistant", "content": content}, "finish_reason": "stop"}]}
    return 200, "application/json", json.dumps(payload).encode()


class FakeUpstream:
    """一个可脚本化的假中转站。

    Attributes:
        calls: 收到的请求（按到达顺序），用于断言重试次数 / 参数调整。
    """

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self._plans: dict[str, list[dict[str, Any]]] = {}
        self._default: list[dict[str, Any]] = [ok()]
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self._server.upstream = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    # -- 生命周期 ----------------------------------------------------------- #
    def start(self) -> FakeUpstream:
        """在后台线程启动服务。"""
        self._thread.start()
        return self

    def stop(self) -> None:
        """停止服务并释放端口。"""
        self._server.shutdown()
        self._server.server_close()

    def __enter__(self) -> FakeUpstream:
        return self.start()

    def __exit__(self, *exc_info: Any) -> None:
        self.stop()

    # -- 脚本 --------------------------------------------------------------- #
    def script(self, model: str, *behaviors: dict[str, Any]) -> FakeUpstream:
        """给某个模型排一串响应（按调用顺序消费，用完后重复最后一个）。"""
        self._plans[model] = list(behaviors)
        return self

    def script_default(self, *behaviors: dict[str, Any]) -> FakeUpstream:
        """未单独脚本化的模型走这里。"""
        self._default = list(behaviors)
        return self

    def next_behavior(self, model: str) -> dict[str, Any]:
        """取该模型的下一个脚本响应（脚本用完后重复最后一个）。"""
        plan = self._plans.get(model) or self._default
        if not plan:
            return ok()
        return plan.pop(0) if len(plan) > 1 else plan[0]

    # -- 断言辅助 ----------------------------------------------------------- #
    @property
    def base_url(self) -> str:
        """可直接填进 `build_target_from_draft` 的地址。"""
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def calls_for(self, model: str) -> list[dict[str, Any]]:
        """某个模型收到的请求。"""
        return [item for item in self.calls if item["model"] == model]

    @property
    def models_called(self) -> list[str]:
        """按到达顺序的模型名（含重复）。"""
        return [str(item["model"]) for item in self.calls]
