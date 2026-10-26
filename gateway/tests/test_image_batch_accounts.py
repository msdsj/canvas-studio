"""One independent account per analyzed image output, including mixed edits."""
from __future__ import annotations

import asyncio
import json
import time

import httpx
import pytest

from app.services import image_router, resilience
from app.services.account_pool import account_pool
from app.state import runtime_config
from app.utils.errors import ErrorCode, GatewayError


@pytest.fixture(autouse=True)
def live_images(monkeypatch):
    monkeypatch.setattr(runtime_config, "demo_mode", "off")
    monkeypatch.setattr(runtime_config, "image_model_fallbacks", [])


def _payload(index: int, total: int = 2, batch: str = "batch") -> dict:
    return {
        "prompt": f"output {index}", "n": 1,
        "pool_batch_id": batch, "pool_task_id": f"task-{index}", "pool_batch_total": total,
    }


async def _seed(count: int):
    await account_pool.import_accounts([f"key-{index}" for index in range(count)], [])


async def test_batch_reserves_all_accounts_before_first_request_finishes():
    await _seed(2)
    first = await account_pool.acquire_image(batch_id="batch", task_id="one", batch_total=2)
    await account_pool.release_image(first["id"], batch_id="batch", task_id="one")
    # The first task already finished before the second even starts.  Its
    # account must remain reserved rather than being reused for its sibling.
    assert await account_pool.select(kind="image") is None
    second = await account_pool.acquire_image(batch_id="batch", task_id="two", batch_total=2)
    assert first["id"] != second["id"]
    await account_pool.release_image(second["id"], batch_id="batch", task_id="two")
    assert all(item["in_flight"] == 0 for item in await account_pool.list())
    assert await account_pool.select(kind="image") is not None


async def test_strict_batch_rotation_can_use_unstarted_or_external_slot():
    """失败换号不能被同批次尚未启动的预留账号挡住。"""
    await _seed(3)
    first = await account_pool.acquire_image(
        batch_id="rotate-batch", task_id="one", batch_total=2, strict=True
    )
    assert first is not None
    replacement = await account_pool.rotate_image(
        first["id"], batch_id="rotate-batch", task_id="one", batch_total=2
    )
    assert replacement is not None
    assert replacement["id"] != first["id"]
    second = await account_pool.acquire_image(
        batch_id="rotate-batch", task_id="two", batch_total=2, strict=True
    )
    assert second is not None
    assert second["id"] not in {first["id"], replacement["id"]}
    await account_pool.release_image(replacement["id"], batch_id="rotate-batch", task_id="one")
    await account_pool.release_image(second["id"], batch_id="rotate-batch", task_id="two")
    assert all(item["in_flight"] == 0 for item in await account_pool.list())


async def test_strict_rotation_transfers_sibling_slot_without_reusing_its_account():
    """池子刚好 2 个号时，重试可接管兄弟号，但兄弟任务不能重复占它。"""
    await _seed(2)
    first = await account_pool.acquire_image(
        batch_id="rotate-tight", task_id="one", batch_total=2, strict=True
    )
    assert first is not None
    await account_pool.mark_failure(first["id"], "quota exhausted")
    replacement = await account_pool.rotate_image(
        first["id"], batch_id="rotate-tight", task_id="one", batch_total=2
    )
    assert replacement is not None
    assert replacement["id"] != first["id"]
    with pytest.raises(GatewayError) as info:
        await account_pool.acquire_image(
            batch_id="rotate-tight", task_id="two", batch_total=2, strict=True
        )
    assert info.value.code == ErrorCode.POOL_UNAVAILABLE
    assert account_pool._batches["rotate-tight"]["tasks"]["one"] == replacement["id"]
    await account_pool.release_image(
        replacement["id"], batch_id="rotate-tight", task_id="one"
    )
    assert all(item["in_flight"] == 0 for item in await account_pool.list())


