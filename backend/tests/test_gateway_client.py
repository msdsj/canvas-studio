"""GatewayClient 解包 / 错误映射单测（不发起真实网络）。"""
from __future__ import annotations

import httpx
import pytest

from app.services.gateway_client import GatewayClient
from app.utils.errors import AppError, ErrorCode


def _resp(status: int, body: dict) -> httpx.Response:
    """构造带 request 的 httpx.Response。"""
    return httpx.Response(status, json=body, request=httpx.Request("GET", "http://gw"))


def test_unwrap_ok():
    """OK 包裹返回 data。"""
    data = GatewayClient._unwrap(_resp(200, {"code": "OK", "data": {"a": 1}, "message": "ok"}))
    assert data == {"a": 1}


def test_unwrap_upstream_error():
    """UPSTREAM_ERROR 映射为 502 业务异常。"""
    with pytest.raises(AppError) as exc:
        GatewayClient._unwrap(_resp(502, {"code": "UPSTREAM_ERROR", "data": None, "message": "boom"}))
    assert exc.value.code == ErrorCode.UPSTREAM_ERROR
    assert exc.value.status_code == 502


def test_unwrap_pool_unavailable():
    """POOL_UNAVAILABLE 映射为 503。"""
    with pytest.raises(AppError) as exc:
        GatewayClient._unwrap(_resp(503, {"code": "POOL_UNAVAILABLE", "data": None, "message": "no pool"}))
    assert exc.value.code == ErrorCode.POOL_UNAVAILABLE
    assert exc.value.status_code == 503


def test_unwrap_proxy_unreachable():
    """PROXY_UNREACHABLE 映射为 503。"""
    with pytest.raises(AppError) as exc:
        GatewayClient._unwrap(_resp(503, {"code": "PROXY_UNREACHABLE", "data": None, "message": "vpn"}))
    assert exc.value.code == ErrorCode.PROXY_UNREACHABLE


def test_unwrap_unknown_code_defaults_upstream():
    """未知错误码兜底为 UPSTREAM_ERROR。"""
    with pytest.raises(AppError) as exc:
        GatewayClient._unwrap(_resp(500, {"code": "SOMETHING_WEIRD", "data": None, "message": "?"}))
    assert exc.value.code == ErrorCode.UPSTREAM_ERROR
