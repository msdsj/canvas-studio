"""后端 → 网关客户端：统一走 `/gw/*`（`X-Internal-Token` 鉴权）。

网关响应统一包裹 `{code,data,message}`；本客户端负责解包并按错误码抛出 `AppError`。
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.config import settings
from app.utils.errors import AppError, ErrorCode
from app.utils.logging import get_logger

logger = get_logger("app.gateway_client")

# 网关错误码 → 业务错误码兜底映射
_CODE_ALIASES: dict[str, ErrorCode] = {
    "PROXY_UNREACHABLE": ErrorCode.PROXY_UNREACHABLE,
    "UPSTREAM_ERROR": ErrorCode.UPSTREAM_ERROR,
    "POOL_UNAVAILABLE": ErrorCode.POOL_UNAVAILABLE,
    "UNAUTHORIZED": ErrorCode.UNAUTHORIZED,
    "FORBIDDEN": ErrorCode.FORBIDDEN,
    "VALIDATION_ERROR": ErrorCode.VALIDATION_ERROR,
    "NOT_FOUND": ErrorCode.NOT_FOUND,
}


class GatewayClient:
    """网关 HTTP 客户端。"""

    def __init__(self) -> None:
        self._base_url = settings.gateway_base_url.rstrip("/")
        self._token = settings.gateway_internal_token
        self._timeout = httpx.Timeout(
            connect=settings.gw_connect_timeout,
            read=settings.gw_read_timeout,
            write=settings.gw_read_timeout,
            pool=settings.gw_connect_timeout,
        )

    def _headers(self) -> dict[str, str]:
        return {"X-Internal-Token": self._token, "Accept": "application/json"}

    def _client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._base_url, timeout=self._timeout)

    @staticmethod
    def _unwrap(response: httpx.Response) -> Any:
        """解包网关响应，非 OK 抛 AppError。"""
        try:
            body = response.json()
        except Exception as exc:  # noqa: BLE001
            raise AppError(ErrorCode.UPSTREAM_ERROR, "网关返回非 JSON 响应") from exc
        # 先确认这是网关自己的信封。网关所有正常响应都带 `code`；缺了就说明拿到的是
        # FastAPI 原生错误体（例如 422 的 {"detail": ...}）。以前这里把缺 code 当成 OK、
        # 顺手返回 data=None，于是「配置推送被 422 拒绝」在日志里只显示成一句成功。
        if not isinstance(body, dict) or "code" not in body:
            raise AppError(
                ErrorCode.UPSTREAM_ERROR,
                "网关返回了非预期结构",
                data={"status": response.status_code, "body": str(body)[:300]},
            )
        code = str(body.get("code", "OK"))
        if code == "OK":
            return body.get("data")
        mapped = _CODE_ALIASES.get(code, ErrorCode.UPSTREAM_ERROR)
        # 不转发网关/上游的 message（可能含「上游返回 500」这类内部描述），只用错误码映射默认文案
        raise AppError(mapped, None, data=body.get("data"))

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        files: list[tuple[str, tuple[str, bytes, str]]] | None = None,
        data: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> Any:
        async with self._client() as client:
            try:
                response = await client.request(
                    method,
                    path,
                    headers=self._headers(),
                    json=json_body,
                    files=files,
                    data=data,
                    params=params,
                )
            except httpx.ConnectError as exc:
                raise AppError(ErrorCode.PROXY_UNREACHABLE, "无法连接网关服务") from exc
            except httpx.TimeoutException as exc:
                raise AppError(ErrorCode.UPSTREAM_ERROR, "网关请求超时") from exc
        return self._unwrap(response)

    # ---- 配置 / 健康 ----
    async def push_config(self, payload: dict[str, Any]) -> dict[str, Any]:
        """推送运行时配置到网关。"""
        return await self._request("POST", "/gw/config", json_body=payload)

    async def upstream_health(self) -> dict[str, Any]:
        """探测上游健康（区分 VPN / 上游故障）。"""
        return await self._request("GET", "/gw/upstream/health")

    async def config_test(self, target: str) -> dict[str, Any]:
        """连通性测试。"""
        return await self._request("POST", "/gw/config/test", json_body={"target": target})

    async def health(self) -> dict[str, Any]:
        """网关存活探测。"""
        async with self._client() as client:
            response = await client.get("/gw/health", headers=self._headers())
        return self._unwrap(response)

    # ---- 对话 ----
    async def chat_completions(self, payload: dict[str, Any]) -> dict[str, Any]:
        """非流式对话。"""
        return await self._request("POST", "/gw/chat/completions", json_body=payload)

    async def llm_completions(self, payload: dict[str, Any]) -> dict[str, Any]:
        """调用独立的意图分析模型中转。"""
        return await self._request("POST", "/gw/chat/llm-completions", json_body=payload)

    async def chat_completions_stream(
        self, payload: dict[str, Any]
    ) -> AsyncIterator[bytes]:
        """流式对话（SSE 逐块透传，原始字节）。"""
        body = {**payload, "stream": True}
        async with self._client() as client:
            async with client.stream(
                "POST", "/gw/chat/completions", headers=self._headers(), json=body
            ) as response:
                if response.status_code >= 400:
                    raw = await response.aread()
                    # 上游原始 body（HTML 错误页 / JSON / 堆栈）只进日志，绝不进用户文案
                    logger.warning(
                        "流式对话失败 status=%s body=%s",
                        response.status_code,
                        raw[:500].decode("utf-8", "ignore"),
                    )
                    raise AppError(ErrorCode.UPSTREAM_ERROR, "这次没能回复出来，请再试一次")
                async for chunk in response.aiter_bytes():
                    if chunk:
                        yield chunk

    # ---- 生图 / 编辑 ----
    async def image_generations(self, payload: dict[str, Any]) -> dict[str, Any]:
        """文生图转发。"""
        return await self._request("POST", "/gw/images/generations", json_body=payload)

    async def image_edits(
        self,
        files: list[tuple[str, tuple[str, bytes, str]]],
        form: dict[str, Any],
    ) -> dict[str, Any]:
        """图生图/编辑转发（multipart）。"""
        return await self._request("POST", "/gw/images/edits", files=files, data=form)

    # ---- 号池 ----
    async def pool_list(self) -> dict[str, Any]:
        """列出号池账号。"""
        return await self._request("GET", "/gw/pool/accounts")

    async def pool_import(
        self, tokens: list[str], accounts: list[dict[str, Any]]
    ) -> dict[str, Any]:
        """导入账号。"""
        return await self._request(
            "POST", "/gw/pool/accounts", json_body={"tokens": tokens, "accounts": accounts}
        )

    async def pool_delete(self, tokens: list[str]) -> dict[str, Any]:
        """删除账号。"""
        return await self._request("DELETE", "/gw/pool/accounts", json_body={"tokens": tokens})

    async def pool_refresh(self, tokens: list[str] | None) -> dict[str, Any]:
        """刷新额度，返回 {job_id}。"""
        return await self._request(
            "POST", "/gw/pool/accounts/refresh", json_body={"tokens": tokens or []}
        )

    async def pool_refresh_progress(self, job_id: str) -> dict[str, Any]:
        """刷新进度。"""
        return await self._request("GET", f"/gw/pool/accounts/refresh/{job_id}")

    async def pool_relogin(self, tokens: list[str]) -> dict[str, Any]:
        """重新登录，返回 {job_id}。"""
        return await self._request(
            "POST", "/gw/pool/accounts/re-login", json_body={"tokens": tokens}
        )

    async def pool_relogin_progress(self, job_id: str) -> dict[str, Any]:
        """重登进度。"""
        return await self._request("GET", f"/gw/pool/accounts/re-login/{job_id}")

    async def pool_update(self, payload: dict[str, Any]) -> dict[str, Any]:
        """更新账号。"""
        return await self._request("POST", "/gw/pool/accounts/update", json_body=payload)

    async def pool_export(self, tokens: list[str], fmt: str) -> httpx.Response:
        """导出账号文件流（返回原始响应）。"""
        async with self._client() as client:
            return await client.post(
                "/gw/pool/accounts/export",
                headers=self._headers(),
                json={"tokens": tokens, "format": fmt},
            )

    async def pool_oauth_start(self, email_hint: str) -> dict[str, Any]:
        """OAuth 起始。"""
        return await self._request(
            "POST", "/gw/pool/accounts/oauth/start", json_body={"email_hint": email_hint}
        )

    async def pool_oauth_finish(self, session_id: str, callback: str) -> dict[str, Any]:
        """OAuth 完成。"""
        return await self._request(
            "POST",
            "/gw/pool/accounts/oauth/finish",
            json_body={"session_id": session_id, "callback": callback},
        )


gateway_client = GatewayClient()
