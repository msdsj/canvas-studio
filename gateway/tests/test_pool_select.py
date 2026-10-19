"""号池选择：并发请求要摊到不同账号上（最少占用优先，轮询打破平局）。"""
from __future__ import annotations

from app.services.account_pool import account_pool


async def _seed(count: int) -> None:
    await account_pool.import_accounts([f"key-{i}" for i in range(count)], [])


async def test_concurrent_selects_spread_over_distinct_accounts():
    await _seed(3)
    picked = [await account_pool.select(kind="image") for _ in range(3)]
    assert len({item["id"] for item in picked}) == 3, "3 个并发请求应落到 3 个不同账号"


async def test_least_loaded_wins_after_release():
    await _seed(2)
    first = await account_pool.select(kind="image")
    second = await account_pool.select(kind="image")
    await account_pool.release(first["id"])
    third = await account_pool.select(kind="image")
    assert third["id"] == first["id"], "释放后的空闲账号优先于仍在占用的账号"
    assert second["id"] != first["id"]


async def test_full_pool_returns_none():
    await _seed(1)
    assert await account_pool.select(kind="image")
    assert await account_pool.select(kind="image")  # max_concurrency 默认 2
    assert await account_pool.select(kind="image") is None


async def test_persisted_in_flight_is_reset_on_load():
    record = account_pool._normalize({"access_token": "k", "in_flight": 5})
    assert record["in_flight"] == 0
