#!/usr/bin/env python3
"""模拟上游 chatgpt2api（用于端到端验证）。

关键点：**故意返回 JPEG**，用来验证后端「所有 AI 生成图片统一 PNG 输出」的归一化逻辑
真的生效（而不是只依赖上游格式）。
"""
from __future__ import annotations

import base64
import io
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from PIL import Image

HOST, PORT = "127.0.0.1", 3000


def jpeg_b64(width: int = 1024, height: int = 1024) -> str:
    """生成一张 JPEG（非 PNG），返回 base64。"""
    img = Image.new("RGB", (width, height), (180, 60, 60))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return base64.b64encode(buf.getvalue()).decode()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):  # noqa: D102 - 静默
        pass

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    def do_GET(self):  # noqa: N802
        if self.path.startswith("/health"):
            self._send(200, {"status": "ok"})
            return
        self._send(404, {"error": "not found"})

    def do_POST(self):  # noqa: N802
        self._read_body()
        if self.path.startswith("/v1/images/generations"):
            self._send(200, {"created": 1, "data": [{"b64_json": jpeg_b64()}]})
            return
        if self.path.startswith("/v1/images/edits"):
            self._send(200, {"created": 1, "data": [{"b64_json": jpeg_b64(768, 768)}]})
            return
        if self.path.startswith("/v1/chat/completions"):
            self._send(
                200,
                {
                    "id": "mock",
                    "object": "chat.completion",
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": "模拟回复"}}],
                },
            )
            return
        self._send(404, {"error": "not found"})


def serve() -> None:
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    print(f"mock upstream on http://{HOST}:{PORT} (returns JPEG)")
    threading.Thread(target=serve, daemon=True).start()
    threading.Event().wait()
