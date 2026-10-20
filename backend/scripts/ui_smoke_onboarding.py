"""首登引导全流程 —— 真浏览器点一遍。

这条流程有三个「看起来能跑但其实是死的」的坑，只有真点一遍才会暴露：

1. **重定向死循环**：完成引导后如果不刷新登录态，`ProtectedRoute` 里的
   `user.persona_key` 还是旧值（空），用户点「进入工作台」会被立刻弹回引导页。
   表现是「按钮没反应」。
2. **跳过按钮**：跳过也要写入 `persona_key`，否则用户永远逃不出去。
3. **技能包真的装上了**：引导说「装了 N 条技能」，那 N 条得真的能在
   `/api/skills/mine` 里查到，否则就是骗人。

用法：
    cd backend && ./.venv/bin/python scripts/ui_smoke_onboarding.py
"""
from __future__ import annotations

import asyncio
import json
import shutil
import socket
import sqlite3
import subprocess
import time
from pathlib import Path

import httpx
import websockets

BACKEND = "http://127.0.0.1:27181"
FRONTEND = "http://localhost:27180"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
PASS = "Passw0rd123"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _fresh_account() -> str:
    """注册一个**没有走过引导**的账号，返回 token。"""
    db = Path(__file__).resolve().parents[1] / "data" / "canvas_studio.db"
    async with httpx.AsyncClient(base_url=BACKEND, timeout=20) as client:
        email = f"onboard-{int(time.time())}@example.com"
        reg = await client.post("/api/auth/register", json={"email": email, "password": PASS})
        assert reg.status_code == 200, reg.text
        conn = sqlite3.connect(str(db))
        try:
            conn.execute("UPDATE users SET role = 'pro' WHERE email = ?", (email,))
            conn.commit()
        finally:
            conn.close()
        login = await client.post("/api/auth/login", json={"email": email, "password": PASS})
        assert login.status_code == 200, login.text
        return login.json()["data"]["access_token"]


class Tab:
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

    async def eval(self, expression: str):
        result = await self.call(
            "Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True
        )
        if result.get("exceptionDetails"):
            raise RuntimeError(str(result["exceptionDetails"])[:300])
        return result["result"].get("value")

    async def pump(self, seconds: float = 0.4) -> None:
        end = time.time() + seconds
        while time.time() < end:
            try:
                raw = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=0.2))
            except (asyncio.TimeoutError, TimeoutError):
                continue
            if "method" in raw:
                self.events.append(raw)

    def errors(self) -> list[str]:
        out = []
        for event in self.events:
            if event.get("method") == "Runtime.exceptionThrown":
                out.append(str(event["params"].get("exceptionDetails", {}).get("text", ""))[:200])
            elif event.get("method") == "Log.entryAdded":
                entry = event["params"].get("entry", {})
                if entry.get("level") == "error" and "Failed to load resource" not in str(
                    entry.get("text", "")
                ):
                    out.append(str(entry.get("text", ""))[:200])
        return out

    async def click_text(self, text: str) -> bool:
        """点第一个 innerText 含指定文案的可点击元素。"""
        script = """
        (() => {
          const target = %s;
          const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
          const hit = nodes.find((node) => (node.innerText || '').includes(target));
          if (!hit) return false;
          hit.scrollIntoView({block: 'center'});
          hit.click();
          return true;
        })()
        """ % json.dumps(text)
        return bool(await self.eval(script))


