"""生图全流程端到端 —— 真后端 + 真网关 + 真图片模型 + 真落盘。

为什么必须跑这个：生图这条链上有 5 个服务接力（generate_service → 网关
→ 图片解码 → 存储 → 资产入库），单测全部 mock 掉，任何一环接错都发现不了：

* 网关返回的 b64 解不出来 → 任务变成 failed，但单测里是假数据所以看不出来；
* 扣了额度但图没存下来 → 用户被白扣一次；
* 重试接口拿到的参数是旧快照 → 重试出来的图和原需求不一致。

脚本会调用已配置的真实图片模型并产生额度消耗；`DEMO_MODE` 只控制模拟对话，不影响图片生成。

前置：
    cd gateway && ./.venv/bin/python -m uvicorn app.main:app --port 27182
    cd backend && ./.venv/bin/python -m uvicorn app.main:app --port 27181

用法：
    cd backend && ./.venv/bin/python scripts/smoke_generation_flow.py
"""
from __future__ import annotations

import asyncio
import sqlite3
import time
from pathlib import Path

import httpx

BACKEND = "http://127.0.0.1:27181"
GATEWAY = "http://127.0.0.1:27182"
PASS = "Passw0rd123"
DB = Path(__file__).resolve().parents[1] / "data" / "canvas_studio.db"


async def _login(client: httpx.AsyncClient) -> tuple[str, dict]:
    email = f"gen-{int(time.time())}@example.com"
    reg = await client.post("/api/auth/register", json={"email": email, "password": PASS})
    assert reg.status_code == 200, reg.text
    conn = sqlite3.connect(str(DB))
    try:
        conn.execute("UPDATE users SET role = 'pro' WHERE email = ?", (email,))
        conn.commit()
    finally:
        conn.close()
    login = await client.post("/api/auth/login", json={"email": email, "password": PASS})
    token = login.json()["data"]["access_token"]
    return token, {"Authorization": f"Bearer {token}"}


async def _wait_task(client, headers, task_id: str, timeout: float = 90.0) -> dict:
    """轮询到终态。"""
    deadline = time.time() + timeout
    last = {}
    while time.time() < deadline:
        resp = await client.get(f"/api/generate/tasks/{task_id}", headers=headers)
        last = resp.json()["data"]
        if last["status"] in {"succeeded", "failed", "canceled"}:
            return last
        await asyncio.sleep(0.8)
    return last


async def main() -> int:
    failures: list[str] = []

    async with httpx.AsyncClient(base_url=BACKEND, timeout=120) as client:
        token, headers = await _login(client)

        return await _run_flow(client, headers)


