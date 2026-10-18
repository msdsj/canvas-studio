"""运行时上游配置缓存（被 backend `POST /gw/config` 刷新，无需重启）。"""
from __future__ import annotations

import logging
import re
from typing import Any

from app.config import settings

logger = logging.getLogger("gateway.state")

#: role → RuntimeConfig 上的字段名（主模型 / 备用模型列表）
_PRIMARY_FIELDS: dict[str, str] = {"text": "text_model", "llm": "llm_model", "image": "image_model"}
_FALLBACK_FIELDS: dict[str, str] = {
    "text": "text_model_fallbacks",
    "llm": "llm_model_fallbacks",
    "image": "image_model_fallbacks",
}


def _split_models(raw: Any) -> list[str]:
    """解析模型名列表：接受 list 或逗号/空格分隔的字符串，去空去重且保序。"""
    items = raw if isinstance(raw, list) else re.split(r"[,\s]+", str(raw or ""))
    out: list[str] = []
    for item in items:
        name = str(item).strip()
        if name and name not in out:
            out.append(name)
    return out


class RuntimeConfig:
    """可变的运行时配置（内存缓存）。"""

    def __init__(self) -> None:
        self.text_base_url: str = settings.text_base_url
        self.text_api_key: str = settings.text_api_key
        self.text_model: str = settings.text_model
        self.text_model_fallbacks: list[str] = _split_models(settings.text_model_fallbacks)
        self.llm_base_url: str = settings.llm_base_url
        self.llm_api_key: str = settings.llm_api_key
        self.llm_model: str = settings.llm_model
        self.llm_model_fallbacks: list[str] = _split_models(settings.llm_model_fallbacks)
        self.image_base_url: str = settings.image_base_url
        self.image_api_key: str = settings.image_api_key
        self.image_model: str = settings.image_model
        self.image_model_fallbacks: list[str] = _split_models(settings.image_model_fallbacks)
        self.proxy_http: str = settings.http_proxy
        self.proxy_https: str = settings.https_proxy
        self.no_proxy: str = settings.no_proxy
        self.demo_mode: str = settings.demo_mode

    @property
    def proxy_url(self) -> str:
        """当前生效的代理地址。"""
        return self.proxy_https or self.proxy_http or ""

    def model_chain(self, role: str) -> list[str]:
        """主模型 + 备用模型组成的尝试链（去重保序，空值剔除）。

        主模型为空时（例如 llm 未单独配置）返回备用列表；两者都空则返回空列表，
        由调用方决定回落到哪个默认模型名。
        """
        primary = str(getattr(self, _PRIMARY_FIELDS.get(role, ""), "") or "")
        fallbacks = list(getattr(self, _FALLBACK_FIELDS.get(role, ""), []) or [])
        return _split_models([primary, *fallbacks])

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
        if "fallback_models" in text and text.get("fallback_models"):
            self.text_model_fallbacks = _split_models(text.get("fallback_models"))
        llm = payload.get("llm") or {}
        if "base_url" in llm:
            self.llm_base_url = str(llm.get("base_url") or "")
        if "api_key" in llm and llm.get("api_key"):
            self.llm_api_key = str(llm["api_key"])
        if "model" in llm:
            self.llm_model = str(llm.get("model") or "")
        if "fallback_models" in llm and llm.get("fallback_models"):
            self.llm_model_fallbacks = _split_models(llm.get("fallback_models"))
        if "base_url" in image:
            self.image_base_url = str(image.get("base_url") or "")
        if "api_key" in image and image.get("api_key"):
            self.image_api_key = str(image["api_key"])
        if "model" in image:
            self.image_model = str(image.get("model") or "")
        if "fallback_models" in image and image.get("fallback_models"):
            self.image_model_fallbacks = _split_models(image.get("fallback_models"))
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
            "text_model_fallbacks": list(self.text_model_fallbacks),
            "llm_base_url": self.llm_base_url,
            "llm_model": self.llm_model,
            "llm_model_fallbacks": list(self.llm_model_fallbacks),
            "llm_key_set": bool(self.llm_api_key),
            "image_key_set": bool(self.image_api_key),
            "image_model": self.image_model,
            "image_model_fallbacks": list(self.image_model_fallbacks),
        }


runtime_config = RuntimeConfig()
