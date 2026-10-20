"""协作 WebSocket 端到端冒烟：起一个真实 uvicorn，用真 WS 客户端跑一遍。

`tests/test_collab.py` 覆盖的是合并算法与单条消息处理，但 WS 那一层
（握手、票据校验、房间生命周期、跨连接广播、落库）只有真连一次才算验过。
这个脚本就是干这个的：它不依赖任何测试框架，跑完自己清理。

用法：
    cd backend && ./.venv/bin/python scripts/smoke_collab_ws.py
"""
from __future__ import annotations

import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx
import websockets

ROOT = Path(__file__).resolve().parents[1]
PASS = "Passw0rd123"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_ready(base: str, timeout: float = 40.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = httpx.get(f"{base}/api/health", timeout=1.0)
            if resp.status_code == 200:
                return
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.3)
    raise SystemExit("后端没有在超时前起来")


def _promote(db_path: Path, email: str, role: str) -> None:
    """直接把账号提权到指定角色（绕过兑换码/团队邀请）。"""
    import sqlite3

    conn = sqlite3.connect(str(db_path))
    try:
        conn.execute("UPDATE users SET role = ? WHERE email = ?", (role, email))
        conn.commit()
    finally:
        conn.close()


def _element(element_id: str, x: int) -> dict:    return {
        "id": element_id,
        "type": "rectangle",
        "x": x,
        "y": 0,
        "width": 120,
        "height": 80,
        "version": 1,
        "versionNonce": x * 1000 + 1,
    }


async def main() -> int:
    tmp = tempfile.mkdtemp(prefix="collab-smoke-")
    db_path = Path(tmp) / "smoke.db"
    port = _free_port()
    base = f"http://127.0.0.1:{port}"
    ws_base = f"ws://127.0.0.1:{port}"

    env = {
        **os.environ,
        "CS_DATABASE_URL": f"sqlite+aiosqlite:///{db_path}",
        "CS_DEBUG": "true",
    }
    server = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(port)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    try:
        _wait_ready(base)
        async with httpx.AsyncClient(base_url=base, timeout=20.0) as client:
            email = f"smoke-{int(time.time())}@example.com"
            reg = await client.post(
                "/api/auth/register", json={"email": email, "password": PASS}
            )
            assert reg.status_code == 200, reg.text
            # 画布是 Pro 能力：直接改库提权（真实产品路径是兑换码/团队），
            # 这里只关心协作通道本身
            _promote(db_path, email, "pro")
            login = await client.post(
                "/api/auth/login", json={"email": email, "password": PASS}
            )
            assert login.status_code == 200, login.text
            token = login.json()["data"]["access_token"]
            headers = {"Authorization": f"Bearer {token}"}

            project = await client.post("/api/projects", json={"name": "冒烟项目"}, headers=headers)
            assert project.status_code == 200, project.text
            canvas = await client.post(
                f"/api/projects/{project.json()['data']['id']}/canvases",
                json={"name": "冒烟画布"},
                headers=headers,
            )
            assert canvas.status_code == 200, canvas.text
            canvas_id = canvas.json()["data"]["id"]

            ticket = await client.post(f"/api/collab/{canvas_id}/ticket", headers=headers)
            assert ticket.status_code == 200, ticket.text
            ticket_data = ticket.json()["data"]
            assert ticket_data["can_write"] is True

            url = f"{ws_base}/api/collab/ws/{canvas_id}?ticket={ticket_data['ticket']}"
            async with websockets.connect(url) as ws_a, websockets.connect(url) as ws_b:
                snap_a = json.loads(await asyncio.wait_for(ws_a.recv(), timeout=5))
                assert snap_a["type"] == "snapshot", snap_a
                snap_b = json.loads(await asyncio.wait_for(ws_b.recv(), timeout=5))
                assert snap_b["type"] == "snapshot", snap_b

                # A 收到 B 加入的通知
                joined = json.loads(await asyncio.wait_for(ws_a.recv(), timeout=5))
                assert joined["type"] == "peer_joined", joined

                # A 发 patch → B 应当收到广播
                await ws_a.send(
                    json.dumps(
                        {
                            "type": "patch",
                            "base_version": snap_a["version"],
                            "patch": {"added": [_element("srv-1", 10)], "updated": [], "deleted": []},
                        }
                    )
                )
                got = json.loads(await asyncio.wait_for(ws_b.recv(), timeout=5))
                assert got["type"] == "patch", got
                ids = [item["id"] for item in got["patch"]["added"]]
                assert "srv-1" in ids, got
                new_version = int(got["version"])
                assert new_version > int(snap_a["version"])

                # B 在旧版本基础上重连：应当拿到 replay 而不是 snapshot
                await ws_b.close()
                replay_url = f"{ws_base}/api/collab/ws/{canvas_id}?ticket={ticket_data['ticket']}&since={snap_b['version']}"
                async with websockets.connect(replay_url) as ws_c:
                    first = json.loads(await asyncio.wait_for(ws_c.recv(), timeout=5))
                    assert first["type"] in ("replay", "snapshot"), first
                    if first["type"] == "replay":
                        assert first["patches"], first
                        assert first["version"] == new_version

                # ping / pong（前面可能积压了 peer_left 之类的广播，跳过它们）
                await ws_a.send(json.dumps({"type": "ping"}))
                pong = None
                for _ in range(8):
                    message = json.loads(await asyncio.wait_for(ws_a.recv(), timeout=5))
                    if message.get("type") == "pong":
                        pong = message
                        break
                assert pong is not None, "没收到 pong"

            # 所有人都离开后房间释放并落库：重新读画布应能看到那条元素
            persisted = None
            for _ in range(20):
                fresh = await client.get(f"/api/canvases/{canvas_id}", headers=headers)
                assert fresh.status_code == 200, fresh.text
                elements = (fresh.json()["data"].get("state") or {}).get("elements") or []
                persisted = [item.get("id") for item in elements]
                if "srv-1" in persisted:
                    break
                await asyncio.sleep(0.3)
            assert persisted is not None and "srv-1" in persisted, persisted

            print("OK  协作通道端到端通过：snapshot / broadcast / replay / ping / 落库")
            return 0
    finally:
        server.terminate()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server.kill()
        for suffix in ("", "-wal", "-shm"):
            leftover = Path(str(db_path) + suffix)
            if leftover.exists():
                leftover.unlink()
        try:
            Path(tmp).rmdir()
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
