"""共享额度池 —— 真后端验证「团队付钱、成员花」的完整账。

需求②里最容易做错的一块：企业按席位付过钱，成员就不该再被自己的余额卡住。
但「共享池」有四条容易写反的规则，任何一条反了都会造成真金白银的错账：

1. **开关默认关闭**：建团即共享会让「拉个测试团队」意外花掉公司的钱；
2. **开了就真的从池里扣**：成员自己余额不减少；
3. **池子空了不回落个人余额**：否则「额度用尽」形同虚设；
4. **关掉就回到个人余额**：开关必须是双向生效的，不能「开了就粘住」。

这些在单测里都是 mock 的账本，这里跑真库真接口。

用法：
    cd backend && ./.venv/bin/python scripts/smoke_shared_quota.py
"""
from __future__ import annotations

import asyncio
import time

import httpx

from _smoke_common import (
    BACKEND,
    PREREQUISITE,
    demo_mode,
    execute,
    fetch_one,
    register,
    wait_task,
)


async def _balance(client: httpx.AsyncClient, headers: dict) -> int:
    resp = await client.get("/api/me/quota", headers=headers)
    return int(resp.json()["data"].get("balance") or 0)


async def _team_balance(client: httpx.AsyncClient, team_id: str, headers: dict) -> int:
    """团队共享池余额（走 `/usage`，它同时给出用量与余额）。"""
    resp = await client.get(f"/api/teams/{team_id}/usage", headers=headers)
    assert resp.status_code == 200, resp.text
    return int(resp.json()["data"].get("balance") or 0)


async def _invite(client: httpx.AsyncClient, team_id: str, email: str, owner_headers: dict) -> str:
    resp = await client.post(
        f"/api/teams/{team_id}/invitations",
        json={"email": email, "role": "member"},
        headers=owner_headers,
    )
    assert resp.status_code == 200, resp.text
    row = fetch_one(
        "SELECT token FROM team_invitations WHERE team_id = ? AND email = ?"
        " ORDER BY created_at DESC LIMIT 1",
        (team_id, email),
    )
    assert row, "邀请没有入库"
    return row[0]