async def main() -> int:
    token = await _fresh_account()

    port = _free_port()
    profile = Path("/tmp/onboarding-smoke-profile")
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
        ws_url = None
        for _ in range(60):
            try:
                pages = httpx.get(f"http://127.0.0.1:{port}/json/list", timeout=1.0).json()
                page = next(p for p in pages if p.get("type") == "page")
                ws_url = page["webSocketDebuggerUrl"]
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.3)
        if not ws_url:
            raise SystemExit("Chrome DevTools 没起来")

        failures: list[str] = []
        async with websockets.connect(ws_url, max_size=40 * 1024 * 1024) as ws:
            tab = Tab(ws, [0])
            await tab.call("Runtime.enable")
            await tab.call("Log.enable")
            await tab.call("Page.enable")

            await tab.call("Page.navigate", url=FRONTEND)
            await tab.pump(2.0)
            await tab.eval(
                f"localStorage.setItem('cs.token', {json.dumps(token)});"
                "localStorage.setItem('cs.theme', 'light');"
            )

            # 1) 直接进工作台：没走过引导，必须被重定向到 /onboarding
            await tab.call("Page.navigate", url=f"{FRONTEND}/workspace")
            await tab.pump(3.0)
            path = await tab.eval("location.pathname")
            if path != "/onboarding":
                failures.append(f"未引导用户访问 /workspace 没有被引导走（当前 {path}）")
            else:
                print("OK  未引导用户被重定向到 /onboarding")

            body = await tab.eval("(document.getElementById('root')?.innerText || '')")
            if "先选一个你的身份" not in body:
                failures.append("引导页没有渲染出身份选择")
            else:
                print("OK  引导页第 1 步已渲染")

            # 2) 选一个身份 → 继续
            picked = await tab.click_text("电商运营")
            if not picked:
                failures.append("点不到「电商运营」身份卡")
            await tab.pump(0.6)
            await tab.click_text("继续")
            await tab.pump(0.8)
            body = await tab.eval("(document.getElementById('root')?.innerText || '')")
            if "第 2 / 3 步" not in body:
                failures.append("选完身份后没有进入第 2 步")
            else:
                print("OK  进入第 2 步（团队，可跳过）")

            # 3) 第 2 步选「先不用，我自己用」（不建团队）→ 进入完成页
            clicked = await tab.click_text("先不用，我自己用")
            if not clicked:
                failures.append("第 2 步找不到「先不用，我自己用」按钮")
            await tab.pump(1.5)
            body = await tab.eval("(document.getElementById('root')?.innerText || '')")
            if "第 3 / 3 步" not in body:
                failures.append("没有进入第 3 步预览")
            else:
                print("OK  进入第 3 步（技能包预览）")

            # 4) 完成 → 必须真的落到 /workspace 且**不再被弹回**。
            # 这一步是整条流程的核心断言：`finish()` 之后如果不刷新登录态，
            # `ProtectedRoute` 会立刻把用户弹回 /onboarding，表现成「按钮没反应」。
            clicked = await tab.click_text("进入工作台")
            if not clicked:
                failures.append("完成页找不到「进入工作台」按钮")
            await tab.pump(3.0)
            path = await tab.eval("location.pathname")
            if path == "/onboarding":
                failures.append(
                    "点「进入工作台」后仍停在 /onboarding —— 登录态没刷新，"
                    "ProtectedRoute 把用户又弹回来了"
                )
            elif path != "/workspace":
                failures.append(f"完成后落到了 {path}，期望 /workspace")
            else:
                print("OK  完成引导后进入 /workspace，且没有被弹回")

            # 5) 刷新一次：应该直接进工作台（引导状态已持久化）
            await tab.call("Page.navigate", url=f"{FRONTEND}/workspace")
            await tab.pump(3.0)
            path = await tab.eval("location.pathname")
            if path != "/workspace":
                failures.append(f"刷新后又被弹到 {path}")
            else:
                print("OK  刷新后仍在 /workspace（引导状态已持久化）")

            errors = tab.errors()
            if errors:
                failures.append(f"有运行时错误：{errors[:2]}")

        # 6) 技能包真的装上了吗
        async with httpx.AsyncClient(base_url=BACKEND, timeout=20) as client:
            mine = await client.get(
                "/api/skills/mine", headers={"Authorization": f"Bearer {token}"}
            )
            data = mine.json()["data"]
            if not data["personal_packs"]:
                failures.append("引导完成后个人技能包是空的")
            else:
                print(f"OK  已装载技能包 {data['personal_packs']}，共 {len(data['items'])} 条技能")

            state = await client.get(
                "/api/onboarding/state", headers={"Authorization": f"Bearer {token}"}
            )
            payload = state.json()["data"]
            if not payload.get("completed"):
                failures.append(f"引导状态没有标记完成：{payload}")
            else:
                print(f"OK  引导状态已标记完成（persona={payload.get('persona_key')}）")

        if failures:
            print("\n失败：")
            for item in failures:
                print("  -", item)
            return 1
        print("\n引导流程端到端通过")
        return 0
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except subprocess.TimeoutExpired:
            chrome.kill()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
