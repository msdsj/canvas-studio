"""冒烟脚本的共用部件。

这些脚本都要做同一批事：注册真账号、把角色改成 pro/admin、临时切演示模式。
复制三遍的结果是「改一处忘两处」——比如演示模式的开关方式从环境变量改成
管理员接口之后，只有一个脚本跟着改了。所以抽在这里。

不做成 `pytest` fixture：这些脚本跑的是**已经在运行的服务**（真 uvicorn + 真
网关 + 真 Chrome），它们要能从命令行直接跑，不能依赖测试会话的进程内夹具。
"""
from __future__ import annotations

import asyncio
import sqlite3
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import AsyncIterator

import httpx

BACKEND = "http://127.0.0.1:27181"
GATEWAY = "http://127.0.0.1:27182"
FRONTEND = "http://localhost:27180"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PASSWORD = "Passw0rd123"
DB = Path(__file__).resolve().parents[1] / "data" / "canvas_studio.db"
INTERNAL_TOKEN = "dev-internal-token"

#: 目标服务没起来时给出的提示（比一路 500 好排查得多）
PREREQUISITE = (
    "需要三个服务都跑起来：\n"
    "  backend  : cd backend  && ./.venv/bin/python -m uvicorn app.main:app --port 27181\n"
    "  gateway  : cd gateway  && ./.venv/bin/python -m uvicorn app.main:app --port 27182\n"
    "  frontend : cd frontend && npx vite --port 27180"
)


def set_role(email: str, role: str = "pro") -> None:
    """直接改库设置平台角色（没有公开接口能给自己提权，这是脚本特权）。"""
    conn = sqlite3.connect(str(DB))
    try:
        conn.execute("UPDATE users SET role = ? WHERE email = ?", (role, email))
        conn.commit()
    finally:
        conn.close()


def fetch_one(sql: str, params: tuple = ()) -> tuple | None:
    conn = sqlite3.connect(str(DB))
    try:
        return conn.execute(sql, params).fetchone()
    finally:
        conn.close()


def execute(sql: str, params: tuple = ()) -> None:
    conn = sqlite3.connect(str(DB))
    try:
        conn.execute(sql, params)
        conn.commit()
    finally:
        conn.close()


async def register(
    client: httpx.AsyncClient,
    prefix: str,
    *,
    role: str = "pro",
    onboard: str | None = "general",
) -> tuple[str, dict, str]:
    """注册一个真账号，返回 (token, headers, email)。

    `onboard=None` 表示**不**完成引导——引导流程的冒烟脚本要的就是这个状态。
    """
    email = f"{prefix}-{int(time.time() * 1000) % 10**9}@example.com"
    reg = await client.post("/api/auth/register", json={"email": email, "password": PASSWORD})
    assert reg.status_code == 200, reg.text
    set_role(email, role)

    login = await client.post("/api/auth/login", json={"email": email, "password": PASSWORD})
    assert login.status_code == 200, login.text
    token = login.json()["data"]["access_token"]
    headers = {"Authorization": f"Bearer {token}"}

    if onboard:
        done = await client.post(
            "/api/onboarding/complete", json={"persona_key": onboard}, headers=headers
        )
        assert done.status_code == 200, done.text
    return token, headers, email


async def read_demo_mode(client: httpx.AsyncClient, admin_headers: dict) -> str:
    resp = await client.get("/api/admin/config", headers=admin_headers)
    assert resp.status_code == 200, resp.text
    for item in resp.json()["data"]["items"]:
        if item.get("key") == "DEMO_MODE":
            return str(item.get("value") or "auto")
    return "auto"


async def write_demo_mode(client: httpx.AsyncClient, admin_headers: dict, mode: str) -> None:
    resp = await client.put(
        "/api/admin/config", json={"DEMO_MODE": mode}, headers=admin_headers
    )
    assert resp.status_code == 200, resp.text


async def open_demo_mode(client: httpx.AsyncClient) -> tuple[dict, str]:
    """把网关切到演示模式，返回 (admin_headers, 原值)。

    为什么必须走管理员接口：网关的 `demo_mode` 会被后端 `system_configs` 覆盖，
    直接在网关进程上设 `CS_DEMO_MODE` 会被推回去。踩过这个坑——
    脚本以为开了演示模式，实际每张图都在真的调上游。
    """
    _, admin_headers, _ = await register(client, "smoke-admin", role="admin", onboard=None)
    original = await read_demo_mode(client, admin_headers)
    if original != "on":
        await write_demo_mode(client, admin_headers, "on")
        # 等网关确认生效，避免「刚开就跑」的竞态
        for _ in range(20):
            health = await client.get(
                f"{GATEWAY}/gw/health", headers={"X-Internal-Token": INTERNAL_TOKEN}
            )
            if health.json()["data"].get("demo_mode") == "on":
                break
            await asyncio.sleep(0.3)
    return admin_headers, original


@asynccontextmanager
async def demo_mode(client: httpx.AsyncClient) -> AsyncIterator[None]:
    """确保这段代码在演示模式下执行，跑完还原。

    用 `try/finally` 而不是手工还原：脚本中途断言失败会抛异常，
    忘了还原就等于在整个站点上留下了「所有出图都变成占位图」的配置。
    """
    admin_headers, original = await open_demo_mode(client)
    try:
        yield
    finally:
        if original != "on":
            await write_demo_mode(client, admin_headers, original)


async def wait_task(
    client: httpx.AsyncClient, headers: dict, task_id: str, timeout: float = 90.0
) -> dict:
    """轮询任务到终态。"""
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        resp = await client.get(f"/api/generate/tasks/{task_id}", headers=headers)
        last = resp.json()["data"]
        if last["status"] in {"succeeded", "failed", "cancelled", "canceled"}:
            return last
        await asyncio.sleep(0.7)
    return last