async def test_batch_degrades_to_upstream_dispatch_when_accounts_are_insufficient():
    """账号不够时不再整批拒绝：一个账号独立路由，剩余任务交给上游调度。"""
    await _seed(1)
    first = await account_pool.acquire_image(batch_id="batch", task_id="one", batch_total=2)
    second = await account_pool.acquire_image(batch_id="batch", task_id="two", batch_total=2)
    assert first is not None
    assert second is None, "第 2 个任务应退化为上游默认取号"
    await account_pool.release_image(first["id"], batch_id="batch", task_id="one")
    await account_pool.release_image("", batch_id="batch", task_id="two")
    assert (await account_pool.list())[0]["in_flight"] == 0
    assert account_pool._batches["batch"]["done"] == {"one", "two"}


async def test_strict_batch_rejects_insufficient_local_accounts_without_fallback():
    """编排批次不能把缺少的独立账号静默降级到共享 provider。"""
    await _seed(1)
    with pytest.raises(GatewayError) as info:
        await account_pool.acquire_image(
            batch_id="strict-batch", task_id="one", batch_total=2, strict=True
        )
    assert info.value.code == ErrorCode.POOL_UNAVAILABLE
    assert "strict-batch" not in account_pool._batches


async def test_strict_batch_rejects_empty_local_pool_without_fallback():
    """严格批次不能在本地池为空时静默交给共享 provider。"""
    with pytest.raises(GatewayError) as info:
        await account_pool.acquire_image(
            batch_id="strict-empty", task_id="one", batch_total=2, strict=True
        )
    assert info.value.code == ErrorCode.POOL_UNAVAILABLE
    assert "strict-empty" not in account_pool._batches


async def test_expired_abandoned_batch_releases_unstarted_siblings():
    await _seed(2)
    first = await account_pool.acquire_image(batch_id="batch", task_id="one", batch_total=2)
    # Active requests must never lose their reservation to a TTL sweep.
    account_pool._batches["batch"]["expires_at"] = time.time() - 1
    assert await account_pool.select(kind="image") is None
    await account_pool.release_image(first["id"], batch_id="batch", task_id="one")
    account_pool._batches["batch"]["expires_at"] = time.time() - 1
    assert await account_pool.select(kind="image") is not None
    assert "batch" not in account_pool._batches


async def test_duplicate_batch_task_does_not_acquire_another_account():
    await _seed(2)
    first = await account_pool.acquire_image(batch_id="batch", task_id="one", batch_total=2)
    with pytest.raises(GatewayError) as info:
        await account_pool.acquire_image(batch_id="batch", task_id="one", batch_total=2)
    assert info.value.code == ErrorCode.VALIDATION_ERROR
    await account_pool.release_image(first["id"], batch_id="batch", task_id="one")
    with pytest.raises(GatewayError):
        await account_pool.acquire_image(batch_id="batch", task_id="one", batch_total=2)