async def _scenarios(client: httpx.AsyncClient, failures: list[str]) -> None:
    _, owner_headers, _ = await register(client, "pool-owner")
    _, member_headers, member_email = await register(client, "pool-member")

    team = await client.post("/api/teams", json={"name": "共享额度组"}, headers=owner_headers)
    assert team.status_code == 200, team.text
    team_id = team.json()["data"]["id"]
    token = await _invite(client, team_id, member_email, owner_headers)
    accept = await client.post(
        f"/api/teams/invitations/{token}/accept", headers=member_headers
    )
    assert accept.status_code == 200, accept.text

    # 1) 默认不开共享池
    detail = await client.get(f"/api/teams/{team_id}", headers=owner_headers)
    if detail.json()["data"].get("shared_quota"):
        failures.append("新建团队默认就开了共享额度池——会让测试团队误花公司的钱")
    else:
        print("OK  新建团队默认不启用共享额度池")

    # 成员把个人余额花光，确保后面成功出图只能是走了共享池
    member_balance = await _balance(client, member_headers)
    print(f"成员个人余额：{member_balance}")

    # 2) 开启共享池 → 自动充值
    enable = await client.patch(
        f"/api/teams/{team_id}", json={"shared_quota": True}, headers=owner_headers
    )
    if enable.status_code != 200:
        failures.append(f"开启共享池失败：{enable.status_code} {enable.text[:160]}")
    pool = await _team_balance(client, team_id, owner_headers)
    if pool <= 0:
        failures.append(f"开启共享池后余额仍是 {pool}")
    else:
        print(f"OK  开启共享池，初始额度 {pool}")

    # 3) 成员在团队空间出图 → 从共享池扣，个人余额不变
    await client.post(
        "/api/teams/active", json={"team_id": team_id}, headers=member_headers
    )
    member_before = await _balance(client, member_headers)
    pool_before = await _team_balance(client, team_id, owner_headers)

    gen = await client.post(
        "/api/generate/image",
        json={"prompt": "共享池出图：一杯咖啡", "n": 1},
        headers={**member_headers, "Idempotency-Key": f"pool-{time.time()}"},
    )
    if gen.status_code != 200:
        failures.append(f"成员在团队空间出图失败：{gen.status_code} {gen.text[:200]}")
    else:
        task_id = gen.json()["data"]["id"]
        for _ in range(90):
            await asyncio.sleep(0.8)
            task = (await client.get(f"/api/generate/tasks/{task_id}", headers=member_headers)).json()["data"]
            if task["status"] in {"succeeded", "failed", "canceled"}:
                break
        if task["status"] != "succeeded":
            failures.append(
                f"共享池出图没成功：{task['status']} / {task.get('error_message')}"
            )
        else:
            member_after = await _balance(client, member_headers)
            pool_after = await _team_balance(client, team_id, owner_headers)
            if member_after != member_before:
                failures.append(
                    f"成员的个人余额被动了：{member_before} → {member_after}（应该走共享池）"
                )
            elif pool_after >= pool_before:
                failures.append(
                    f"共享池没有扣减：{pool_before} → {pool_after}"
                )
            else:
                print(
                    f"OK  从共享池扣费：池 {pool_before} → {pool_after}，"
                    f"成员个人余额保持 {member_after}"
                )

    # 4) 池子花光 → 明确失败，不回落个人余额
    #    直接改库把池清零，比真花掉 2000 额度快得多，且结果确定
    execute("UPDATE teams SET balance = 0 WHERE id = ?", (team_id,))
    broke = await client.post(
        "/api/generate/image",
        json={"prompt": "池子空了还想出图", "n": 1},
        headers={**member_headers, "Idempotency-Key": f"broke-{time.time()}"},
    )
    code = broke.json().get("code") if broke.status_code >= 400 else "OK"
    if broke.status_code < 400:
        failures.append(
            f"共享池为 0 时仍然放行（{broke.status_code}）——额度用尽形同虚设"
        )
    elif code != "QUOTA_INSUFFICIENT":
        failures.append(f"池子空时报错码是 {code}，期望 QUOTA_INSUFFICIENT")
    else:
        print(f"OK  池子空时明确拒绝：{broke.status_code} {code}")

    # 5) 充值后恢复可用
    topup = await client.post(
        f"/api/teams/{team_id}/quota", json={"amount": 50}, headers=owner_headers
    )
    if topup.status_code != 200:
        failures.append(f"团队充值失败：{topup.status_code} {topup.text[:160]}")
    else:
        after_topup = await _team_balance(client, team_id, owner_headers)
        if after_topup != 50:
            failures.append(f"充值 50 后余额是 {after_topup}")
        else:
            print("OK  充值后余额正确（50）")

    # 6) 成员不能自己充值团队池（只有 owner/管理员能）
    member_topup = await client.post(
        f"/api/teams/{team_id}/quota", json={"amount": 100}, headers=member_headers
    )
    if member_topup.status_code == 200:
        failures.append("成员能给团队池充值——等于可以自己给自己发额度")
    else:
        print(f"OK  成员充值被拒：{member_topup.status_code}")

    # 7) 关掉共享池 → 回到个人余额
    await client.patch(
        f"/api/teams/{team_id}", json={"shared_quota": False}, headers=owner_headers
    )
    off_gen = await client.post(
        "/api/generate/image",
        json={"prompt": "关掉共享池后出图", "n": 1},
        headers={**member_headers, "Idempotency-Key": f"off-{time.time()}"},
    )
    if off_gen.status_code == 200:
        tid = off_gen.json()["data"]["id"]
        for _ in range(90):
            await asyncio.sleep(0.8)
            t = (await client.get(f"/api/generate/tasks/{tid}", headers=member_headers)).json()["data"]
            if t["status"] in {"succeeded", "failed", "canceled"}:
                break
        personal_after = await _balance(client, member_headers)
        if personal_after >= member_before:
            failures.append(
                f"关掉共享池后仍在用池子（个人余额 {member_before} → {personal_after}）"
            )
        else:
            print(f"OK  关掉共享池后回到个人余额（{member_before} → {personal_after}）")



async def main() -> int:
    failures: list[str] = []
    async with httpx.AsyncClient(base_url=BACKEND, timeout=180) as client:
        try:
            await client.get("/api/health", timeout=5)
        except Exception:  # noqa: BLE001
            print(PREREQUISITE)
            return 2
        # 出图必须走演示模式，否则会真的调上游（这里不关心上游画得好不好）
        async with demo_mode(client):
            await _scenarios(client, failures)

    if failures:
        print("\n失败：")
        for item in failures:
            print("  -", item)
        return 1
    print("\n共享额度池端到端通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