async def _run_flow(client: httpx.AsyncClient, headers: dict) -> int:
    """验证图片任务经过真实 provider 的生成链路。"""
    failures: list[str] = []


    before = (await client.get("/api/me/quota", headers=headers)).json()["data"]
    print(f"起始额度：{before.get('balance')}")

    # 1) 文生图：创建 → 轮询 → 成功
    created = await client.post(
        "/api/generate/image",
        json={
            "prompt": "一只橘猫坐在窗台上，午后阳光，胶片质感",
            "model": "gpt-image-2",
            "size": "1024x1024",
            "n": 1,
        },
        headers={**headers, "Idempotency-Key": f"smoke-{time.time()}"},
    )
    if created.status_code != 200:
        print(f"创建任务失败：{created.status_code} {created.text[:200]}")
        return 1
    task = created.json()["data"]
    print(f"任务已创建：{task['id']}（状态 {task['status']}）")

    done = await _wait_task(client, headers, task["id"])
    if done["status"] != "succeeded":
        failures.append(
            f"任务没有成功：{done['status']} / {done.get('error_code')} {done.get('error_message')}"
        )
    else:
        print(f"任务成功，产出 {len(done.get('result_urls') or [])} 张图")

    images = done.get("result_urls") or []
    if not images:
        failures.append("任务成功了但没有图片")
    else:
        # 2) 图片真的能取到（存储层真的写了文件）
        first = images[0] if isinstance(images[0], str) else images[0].get("url")
        fetched = await client.get(first if first.startswith("http") else f"{BACKEND}{first}")
        if fetched.status_code != 200:
            failures.append(f"图片取不到：{first} → {fetched.status_code}")
        elif len(fetched.content) < 1000:
            failures.append(f"图片内容太小（{len(fetched.content)} 字节），可能是坏图")
        else:
            print(f"图片可访问：{len(fetched.content)} 字节，{fetched.headers.get('content-type')}")

    # 3) 资产入库
    assets = await client.get("/api/assets?page=1&size=10&kind=generated", headers=headers)
    items = assets.json()["data"]["items"]
    if not items:
        failures.append("生成了图但没有进入资产库")
    else:
        print(f"资产库已有 {len(items)} 条，最新：{items[0].get('id')[:8]}")

    # 4) 额度真的扣了（且只扣一次）
    after = (await client.get("/api/me/quota", headers=headers)).json()["data"]
    spent = (before.get("balance") or 0) - (after.get("balance") or 0)
    if spent <= 0:
        failures.append(f"生图没有扣额度（{before.get('balance')} → {after.get('balance')}）")
    else:
        print(f"扣费正确：-{spent}（余额 {after.get('balance')}）")

    # 5) 重试语义：
    #    a) 已经成功的任务**不该**被重试（否则用户手滑就白扣一次额度）
    #    b) 真正失败/取消的任务才克隆成新任务，参数原样带过去，且幂等
    guard = await client.post(
        f"/api/generate/tasks/{task['id']}/retry",
        headers={**headers, "Idempotency-Key": f"retry-bad-{time.time()}"},
    )
    if guard.status_code != 409 or guard.json().get("code") != "TASK_STATE_CONFLICT":
        failures.append(
            f"成功任务被允许重试了（{guard.status_code} {guard.text[:120]}）——会白扣额度"
        )
    else:
        print("重试守卫正确：成功的任务拒绝重试（409）")

    # 造一个「已失败」的任务来验克隆路径。
    #
    # 为什么不真等一次失败：演示模式下出图必然成功，真去等上游失败既慢又不稳。
    # 这里直接把一条已完成的任务标成 failed——重试接口关心的是「状态是否可重试」，
    # 失败**原因**由单测覆盖。这样前置条件是确定的，不会因为抢跑而跳过。
    doomed = await client.post(
        "/api/generate/image",
        json={"prompt": "这条会被标成失败用于验证重试", "n": 1},
        headers={**headers, "Idempotency-Key": f"doomed-{time.time()}"},
    )
    doomed_id = doomed.json()["data"]["id"]
    await _wait_task(client, headers, doomed_id, timeout=60)
    conn = sqlite3.connect(str(DB))
    try:
        conn.execute(
            "UPDATE generation_tasks SET status = 'failed', error_code = 'UPSTREAM_ERROR',"
            " error_message = '冒烟脚本注入的失败' WHERE id = ?",
            (doomed_id,),
        )
        conn.commit()
    finally:
        conn.close()
    failed_task = await client.get(f"/api/generate/tasks/{doomed_id}", headers=headers)
    canceled_task = failed_task.json()["data"]
    if canceled_task["status"] != "failed":
        failures.append(f"注入失败状态没生效：{canceled_task['status']}")
    else:
        retried = await client.post(
            f"/api/generate/tasks/{doomed_id}/retry",
            headers={**headers, "Idempotency-Key": f"retry-{doomed_id}"},
        )
        if retried.status_code != 200:
            failures.append(f"取消后的重试失败：{retried.status_code} {retried.text[:200]}")
        else:
            clone = retried.json()["data"]
            if clone["id"] == doomed_id:
                failures.append("重试返回了同一个任务 id（应该是新任务）")
            elif clone.get("prompt") != canceled_task.get("prompt"):
                failures.append(f"重试的提示词变了：{clone.get('prompt')!r}")
            else:
                print(f"重试已克隆：{clone['id'][:8]}，参数一致")

            again = await client.post(
                f"/api/generate/tasks/{doomed_id}/retry",
                headers={**headers, "Idempotency-Key": f"retry-{doomed_id}"},
            )
            if again.status_code == 200 and again.json()["data"]["id"] != clone["id"]:
                failures.append("同一幂等键重试产生了两个任务")
            else:
                print("重试幂等：同一 key 只建一个任务")
            await _wait_task(client, headers, clone["id"], timeout=60)

    # 5c) 图生图（编辑）：拿刚生成的那张图当底图，走 /api/generate/edit
    if images:
        base = images[0] if isinstance(images[0], str) else images[0].get("url")
        asset_id = items[0]["id"] if items else None
        if asset_id:
            edit = await client.post(
                "/api/generate/edit",
                data={"prompt": "把背景换成深蓝色", "base_asset_id": asset_id, "n": 1},
                headers={**headers, "Idempotency-Key": f"edit-{time.time()}"},
            )
            if edit.status_code != 200:
                failures.append(f"图生图失败：{edit.status_code} {edit.text[:200]}")
            else:
                edit_task = await _wait_task(client, headers, edit.json()["data"]["id"])
                if edit_task["status"] != "succeeded":
                    failures.append(
                        f"图生图没成功：{edit_task['status']} / {edit_task.get('error_message')}"
                    )
                elif not edit_task.get("result_urls"):
                    failures.append("图生图成功但没返回图片")
                else:
                    print(f"图生图成功：{len(edit_task['result_urls'])} 张")
        else:
            print(f"（跳过图生图：{base} 没有对应资产）")

    # 6) 会话里能看到这条任务（左侧对话区的数据源）
    session = await client.post("/api/chat/sessions", json={"title": "生图冒烟"}, headers=headers)
    if session.status_code == 200:
        sid = session.json()["data"]["id"]
        in_session = await client.post(
            "/api/generate/image",
            json={"prompt": "会话内出图：极简海报", "session_id": sid, "n": 1},
            headers={**headers, "Idempotency-Key": f"sess-{time.time()}"},
        )
        if in_session.status_code != 200:
            failures.append(f"会话内出图失败：{in_session.status_code}")
        else:
            listed = await client.get(
                f"/api/generate/tasks?page=1&size=20&session_id={sid}", headers=headers
            )
            ids = [item["id"] for item in listed.json()["data"]["items"]]
            if in_session.json()["data"]["id"] not in ids:
                failures.append("会话内的任务没有出现在会话任务列表里")
            else:
                print("会话内出图已进入该会话的任务列表")
                # 等它跑完，避免后台任务被脚本退出打断留下 running 记录
                await _wait_task(client, headers, in_session.json()["data"]["id"])

    if failures:
        print("\n失败：")
        for item in failures:
            print("  -", item)
        return 1
    print("\n生图全流程端到端通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
