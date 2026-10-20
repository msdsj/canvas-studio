"""用 CDP 驱动真实 Chrome 打开关键页面，抓控制台错误 + 截图。

前端在这个仓库里没有测试框架（没装 vitest/playwright），`tsc` 只能保证类型对，
`vite build` 只能保证能打包。但「页面一打开就白屏」这类问题两者都发现不了——
所以这里退一步，用系统自带的 Chrome + DevTools 协议跑一遍真实渲染。

用法：
    cd backend && ./.venv/bin/python scripts/ui_smoke_pages.py
"""
from __future__ import annotations

import asyncio
import base64
import json
import os
import shutil
import socket
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import httpx
import websockets

BACKEND = "http://127.0.0.1:27181"
FRONTEND = "http://localhost:27180"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PASS = "Passw0rd123"
OUT = Path("/tmp/ui-smoke")


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class CDP:
    """极简 CDP 客户端：只做这个脚本需要的事。"""

    def __init__(self, ws, counter):
        self.ws = ws
        self.counter = counter
        self.events: list[dict] = []

    async def call(self, method: str, **params):
        self.counter[0] += 1
        msg_id = self.counter[0]
        await self.ws.send(json.dumps({"id": msg_id, "method": method, "params": params}))
        while True:
            raw = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=30))
            if raw.get("id") == msg_id:
                if "error" in raw:
                    raise RuntimeError(f"{method}: {raw['error']}")
                return raw.get("result", {})
            if "method" in raw:
                self.events.append(raw)

    async def drain(self, seconds: float = 1.5) -> None:
        """收一会儿事件（控制台错误 / 异常都在里面）。"""
        end = time.time() + seconds
        while time.time() < end:
            try:
                raw = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=0.3))
            except (asyncio.TimeoutError, TimeoutError):
                continue
            if "method" in raw:
                self.events.append(raw)


async def _prepare_account() -> str:
    """注册 + 提权 + 登录，返回 token（页面要带着它才算「登录态」）。"""
    db = Path(__file__).resolve().parents[1] / "data" / "canvas_studio.db"
    async with httpx.AsyncClient(base_url=BACKEND, timeout=20) as client:
        email = f"ui-{int(time.time())}@example.com"
        reg = await client.post("/api/auth/register", json={"email": email, "password": PASS})
        assert reg.status_code == 200, reg.text
        conn = sqlite3.connect(str(db))
        try:
            # 画布/对话是 Pro 能力，这里直接改库（真实路径是兑换码或团队邀请）
            conn.execute("UPDATE users SET role = 'pro' WHERE email = ?", (email,))
            conn.commit()
        finally:
            conn.close()
        login = await client.post("/api/auth/login", json={"email": email, "password": PASS})
        assert login.status_code == 200, login.text
        token = login.json()["data"]["access_token"]

        # 先走完引导：没完成的账号会被 ProtectedRoute 一律重定向到 /onboarding，
        # 那样后面每个页面截出来都是同一张引导页，等于什么都没验。
        headers = {"Authorization": f"Bearer {token}"}
        done = await client.post(
            "/api/onboarding/complete", json={"persona_key": "ecommerce"}, headers=headers
        )
        assert done.status_code == 200, done.text

        # 建一个团队：否则 /team/* 全是空状态，成员/设置/日志三页的真实渲染
        # 一次都验不到（这是最容易出错的三个页面）
        team = await client.post("/api/teams", json={"name": "冒烟设计组"}, headers=headers)
        assert team.status_code == 200, team.text
        team_id = team.json()["data"]["id"]
        # 团队共享项目 + 画布：用来验协作通道能不能真的从浏览器连上
        project = await client.post(
            "/api/projects",
            json={"name": "冒烟项目", "share_with_team": True},
            headers=headers,
        )
        assert project.status_code == 200, project.text
        canvas = await client.post(
            f"/api/projects/{project.json()['data']['id']}/canvases",
            json={"name": "冒烟画布"},
            headers=headers,
        )
        assert canvas.status_code == 200, canvas.text
        canvas_id = canvas.json()["data"]["id"]

        await client.put(
            f"/api/teams/{team_id}/model-config",
            json={
                "name": "公司中转",
                "kind": "openai",
                "base_url": "https://api.example.com/v1",
                "api_key": "sk-smoke",
                "model": "gpt-image-2",
            },
            headers=headers,
        )
        return token, canvas_id


