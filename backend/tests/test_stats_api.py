"""统计接口测试：后台概览趋势 / 用量汇总 / 项目封面。

覆盖重点（这些点错了肉眼看不出来）：
- 趋势补零与长度：缺数据的天必须补 0，否则前端折线会断档；
- 切天时区：UTC 存储 + `+08:00` 切天，晚上 20:00 之后的事件不能算到「昨天」；
- `total_granted` 不能恒为 0（曾出现「余额 11504、累计获得 0」）；
- `balance_after` 必须是流水自带的余额快照，且与当前余额对得上；
- 没有图片元素的项目，`cover_url` 必须为 null 且不报错。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.quota import QuotaTransaction
from app.models.user import User
from app.utils.ids import new_id
from tests.conftest import register_and_activate

ADMIN_EMAIL = "admin@canvas.studio"
ADMIN_PASSWORD = "Admin@12345"


async def _admin_headers(client) -> dict[str, str]:
    resp = await client.post(
        "/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['data']['access_token']}"}


def _local_today():
    """独立算出本地日期（不调用被测代码，避免同源错掩盖偏移 bug）。"""
    return (datetime.now(timezone.utc) + timedelta(hours=8)).date()


async def _add_consume_tx(user_id: str, amount: int, created_at: datetime) -> int:
    """直接插一条消耗流水（用于构造跨天的历史数据）。

    按真实账本写法同时扣减余额并记录 `balance_after`，否则「余额 / 流水」
    本身就是矛盾的，测出来的数字没有意义。
    """
    async with AsyncSessionLocal() as db:
        user = (await db.execute(select(User).where(User.id == user_id))).scalar_one()
        user.balance -= amount
        balance_after = user.balance
        db.add(
            QuotaTransaction(
                id=new_id(),
                user_id=user_id,
                type="consume_image",
                amount=-amount,
                status="success",
                ref_id=new_id(),
                balance_after=balance_after,
                note="统计测试",
                created_at=created_at,
            )
        )
        await db.commit()
        return balance_after


# ---------------------------------------------------------------------------
# 后台概览
# ---------------------------------------------------------------------------
async def test_overview_series_14_days_with_zero_fill(client):
    """概览趋势固定 14 天，缺失日期补 0，最后一天是本地今天。"""
    headers = await _admin_headers(client)
    resp = await client.get("/api/admin/overview", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    # 原有字段保持向后兼容
    for key in ("users_total", "users_active", "pool", "quota_consumed_today"):
        assert key in data

    series = data["series"]
    assert len(series) == 14
    assert series[-1]["date"] == _local_today().isoformat()
    dates = [point["date"] for point in series]
    assert dates == sorted(dates)
    for point in series:
        assert set(point) == {"date", "users_new", "images", "quota"}
        assert all(isinstance(point[k], int) for k in ("users_new", "images", "quota"))
    # seed 出来的管理员是今天注册的 → 最后一天至少 1
    assert series[-1]["users_new"] >= 1
    # 卡片与趋势最后一天必须同源
    assert data["quota_consumed_today"] == series[-1]["quota"]


async def test_overview_recent_and_pending(client):
    """最近动态与待处理事项有真实数据，不是空壳。"""
    await register_and_activate(client, "recent@example.com")
    async with AsyncSessionLocal() as db:
        row = (
            await db.execute(select(User).where(User.email == "recent@example.com"))
        ).scalar_one()
        row.status = "pending_verification"
        await db.commit()

    headers = await _admin_headers(client)
    data = (await client.get("/api/admin/overview", headers=headers)).json()["data"]

    assert data["pending"]["users_pending_verification"] >= 1
    assert set(data["pending"]) == {
        "users_pending_verification",
        "pool_abnormal",
        "pool_limited",
    }

    recent = data["recent"]
    assert 1 <= len(recent) <= 6
    for item in recent:
        assert set(item) == {"at", "kind", "text"}
        assert item["kind"] in {"user", "quota", "pool", "audit"}
        assert item["text"]
        assert isinstance(item["at"], str) and "T" in item["at"]


async def test_overview_buckets_by_local_timezone(client):
    """UTC 存储按 +08:00 切天：本地昨天 23:30 的消耗不能算进今天。"""
    headers = await _admin_headers(client)
    async with AsyncSessionLocal() as db:
        admin = (
            await db.execute(select(User).where(User.email == ADMIN_EMAIL))
        ).scalar_one()
        admin_id = admin.id

    today_start_utc = datetime.combine(_local_today(), datetime.min.time()) - timedelta(hours=8)
    await _add_consume_tx(admin_id, 7, today_start_utc - timedelta(minutes=30))
    await _add_consume_tx(admin_id, 11, today_start_utc + timedelta(minutes=30))

    series = (await client.get("/api/admin/overview", headers=headers)).json()["data"]["series"]
    assert series[-2]["quota"] == 7
    assert series[-1]["quota"] == 11


# ---------------------------------------------------------------------------
# 用量汇总
# ---------------------------------------------------------------------------
async def test_quota_summary_total_granted_nonzero(client, auth_headers_factory):
    """累计获得来自真实流水：新用户 = 初始赠送，消耗后不再变化。"""
    token = await register_and_activate(client, "sum@example.com")
    headers = auth_headers_factory(token)

    resp = await client.get("/api/quota/summary", headers=headers)
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]

    assert data["balance"] == 200
    assert data["total_granted"] == 200  # 曾经是恒为 0 的占位值
    assert data["total_consumed"] == 0
    assert len(data["series"]) == 14
    assert data["series"][-1]["date"] == _local_today().isoformat()
    assert data["series"][-1]["granted"] == 200
    assert data["by_type"] == [
        {"type": "grant", "count": 1, "amount": 200, "abs_amount": 200}
    ]

    # 消耗一笔后：累计消耗增加，累计获得保持不变
    async with AsyncSessionLocal() as db:
        user = (
            await db.execute(select(User).where(User.email == "sum@example.com"))
        ).scalar_one()
        user_id = user.id
    await _add_consume_tx(user_id, 30, datetime.now(timezone.utc).replace(tzinfo=None))

    data = (await client.get("/api/quota/summary", headers=headers)).json()["data"]
    assert data["total_consumed"] == 30
    assert data["total_granted"] == 200
    assert data["series"][-1]["consumed"] == 30


async def test_quota_transactions_balance_after_matches_ledger(client, auth_headers_factory):
    """每笔流水都带 balance_after，且最新一笔等于当前余额。"""
    token = await register_and_activate(client, "tx@example.com")
    headers = auth_headers_factory(token)
    async with AsyncSessionLocal() as db:
        user = (
            await db.execute(select(User).where(User.email == "tx@example.com"))
        ).scalar_one()
        user_id = user.id
    await _add_consume_tx(user_id, 30, datetime.now(timezone.utc).replace(tzinfo=None))

    resp = await client.get("/api/quota/transactions", headers=headers)
    assert resp.status_code == 200, resp.text
    items = resp.json()["data"]["items"]
    assert len(items) == 2
    for item in items:
        assert isinstance(item["balance_after"], int)

    # 接口按时间倒序：第一条是最新的消耗
    assert items[0]["amount"] == -30
    assert items[1]["amount"] == 200
    # 余额快照与账户余额一致
    account = (await client.get("/api/quota/summary", headers=headers)).json()["data"]
    assert items[0]["balance_after"] == account["balance"]


async def test_quota_summary_counts_unrecorded_initial_balance(client):
    """历史初始余额没有流水时，「累计获得」也要等于余额（seed 管理员就是这种）。

    这是「余额 11504、累计获得 0」的真实成因：余额是直接写进 users 表的。
    纯流水口径会显示 0，所以这里取「流水入账」与「余额 + 消耗」的较大值。
    """
    async with AsyncSessionLocal() as db:
        user = User(
            id=new_id(),
            email="legacy@example.com",
            password_hash="x",
            status="active",
            role="user",
            balance=500,
        )
        db.add(user)
        await db.commit()
        from app.services import usage_stats_service

        summary = await usage_stats_service.quota_summary(db, user)
    assert summary["total_granted"] == 500
    assert summary["by_type"] == []


async def test_quota_summary_requires_login(client):
    """未登录访问汇总 → 401。"""
    resp = await client.get("/api/quota/summary")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 项目封面 / 元素数
# ---------------------------------------------------------------------------
async def test_project_cover_url_and_item_count(client, auth_headers_factory):
    """项目列表带封面图与元素数；没有图片元素时 cover_url 为 null 且不报错。"""
    from app.models.asset import Asset

    token = await register_and_activate(client, "cover@example.com")
    headers = auth_headers_factory(token)
    async with AsyncSessionLocal() as db:
        owner = (
            await db.execute(select(User).where(User.email == "cover@example.com"))
        ).scalar_one()
        owner_id = owner.id
        asset = Asset(
            id=new_id(),
            owner_id=owner_id,
            kind="generated",
            url="http://127.0.0.1:27181/static/u/2026/10/full.png",
            thumb_url="http://127.0.0.1:27181/static/u/2026/10/thumb.jpg",
        )
        db.add(asset)
        await db.commit()
        asset_id = asset.id

    created = await client.post("/api/projects", json={"name": "有图项目"}, headers=headers)
    project_id = created.json()["data"]["id"]
    detail = await client.get(f"/api/projects/{project_id}", headers=headers)
    canvas_id = detail.json()["data"]["canvases"][0]["id"]

    elements = [
        {"id": "el-img", "type": "image", "fileId": "f1", "customData": {"assetId": asset_id}},
        {"id": "el-text", "type": "text", "text": "标题"},
        {"id": "el-gone", "type": "rectangle", "isDeleted": True},
    ]
    patched = await client.patch(
        f"/api/canvases/{canvas_id}", json={"state": {"elements": elements}}, headers=headers
    )
    assert patched.status_code == 200, patched.text

    await client.post("/api/projects", json={"name": "空项目"}, headers=headers)
    listing = (await client.get("/api/projects", headers=headers)).json()["data"]["items"]
    by_name = {item["name"]: item for item in listing}

    with_image = by_name["有图项目"]
    assert with_image["cover_url"] == "http://127.0.0.1:27181/static/u/2026/10/thumb.jpg"
    # 已删除元素不计入元素数
    assert with_image["item_count"] == 2

    empty = by_name["空项目"]
    assert empty["cover_url"] is None
    assert empty["item_count"] == 0
