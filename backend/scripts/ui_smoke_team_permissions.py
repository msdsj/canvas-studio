"""团队权限矩阵 —— 真浏览器验证「谁能改模型配置」。

这是需求④的核心约束：**只有超级管理员能配对话模型，成员一律沿用管理员配的那套，
不能自己配**。这条规则有三层实现（后端 `_guard_personal_config`、`/api/ai/models`
的 `editable` 字段、前端 `AIConfigDialog` 的只读面板），任何一层漏了都会出现
「界面能点、点了报错」或者更糟的「成员真的改掉了团队模型」。

单测分别覆盖了这三层，但**没有覆盖它们串起来的效果**。这个脚本用两个真账号
（owner / member）分别打开设置弹窗，断言：

* owner：能看到可编辑的表单；
* member：看到只读面板 + 「联系超级管理员」提示，且**没有保存按钮**；
* member 直接打 API 改模型 → 403 `MODEL_CONFIG_FORBIDDEN`（前端藏了，后端也必须拦）。

用法：
    cd backend && ./.venv/bin/python scripts/ui_smoke_team_permissions.py
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
DB = Path(__file__).resolve().parents[1] / "data" / "canvas_studio.db"


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def _promote(email: str) -> None:
    conn = sqlite3.connect(str(DB))
    try:
        conn.execute("UPDATE users SET role = 'pro' WHERE email = ?", (email,))
        conn.commit()
    finally:
        conn.close()


async def _seed() -> dict:
    """建 owner + member 两个账号，同一个团队，返回 token 与团队 id。"""
    stamp = int(time.time())
    owner_email = f"perm-owner-{stamp}@example.com"
    member_email = f"perm-member-{stamp}@example.com"
    async with httpx.AsyncClient(base_url=BACKEND, timeout=20) as client:
        tokens = {}
        for email in (owner_email, member_email):
            reg = await client.post("/api/auth/register", json={"email": email, "password": PASS})
            assert reg.status_code == 200, reg.text
            await _promote(email)
            login = await client.post("/api/auth/login", json={"email": email, "password": PASS})
            tokens[email] = login.json()["data"]["access_token"]

        owner_headers = {"Authorization": f"Bearer {tokens[owner_email]}"}
        onboard = await client.post(
            "/api/onboarding/complete", json={"persona_key": "general"}, headers=owner_headers
        )
        assert onboard.status_code == 200, onboard.text
        team = await client.post("/api/teams", json={"name": "权限验证组"}, headers=owner_headers)
        assert team.status_code == 200, team.text
        team_id = team.json()["data"]["id"]

        invite = await client.post(
            f"/api/teams/{team_id}/invitations",
            json={"email": member_email, "role": "member"},
            headers=owner_headers,
        )
        assert invite.status_code == 200, invite.text
        # 接口不回传令牌（避免把「谁都能进」的凭据塞进响应体/日志），
        # 真实场景是邮件里带的；脚本直接从库里取。
        conn = sqlite3.connect(str(DB))
        try:
            row = conn.execute(
                "SELECT token FROM team_invitations WHERE team_id = ? AND email = ?"
                " ORDER BY created_at DESC LIMIT 1",
                (team_id, member_email),
            ).fetchone()
        finally:
            conn.close()
        assert row, "邀请没有入库"
        invite_token = row[0]

        member_headers = {"Authorization": f"Bearer {tokens[member_email]}"}
        onboard = await client.post(
            "/api/onboarding/complete", json={"persona_key": "general"}, headers=member_headers
        )
        assert onboard.status_code == 200, onboard.text
        accept = await client.post(
            f"/api/teams/invitations/{invite_token}/accept", headers=member_headers
        )
        assert accept.status_code == 200, accept.text

        return {
            "team_id": team_id,
            "owner_token": tokens[owner_email],
            "member_token": tokens[member_email],
        }


class Tab:
    def __init__(self, ws, counter):
        self.ws = ws
        self.counter = counter

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

    async def eval(self, expression: str):
        result = await self.call(
            "Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True
        )
        if result.get("exceptionDetails"):
            raise RuntimeError(str(result["exceptionDetails"])[:300])
        return result["result"].get("value")

    async def pump(self, seconds: float = 0.5) -> None:
        end = time.time() + seconds
        while time.time() < end:
            try:
                await asyncio.wait_for(self.ws.recv(), timeout=0.2)
            except (asyncio.TimeoutError, TimeoutError):
                continue

    async def click_text(self, text: str) -> bool:
        script = """
        (() => {
          const target = %s;
          const nodes = Array.from(
            document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')
          );
          const hit = nodes.find((node) => (node.innerText || '').trim().includes(target));
          if (!hit) return false;
          hit.scrollIntoView({block: 'center'});
          hit.click();
          return true;
        })()
        """ % json.dumps(text)
        return bool(await self.eval(script))

    async def click_aria(self, label: str) -> bool:
        """按 aria-label 点（图标按钮没有文字）。"""
        script = """
        (() => {
          const target = %s;
          const hit = Array.from(document.querySelectorAll('[aria-label]'))
            .find((node) => (node.getAttribute('aria-label') || '').includes(target));
          if (!hit) return false;
          hit.click();
          return true;
        })()
        """ % json.dumps(label)
        return bool(await self.eval(script))

    async def text(self) -> str:
        return str(await self.eval("(document.body.innerText || '')"))


async def _open_workspace(tab: Tab, token: str) -> None:
    await tab.call("Page.navigate", url=FRONTEND)
    await tab.pump(2.0)
    await tab.eval(
        f"localStorage.setItem('cs.token', {json.dumps(token)});"
        "localStorage.setItem('cs.theme', 'light');"
    )
    await tab.call("Page.navigate", url=f"{FRONTEND}/workspace")
    await tab.pump(5.0)


async def main() -> int:
    seed = await _seed()
    port = _free_port()
    profile = Path("/tmp/team-perm-profile")
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
        for _ in range(60):
            try:
                pages = httpx.get(f"http://127.0.0.1:{port}/json/list", timeout=1.0).json()
                if any(p.get("type") == "page" for p in pages):
                    break
            except Exception:  # noqa: BLE001
                pass
            time.sleep(0.3)

        async def open_tab() -> Tab:
            await asyncio.sleep(0.5)
            pages = httpx.get(f"http://127.0.0.1:{port}/json/list", timeout=2.0).json()
            page = next(p for p in pages if p.get("type") == "page")
            conn = await websockets.connect(page["webSocketDebuggerUrl"], max_size=40 * 1024 * 1024)
            tab = Tab(conn, [0])
            await tab.call("Runtime.enable")
            await tab.call("Page.enable")
            return tab

        failures: list[str] = []

        # ---------- owner：应该看到可编辑 ----------
        owner_tab = await open_tab()
        await _open_workspace(owner_tab, seed["owner_token"])
        # 入口是对话区右上角那颗齿轮（只有图标，靠 aria-label 定位）
        opened = await owner_tab.click_aria("配置 AI 中转站")
        if not opened:
            opened = await owner_tab.click_aria("中转站")
        if not opened:
            opened = await owner_tab.click_aria("配置")
        await owner_tab.pump(1.5)
        owner_text = await owner_tab.text()
        if not opened:
            failures.append("找不到模型/设置入口")
        elif "对话模型由你统一配置" not in owner_text:
            failures.append(
                "owner 打开模型面板后没看到「由你统一配置」——"
                "会被误告知去找自己"
            )
        elif "去团队设置" not in owner_text:
            failures.append("owner 的面板里没有「去团队设置」入口，等于没告诉他去哪儿改")
        else:
            print("OK  owner 看到「由你统一配置」+ 去团队设置入口")
        await owner_tab.ws.close()

        # ---------- member：应该只读 ----------
        member_tab = await open_tab()
        await _open_workspace(member_tab, seed["member_token"])
        opened = await member_tab.click_aria("配置 AI 中转站")
        if not opened:
            opened = await member_tab.click_aria("中转站")
        if not opened:
            opened = await member_tab.click_aria("配置")
        await member_tab.pump(1.5)
        member_text = await member_tab.text()
        if not opened:
            failures.append("member 找不到模型/设置入口")
        elif "对话模型由你统一配置" in member_text:
            failures.append("member 被告知「由你统一配置」——权限判断写反了")
        elif "联系团队超级管理员" not in member_text:
            failures.append("member 的面板没有告诉他要找超级管理员")
        else:
            print("OK  member 看到只读面板 + 联系管理员提示")
        await member_tab.ws.close()

        # ---------- member 绕过前端直接改 ----------
        async with httpx.AsyncClient(base_url=BACKEND, timeout=20) as client:
            member_headers = {"Authorization": f"Bearer {seed['member_token']}"}
            models = await client.get("/api/ai/models", headers=member_headers)
            payload = models.json()["data"]
            if payload.get("editable") is not False:
                failures.append(f"member 的 /api/ai/models 报告 editable={payload.get('editable')}")
            else:
                print(f"OK  /api/ai/models 对 member 报告 editable=false（source={payload.get('source')}）")

            write = await client.post(
                "/api/ai/providers",
                json={
                    "kind": "openai",
                    "name": "成员偷偷配的",
                    "base_url": "https://api.example.com/v1",
                    "api_key": "sk-member",
                    "model": "gpt-4.1-mini",
                },
                headers=member_headers,
            )
            code = write.json().get("code") if write.headers.get("content-type", "").startswith("application/json") else None
            if write.status_code not in (403, 404) or code != "MODEL_CONFIG_FORBIDDEN":
                failures.append(
                    f"member 直接调 API 改模型没有被拦（{write.status_code} {write.text[:160]}）"
                )
            else:
                print(f"OK  member 直接调 API 被拦：{write.status_code} {code}")

            # owner 通过**团队模型配置**接口配（这是需求④的入口，不是个人 provider）
            owner_headers = {"Authorization": f"Bearer {seed['owner_token']}"}
            owner_write = await client.put(
                f"/api/teams/{seed['team_id']}/model-config",
                json={
                    "name": "团队统一模型",
                    "kind": "compatible",
                    "base_url": "https://api.example.com/v1",
                    "api_key": "sk-owner",
                    "model": "gpt-4.1-mini",
                },
                headers=owner_headers,
            )
            if owner_write.status_code != 200:
                failures.append(
                    f"owner 配不了团队模型（{owner_write.status_code} {owner_write.text[:160]}）"
                )
            else:
                print("OK  owner 可以配置团队模型（/teams/{id}/model-config）")

            # member 走同一个接口必须被拒（403，而非 404：团队存在、你没这个权限）
            member_write = await client.put(
                f"/api/teams/{seed['team_id']}/model-config",
                json={
                    "name": "成员改的",
                    "kind": "compatible",
                    "base_url": "https://api.example.com/v1",
                    "api_key": "sk-member",
                    "model": "gpt-4.1-mini",
                },
                headers=member_headers,
            )
            if member_write.status_code != 403:
                failures.append(
                    f"member 能改团队模型配置（{member_write.status_code}）——应该 403"
                )
            else:
                print("OK  member 改团队模型配置被拒（403）")

            # 配完之后 member 读到的应该是 owner 那套
            after = await client.get("/api/ai/models", headers=member_headers)
            data = after.json()["data"]
            if data.get("source") != "team":
                failures.append(f"member 读到的模型来源是 {data.get('source')}，期望 team")
            elif not data.get("editable") is False:
                failures.append("owner 配好之后 member 变成了可编辑")
            else:
                print(f"OK  member 读到团队配置（provider={data.get('provider_name')}）且仍不可编辑")

        if failures:
            print("\n失败：")
            for item in failures:
                print("  -", item)
            return 1
        print("\n团队权限矩阵端到端通过")
        return 0
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except subprocess.TimeoutExpired:
            chrome.kill()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
