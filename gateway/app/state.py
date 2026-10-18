"""运行时上游配置缓存（被 backend `POST /gw/config` 刷新，无需重启）。"""
from __future__ import annotations

import logging
from typing import Any

from app.config import settings

logger = logging.getLogger("gateway.state")


class RuntimeConfig:
    """可变的运行时配置（内存缓存）。"""

    def __init__(self) -> None:
        self.text_base_url: str = settings.text_base_url
        self.text_api_key: str = settings.text_api_key
        self.text_model: str = settings.text_model
        self.llm_base_url: str = settings.llm_base_url
        self.llm_api_key: str = settings.llm_api_key
        self.llm_model: str = settings.llm_model
        self.image_base_url: str = settings.image_base_url
        self.image_api_key: str = settings.image_api_key
        self.image_model: str = settings.image_model
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
        text = payload.get("text") or {}
        image = payload.get("image") or {}
        proxy = payload.get("proxy") or {}
        if "base_url" in text:
            self.text_base_url = str(text.get("base_url") or "")
        if "api_key" in text and text.get("api_key"):
            self.text_api_key = str(text["api_key"])
        if "model" in text:
            self.text_model = str(text.get("model") or "")
        llm = payload.get("llm") or {}
        if "base_url" in llm:
            self.llm_base_url = str(llm.get("base_url") or "")
        if "api_key" in llm and llm.get("api_key"):
            self.llm_api_key = str(llm["api_key"])
        if "model" in llm:
            self.llm_model = str(llm.get("model") or "")
        if "base_url" in image:
            self.image_base_url = str(image.get("base_url") or "")
        if "api_key" in image and image.get("api_key"):
            self.image_api_key = str(image["api_key"])
        if "model" in image:
            self.image_model = str(image.get("model") or "")
        if "http_proxy" in proxy:
            self.proxy_http = str(proxy.get("http_proxy") or "")
        if "https_proxy" in proxy:
            self.proxy_https = str(proxy.get("https_proxy") or "")
        demo = payload.get("demo_mode")
        if demo in {"auto", "on", "off"}:
            self.demo_mode = demo
        logger.info(
            "运行时配置已更新：text=%s image=%s demo=%s",
            self.text_base_url,
            self.image_base_url,
            self.demo_mode,
        )

    def snapshot(self) -> dict[str, Any]:
        """返回当前配置快照（不含密钥明文）。"""
        return {
            "text_base_url": self.text_base_url,
            "image_base_url": self.image_base_url,
            "demo_mode": self.demo_mode,
            "proxy_enabled": bool(self.proxy_url),
            "text_key_set": bool(self.text_api_key),
            "text_model": self.text_model,
            "llm_base_url": self.llm_base_url,
            "llm_model": self.llm_model,
            "llm_key_set": bool(self.llm_api_key),
            "image_key_set": bool(self.image_api_key),
            "image_model": self.image_model,
        }


runtime_config = RuntimeConfig()