async def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    token, canvas_id = await _prepare_account()

    port = _free_port()
    profile = Path("/tmp/ui-smoke-profile")
    shutil.rmtree(profile, ignore_errors=True)
    chrome = subprocess.Popen(
        [
            CHROME,
            "--headless=new",
            "--disable-gpu",
            "--no-sandbox",
            f"--remote-debugging-port={port}",
            f"--user-data-dir={profile}",
            "--window-size=1440,900",
            "about:blank",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        # 等 DevTools 端口就绪
        ws_url = None
        for _ in range(60):
            try:
                pages = httpx.get(f"http://127.0.0.1:{port}/json", timeout=1.0).json()
                target = next(p for p in pages if p["type"] == "page")
                ws_url = target["webSocketDebuggerUrl"]
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.3)
        if ws_url is None:
            raise SystemExit("Chrome DevTools 没起来")

        counter = [0]
        async with websockets.connect(ws_url, max_size=40 * 1024 * 1024) as ws:
            cdp = CDP(ws, counter)
            await cdp.call("Runtime.enable")
            await cdp.call("Log.enable")
            await cdp.call("Page.enable")
            # 协作走 WebSocket：开 Network 才能验「浏览器是否真的连上了」
            await cdp.call("Network.enable")

            # 先把 token 塞进 localStorage（页面初始化会读它）
            await cdp.call("Page.navigate", url=FRONTEND)
            await cdp.drain(2.0)
            await cdp.call(
                "Runtime.evaluate",
                expression=(
                    f"localStorage.setItem('cs.token', {json.dumps(token)});"
                    "localStorage.setItem('cs.theme', 'light');"
                ),
                awaitPromise=False,
            )

            # (名字, 路径, 必须出现的文本) —— 特征文本比「截图是否相同」可靠：
            # 没团队时 /team 下的四个页面本来就长得一样，那不是 bug。
            pages = [
                ("skills", "/skills", "我的技能"),
                ("team", "/team", "团队空间"),
                ("team-members", "/team/members", "成员"),
                ("team-settings", "/team/settings", "对话模型"),
                ("team-audit", "/team/audit", "操作日志"),
                (
                    "team-join",
                    "/team/join?token=definitely-not-a-real-token",
                    "邀请",
                ),
                ("workspace", "/workspace", "设计 Agent"),
                ("assets", "/assets", "资产库"),
                ("onboarding", "/onboarding", "先选一个你的身份"),
                ("canvas", f"/canvas/{canvas_id}", "GPT"),
            ]
            failures: list[str] = []
            for name, path, expect in pages:
                cdp.events.clear()
                await cdp.call("Page.navigate", url=f"{FRONTEND}{path}")
                await cdp.drain(3.0)

                # 白屏检测：根节点里得有实际内容
                result = await cdp.call(
                    "Runtime.evaluate",
                    expression="(document.getElementById('root')?.innerText || '').trim().length",
                    returnByValue=True,
                )
                text_len = int(result["result"].get("value") or 0)

                errors = []
                warnings = []
                for event in cdp.events:
                    method = event.get("method")
                    params = event.get("params", {})
                    if method == "Runtime.exceptionThrown":
                        # 未捕获异常一律算错：这类问题会让交互直接失效
                        errors.append(
                            "exception: "
                            + str(params.get("exceptionDetails", {}).get("text", ""))[:200]
                        )
                    elif method == "Log.entryAdded":
                        entry = params.get("entry", {})
                        if entry.get("level") != "error":
                            continue
                        text = str(entry.get("text", ""))
                        # 「Failed to load resource」是接口 4xx/5xx 的浏览器日志。
                        # 有些页面本来就该失败（比如故意用一个假邀请码），
                        # 所以只当警告记录，不判失败。
                        if "Failed to load resource" in text:
                            warnings.append(text[:160])
                        else:
                            errors.append(f"console: {text[:200]}")

                # 截图留档
                shot = await cdp.call("Page.captureScreenshot", format="png")
                (OUT / f"{name}.png").write_bytes(base64.b64decode(shot["data"]))

                text = await cdp.call(
                    "Runtime.evaluate",
                    expression="(document.getElementById('root')?.innerText || '').slice(0,180)",
                    returnByValue=True,
                )
                preview = str(text["result"].get("value") or "").replace("\n", " ⏎ ")[:120]
                body = await cdp.call(
                    "Runtime.evaluate",
                    expression="(document.getElementById('root')?.innerText || '')",
                    returnByValue=True,
                )
                body_text = str(body["result"].get("value") or "")
                missing = expect not in body_text
                status = "OK " if not errors and not missing else "FAIL"
                line = f"{status} {path:<38} 文本 {text_len:>5} 字符"
                if errors:
                    line += f"  错误 {len(errors)}"
                if missing:
                    line += f"  缺少「{expect}」"
                print(line)
                print("       →", preview)
                for item in errors[:4]:
                    print("       错误:", item)
                for item in warnings[:4]:
                    print("       警告:", item)
                if text_len == 0:
                    failures.append(f"{path} 白屏（根节点没有任何文本）")

                # 画布页要额外验协作通道：这是唯一一处浏览器真连 WS 的地方。
                # 判据是「收到过服务端下发的帧」，而不只是「发起过连接」——
                # 握手被代理拒掉时 Chrome 同样会记一条 webSocketCreated。
                sockets: dict[str, str] = {}
                received: set[str] = set()
                for event in cdp.events:
                    method = event.get("method")
                    params = event.get("params", {})
                    if method == "Network.webSocketCreated":
                        sockets[params.get("requestId", "")] = params.get("url", "")
                    elif method == "Network.webSocketFrameReceived":
                        received.add(params.get("requestId", ""))

                if name == "canvas":
                    collab_ids = [
                        rid for rid, url in sockets.items() if "/api/collab/ws/" in url
                    ]
                    if not collab_ids:
                        failures.append(
                            f"{path} 没有发起协作 WebSocket（团队画布应自动连）"
                        )
                    elif not any(rid in received for rid in collab_ids):
                        failures.append(f"{path} 协作 WS 连上了但没收到任何帧")
                    else:
                        print(
                            "       协作 WS 已连通并收到服务端帧："
                            + sockets[collab_ids[0]].split("?")[0]
                        )
                if missing:
                    failures.append(f"{path} 缺少特征文本「{expect}」")
                if errors:
                    failures.append(f"{path} 有运行时错误")

            # 切回个人空间：团队专属 UI（「团队共享」筛选）必须消失，
            # 否则用户会以为自己还在团队里，上传的东西进错地方
            await cdp.call(
                "Runtime.evaluate",
                expression=(
                    "fetch('/api/teams/active', {method:'POST',"
                    " headers:{'Content-Type':'application/json',"
                    " Authorization:'Bearer '+localStorage.getItem('cs.token')},"
                    " body: JSON.stringify({team_id: null})})"
                ),
                awaitPromise=True,
            )
            cdp.events.clear()
            await cdp.call("Page.navigate", url=f"{FRONTEND}/assets")
            await cdp.drain(3.0)
            body = await cdp.call(
                "Runtime.evaluate",
                expression="(document.getElementById('root')?.innerText || '')",
                returnByValue=True,
            )
            personal_text = str(body["result"].get("value") or "")
            if "团队共享" in personal_text:
                failures.append("切回个人空间后资产页仍显示「团队共享」筛选")
            else:
                print("OK  切回个人空间后团队专属 UI 已消失")

            if failures:
                print("\n失败：")
                for item in failures:
                    print("  -", item)
                return 1
            print(f"\n全部页面渲染通过，截图在 {OUT}")
            return 0
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except subprocess.TimeoutExpired:
            chrome.kill()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