async def test_generation_and_edit_use_distinct_accounts_without_leaking_metadata(
    client, headers, mock_upstream,
):
    await _seed(2)
    arrived = asyncio.Event()
    seen: list[tuple[str, str]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        assert b"pool_batch" not in request.content and b"pool_task" not in request.content
        seen.append((request.url.path, request.headers["Authorization"]))
        if len(seen) == 2:
            arrived.set()
        await asyncio.wait_for(arrived.wait(), timeout=2)
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    mock_upstream(handler)
    generated, edited = await asyncio.gather(
        client.post("/gw/images/generations", headers=headers, json=_payload(1)),
        client.post(
            "/gw/images/edits", headers=headers,
            data={key: str(value) for key, value in _payload(2).items()},
            files={"image": ("original.png", b"source", "image/png")},
        ),
    )
    assert generated.status_code == edited.status_code == 200
    assert {path for path, _ in seen} == {"/images/generations", "/images/edits"}
    assert len({key for _, key in seen}) == 2
    assert all(item["in_flight"] == 0 for item in await account_pool.list())


async def test_edit_forwards_transparent_png_options(client, headers, mock_upstream):
    seen = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    mock_upstream(handler)
    response = await client.post(
        "/gw/images/edits",
        headers=headers,
        data={
            "prompt": "remove the background",
            "model": "gpt-image-2",
            "background": "transparent",
            "output_format": "png",
        },
        files={"image": ("base.png", b"image-data", "image/png")},
    )
    assert response.status_code == 200, response.text
    assert len(seen) == 1 and seen[0].url.path == "/images/edits"
    assert b'name="background"\r\n\r\ntransparent' in seen[0].content
    assert b'name="output_format"\r\n\r\npng' in seen[0].content


async def test_retry_keeps_original_task_account_and_preserves_sibling_reservation(
    client, headers, mock_upstream, monkeypatch,
):
    await _seed(2)
    monkeypatch.setattr(resilience.settings, "max_retries", 1)
    seen: dict[str, list[str]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        prompt = json.loads(request.content)["prompt"]
        seen.setdefault(prompt, []).append(request.headers["Authorization"])
        if prompt == "output 1" and len(seen[prompt]) == 1:
            return httpx.Response(200, text="<html>try again</html>")
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    mock_upstream(handler)
    # Deliberately sequential: timing must not be what provides isolation.
    first = await client.post("/gw/images/generations", headers=headers, json=_payload(1))
    second = await client.post("/gw/images/generations", headers=headers, json=_payload(2))
    assert first.status_code == second.status_code == 200
    assert len(seen["output 1"]) == 2
    assert seen["output 1"][0] == seen["output 1"][1]
    assert seen["output 1"][0] != seen["output 2"][0]


async def test_empty_remote_pool_is_scheduled_by_upstream(client, headers, mock_upstream):
    """本地号池为空时，批次任务交给上游自己的号池轮询，而不是直接判失败。"""
    calls: list = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    mock_upstream(handler)
    response = await client.post("/gw/images/generations", headers=headers, json=_payload(1))
    assert response.status_code == 200
    assert len(calls) == 1


async def test_upstream_managed_batch_fans_out_nonstrict_requests_concurrently(
    client, headers, mock_upstream,
):
    """没有本地凭据时，批次仍拆成独立 n=1 请求交给上游号池并发调度。"""
    arrived = asyncio.Event()
    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content)["prompt"])
        if len(calls) == 2:
            arrived.set()
        await asyncio.wait_for(arrived.wait(), timeout=2)
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    mock_upstream(handler)
    first, second = await asyncio.gather(
        client.post("/gw/images/generations", headers=headers, json=_payload(1)),
        client.post("/gw/images/generations", headers=headers, json=_payload(2)),
    )
    assert first.status_code == second.status_code == 200
    assert calls == ["output 1", "output 2"]


async def test_sync_quota_error_falls_back_to_upstream_task_queue(client, headers, mock_upstream, monkeypatch):
    """同步接口没空闲账号时，转上游任务队列排队出图，而不是直接失败。"""
    monkeypatch.setattr(resilience.settings, "max_retries", 0)
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.url.path)
        if request.url.path == "/images/generations":
            return httpx.Response(429, json={"error": {"message": "no available image quota"}})
        if request.url.path == "/api/image-tasks/generations":
            return httpx.Response(200, json={"id": "task-1", "status": "running"})
        if request.url.path == "/api/image-tasks":
            return httpx.Response(
                200,
                json={
                    "items": [
                        {
                            "id": "task-1",
                            "status": "success",
                            "data": [{"b64_json": "QUJD"}],
                        }
                    ]
                },
            )
        return httpx.Response(404)

    mock_upstream(handler)
    response = await client.post("/gw/images/generations", headers=headers, json=_payload(1))
    assert response.status_code == 200, response.text
    assert response.json()["data"]["data"][0]["b64_json"] == "QUJD"
    assert "/api/image-tasks/generations" in seen
    assert "/images/generations" in seen


async def test_pool_failure_rotates_to_another_account(client, headers, mock_upstream, monkeypatch):
    """首个账号报号池/额度错误后，应换号重试，而不是在同一账号上打转。"""
    await _seed(2)
    monkeypatch.setattr(resilience.settings, "max_retries", 0)
    seen: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request.headers["Authorization"])
        if len(seen) == 1:
            return httpx.Response(503, json={"error": "no available image quota"})
        return httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]})

    mock_upstream(handler)
    response = await client.post("/gw/images/generations", headers=headers, json=_payload(1, total=1))
    assert response.status_code == 200
    assert len(seen) == 2
    assert seen[0] != seen[1], "重试必须落在另一个账号上"
    assert all(item["in_flight"] == 0 for item in await account_pool.list())


