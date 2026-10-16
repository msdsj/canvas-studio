"""运行时上游配置缓存（被 backend `POST /gw/config` 刷新，无需重启）。"""
from __future__ import annotations

import logging
from typing import Any

from app.config import settings

logger = logging.getLogger("gateway.state")


class RuntimeConfig:
    """可变的运行时配置（内存缓存）。"""

    def __init__(self) -> None:
        self.sub2api_base_url: str = settings.sub2api_base_url
        self.sub2api_api_key: str = settings.sub2api_api_key
        self.chatgpt2api_base_url: str = settings.chatgpt2api_base_url
        self.chatgpt2api_admin_key: str = settings.chatgpt2api_admin_key
        self.proxy_http: str = settings.http_proxy
        self.proxy_https: str = settings.https_proxy
        self.no_proxy: str = settings.no_proxy
        self.demo_mode: str = settings.demo_mode

    @property
    def proxy_url(self) -> str:
        """当前生效的代理地址。"""
        return self.proxy_https or self.proxy_http or ""

    def update(self, payload: dict[str, Any]) -> None:
        """按 backend 推送的 payload 更新配置。"""
        sub = payload.get("sub2api") or {}
        cg2 = payload.get("chatgpt2api") or {}
        proxy = payload.get("proxy") or {}
        if sub.get("base_url"):
            self.sub2api_base_url = str(sub["base_url"])
        if sub.get("api_key"):
            self.sub2api_api_key = str(sub["api_key"])
        if cg2.get("base_url"):
            self.chatgpt2api_base_url = str(cg2["base_url"])
        if cg2.get("admin_key"):
            self.chatgpt2api_admin_key = str(cg2["admin_key"])
        if "http_proxy" in proxy:
            self.proxy_http = str(proxy.get("http_proxy") or "")
        if "https_proxy" in proxy:
            self.proxy_https = str(proxy.get("https_proxy") or "")
        demo = payload.get("demo_mode")
        if demo in {"auto", "on", "off"}:
            self.demo_mode = demo
        logger.info(
            "运行时配置已更新：sub2api=%s chatgpt2api=%s demo=%s",
            self.sub2api_base_url,
            self.chatgpt2api_base_url,
            self.demo_mode,
        )

    def snapshot(self) -> dict[str, Any]:
        """返回当前配置快照（不含密钥明文）。"""
        return {
            "sub2api_base_url": self.sub2api_base_url,
            "chatgpt2api_base_url": self.chatgpt2api_base_url,
            "demo_mode": self.demo_mode,
            "proxy_enabled": bool(self.proxy_url),
            "sub2api_key_set": bool(self.sub2api_api_key),
            "chatgpt2api_key_set": bool(self.chatgpt2api_admin_key),
        }


runtime_config = RuntimeConfig()