async def test_single_output_keeps_configured_provider_compatibility(client, headers, mock_upstream):
    mock_upstream(lambda request: httpx.Response(200, json={"data": [{"b64_json": "QUJD"}]}))
    response = await client.post("/gw/images/generations", headers=headers, json=_payload(1, total=1))
    assert response.status_code == 200


async def test_busy_pool_cannot_fall_back_to_shared_provider_key(client, headers, mock_upstream):
    await _seed(1)
    await account_pool.select(kind="image")
    await account_pool.select(kind="image")
    calls: list = []
    mock_upstream(lambda request: calls.append(request))
    response = await client.post("/gw/images/generations", headers=headers, json={"prompt": "legacy"})
    assert response.status_code == 503
    assert response.json()["code"] == "POOL_UNAVAILABLE"
    assert calls == []


async def test_cancelled_image_request_releases_active_lease(mock_upstream):
    await _seed(2)
    started = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        started.set()
        await asyncio.Event().wait()
        raise AssertionError("unreachable")

    mock_upstream(handler)
    task = asyncio.create_task(image_router.image_generations(_payload(1)))
    await asyncio.wait_for(started.wait(), timeout=2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert all(item["in_flight"] == 0 for item in await account_pool.list())
    assert not account_pool._batches["batch"]["active"]


async def test_twelve_outputs_have_twelve_distinct_credentials():
    await _seed(12)
    accounts = await asyncio.gather(*(
        account_pool.acquire_image(batch_id="batch", task_id=f"task-{index}", batch_total=12)
        for index in range(12)
    ))
    assert len({item["id"] for item in accounts}) == 12


async def test_capacity_excludes_busy_and_reserved_accounts_without_exposing_credentials(client, headers):
    await _seed(3)
    first = await account_pool.acquire_image(batch_id="batch", task_id="one", batch_total=2)
    response = await client.get("/gw/pool/capacity", headers=headers)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["total"] == data["healthy"] == 3
    assert data["available"] == 1 and data["reserved"] == 2
    assert data["scope"] == "local" and data["independent_routing"] is True
    assert "access_token" not in response.text and "key-" not in response.text
    await account_pool.release_image(first["id"], batch_id="batch", task_id="one")
    # Unstarted sibling reservations remain excluded from the capacity snapshot.
    assert (await account_pool.image_capacity())["available"] == 1


async def test_batch_metadata_requires_one_output_per_credential(client, headers, mock_upstream):
    await _seed(2)
    calls: list = []
    mock_upstream(lambda request: calls.append(request))
    response = await client.post(
        "/gw/images/generations", headers=headers, json={**_payload(1), "n": 2},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"
    assert calls == []
    assert all(item["in_flight"] == 0 for item in await account_pool.list())


@pytest.mark.parametrize("endpoint", ["generations", "edits"])
@pytest.mark.parametrize("mode", ["on", "auto"])
async def test_planned_batch_never_reports_demo_image_success(
    client, headers, mock_upstream, monkeypatch, endpoint, mode,
):
    await _seed(2)
    monkeypatch.setattr(runtime_config, "demo_mode", mode)
    monkeypatch.setattr(resilience.settings, "max_retries", 0)
    calls: list[str] = []

    def unreachable(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        raise httpx.ConnectError("simulated provider outage")

    mock_upstream(unreachable)
    body = _payload(1)
    if endpoint == "generations":
        response = await client.post("/gw/images/generations", headers=headers, json=body)
    else:
        response = await client.post(
            "/gw/images/edits", headers=headers,
            data={key: str(value) for key, value in body.items()},
            files={"image": ("original.png", b"source", "image/png")},
        )
    assert response.status_code >= 400
    result = response.json()
    assert result["code"] != "OK" and result["data"] is None
    assert "b64_json" not in response.text and '"demo":true' not in response.text
    assert result["code"] == ErrorCode.PROXY_UNREACHABLE.value
    assert calls == [f"/images/{endpoint}"]
    assert all(item["in_flight"] == 0 for item in await account_pool.list())
