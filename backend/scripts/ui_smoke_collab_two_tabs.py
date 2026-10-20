"""两个真实浏览器标签页协同编辑同一块画布 —— 端到端验证。

单测能证明「服务端合并算法对」，`smoke_collab_ws.py` 能证明「协议通」，
但它们都证明不了**前端那条链路**：onChange → diff → WS 上行 → 服务端广播 →
另一端的 WS 下行 → updateScene。这条链上任何一环断了（漏了依赖、回环抑制写反、
updateScene 参数名不对），功能都是坏的，而所有后端测试依旧全绿。

所以这里开两个 Chrome 标签页，在 A 里真的往画布上放一个元素，
然后读 B 的 DOM 之外的东西——直接问 Excalidraw API「你现在有几个元素」。

用法：
    cd backend && ./.venv/bin/python scripts/ui_smoke_collab_two_tabs.py
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


class Tab:
    """一个 Chrome 标签页 + 一个 CDP 连接。"""

    def __init__(self, ws, counter):
        self.ws = ws
        self.counter = counter
        #: 收到的所有 WS 帧 (direction, requestId, payload)
        self.frames: list[tuple[str, str, str]] = []
        #: requestId → socket url（用来把帧归到具体的协作连接上）
        self.sockets: dict[str, str] = {}

    def drain_frames(self, kind: str) -> list[str]:
        """取出协作连接上某一方向的帧（sent / received）。"""
        out = []
        for direction, request_id, payload in self.frames:
            if direction != kind:
                continue
            if "/api/collab/ws/" in self.sockets.get(request_id, ""):
                out.append(payload)
        return out

    def clear_frames(self) -> None:
        self.frames.clear()

    async def pump(self, seconds: float = 0.4) -> None:
        """在后台收一会儿事件。

        `call()` 只在等响应时读 socket，所以「等待别人广播」这段必须自己泵，
        否则帧就堆在 socket 里、`frames` 永远是空的——这是个只会在测试脚手架里
        出现的假阴性，但它会把「功能正常」误报成「功能坏了」。
        """
        end = time.time() + seconds
        while time.time() < end:
            try:
                raw = json.loads(await asyncio.wait_for(self.ws.recv(), timeout=0.2))
            except (asyncio.TimeoutError, TimeoutError):
                continue
            self._absorb(raw)

    def _absorb(self, raw: dict) -> None:
        method_name = raw.get("method", "")
        if method_name == "Network.webSocketCreated":
            params = raw.get("params", {})
            self.sockets[params.get("requestId", "")] = params.get("url", "")
        elif method_name in (
            "Network.webSocketFrameSent",
            "Network.webSocketFrameReceived",
        ):
            params = raw.get("params", {})
            direction = "sent" if method_name.endswith("Sent") else "received"
            self.frames.append(
                (
                    direction,
                    params.get("requestId", ""),
                    str(params.get("response", {}).get("payloadData", "")),
                )
            )

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
            self._absorb(raw)

    async def eval(self, expression: str):
        result = await self.call(
            "Runtime.evaluate", expression=expression, returnByValue=True, awaitPromise=True
        )
        if result.get("exceptionDetails"):
            raise RuntimeError(str(result["exceptionDetails"])[:300])
        return result["result"].get("value")


async def _seed() -> tuple[str, str]:
    """建账号 + 团队 + 共享画布，返回 (token, canvas_id)。"""
    db = Path(__file__).resolve().parents[1] / "data" / "canvas_studio.db"
    async with httpx.AsyncClient(base_url=BACKEND, timeout=20) as client:
        email = f"collab2-{int(time.time())}@example.com"
        reg = await client.post("/api/auth/register", json={"email": email, "password": PASS})
        assert reg.status_code == 200, reg.text
        conn = sqlite3.connect(str(db))
        try:
            conn.execute("UPDATE users SET role = 'pro' WHERE email = ?", (email,))
            conn.commit()
        finally:
            conn.close()
        login = await client.post("/api/auth/login", json={"email": email, "password": PASS})
        token = login.json()["data"]["access_token"]
        headers = {"Authorization": f"Bearer {token}"}

        await client.post(
            "/api/onboarding/complete", json={"persona_key": "ecommerce"}, headers=headers
        )
        team = await client.post("/api/teams", json={"name": "协同验证组"}, headers=headers)
        assert team.status_code == 200, team.text
        project = await client.post(
            "/api/projects",
            json={"name": "协同项目", "share_with_team": True},
            headers=headers,
        )
        assert project.status_code == 200, project.text
        canvas = await client.post(
            f"/api/projects/{project.json()['data']['id']}/canvases",
            json={"name": "协同画布"},
            headers=headers,
        )
        assert canvas.status_code == 200, canvas.text
        return token, canvas.json()["data"]["id"]


async def main() -> int:
    token, canvas_id = await _seed()
    port = _free_port()
    profile = Path("/tmp/collab-two-tabs-profile")
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
        ws_base = None
        for _ in range(60):
            try:
                info = httpx.get(f"http://127.0.0.1:{port}/json/version", timeout=1.0).json()
                ws_base = info["webSocketDebuggerUrl"]
                break
            except Exception:  # noqa: BLE001
                time.sleep(0.3)
        if not ws_base:
            raise SystemExit("Chrome DevTools 没起来")

        # 用 browser 级连接开两个标签页，保证是同一个浏览器（同一份 localStorage）
        async with websockets.connect(ws_base, max_size=40 * 1024 * 1024) as browser_ws:
            counter = [0]

            async def browser_call(method: str, **params):
                counter[0] += 1
                msg_id = counter[0]
                await browser_ws.send(
                    json.dumps({"id": msg_id, "method": method, "params": params})
                )
                while True:
                    raw = json.loads(await asyncio.wait_for(browser_ws.recv(), timeout=30))
                    if raw.get("id") == msg_id:
                        return raw.get("result", {})

            # 用两个独立的 page target，各自走 /json/list 拿自己的调试地址
            await browser_call("Target.createTarget", url="about:blank")
            await browser_call("Target.createTarget", url="about:blank")

            async def attach_all() -> list[Tab]:
                """等到有两个 page target，各连一条 CDP。"""
                for _ in range(60):
                    pages = httpx.get(f"http://127.0.0.1:{port}/json/list", timeout=2.0).json()
                    targets = [p for p in pages if p.get("type") == "page"]
                    if len(targets) >= 2:
                        tabs = []
                        for target in targets[:2]:
                            conn = await websockets.connect(
                                target["webSocketDebuggerUrl"], max_size=40 * 1024 * 1024
                            )
                            tab = Tab(conn, [0])
                            await tab.call("Runtime.enable")
                            await tab.call("Page.enable")
                            await tab.call("Network.enable")
                            tabs.append(tab)
                        return tabs
                    await asyncio.sleep(0.3)
                raise SystemExit("没能拿到两个 page target")

            tabs = await attach_all()
            tab_a, tab_b = tabs[0], tabs[1]

            try:
                for tab in (tab_a, tab_b):
                    await tab.call("Page.navigate", url=FRONTEND)
                    await asyncio.sleep(2.0)
                    await tab.eval(
                        f"localStorage.setItem('cs.token', {json.dumps(token)});"
                        "localStorage.setItem('cs.theme', 'light');"
                    )
                    await tab.call("Page.navigate", url=f"{FRONTEND}/canvas/{canvas_id}")

                # 两个标签页都要真的连上协作再往下走。这里必须逐页确认，
                # 否则「B 是 idle」会被误判成「广播坏了」，排查方向全错。
                for tab in (tab_a, tab_b):
                    for attempt in range(4):
                        for _ in range(30):
                            await tab.pump(0.4)
                            status = await tab.eval(
                                "window.__csCanvas ? window.__csCanvas.collab.status : null"
                            )
                            if status == "online":
                                break
                        if status == "online":
                            break
                        # 没连上就重载一次：tab 刚被导航到时偶发尚未完成挂载
                        await tab.call("Page.reload")
                    if status != "online":
                        print(f"有个标签页没连上协作（status={status}）")
                        return 1

                async def add_rect(tab: Tab, element_id: str, x: int) -> str:
                    """通过 Excalidraw 的 API 往场景里加一个矩形。

                    为什么不用鼠标拖拽：headless 里能不能画出来取决于焦点、
                    视口尺寸、Excalidraw 的按键处理，噪声很大；而我们真正要验的
                    是「场景变化 → diff → WS → 对端 apply」这条链。
                    `updateScene` 与用户画一笔走的是同一个 onChange，测同一件事。
                    """
                    script = """
                    (() => {
                      const canvas = window.__csCanvas;
                      if (!canvas || !canvas.api) return 'no api';
                      const api = canvas.api;
                      const existing = api.getSceneElements();
                      if (existing.some((el) => el.id === %s)) return 'exists';
                      api.updateScene({
                        elements: [...existing, {
                          id: %s, type: 'rectangle',
                          x: %d, y: 80, width: 200, height: 120, angle: 0,
                          strokeColor: '#1e1e1e', backgroundColor: 'transparent',
                          fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid',
                          roughness: 1, opacity: 100, groupIds: [], frameId: null,
                          roundness: null, seed: 1, version: 1, versionNonce: 1,
                          isDeleted: false, boundElements: null, updated: 1,
                          link: null, locked: false,
                        }],
                      });
                      return 'ok';
                    })()
                    """ % (
                        json.dumps(element_id),
                        json.dumps(element_id),
                        x,
                    )
                    return str(await tab.eval(script))

                async def element_ids(tab: Tab) -> list[str]:
                    """通过开发态钩子读 Excalidraw 的真实场景元素。"""
                    value = await tab.eval(
                        "window.__csCanvas ? window.__csCanvas.elementIds() : null"
                    )
                    return list(value or [])

                # 判据放在协议层：A 必须发出 patch 帧，B 必须收到 patch 帧。
                # 不去数 DOM 节点——Excalidraw 的渲染结构不是稳定契约，
                # 而「客户端有没有真的上行 / 下行」才是这条链路的核心。
                for label, tab in (("A", tab_a), ("B", tab_b)):
                    status = await tab.eval(
                        "window.__csCanvas ? window.__csCanvas.collab.status : 'no hook'"
                    )
                    peers = await tab.eval(
                        "window.__csCanvas ? window.__csCanvas.collab.participants.length : -1"
                    )
                    print(f"{label} 协作状态：{status}，在线 peer {peers}")

                tab_a.clear_frames()
                tab_b.clear_frames()
                print("A 加矩形:", await add_rect(tab_a, "smoke-a-1", 120))
                print("等待同步…")

                # 先确认这次输入真的画出了东西（否则后面的失败会指向错误的方向）
                drew = False
                for _ in range(20):
                    await tab_a.pump(0.3)
                    if await element_ids(tab_a):
                        drew = True
                        break
                if not drew:
                    print("A 的输入没有产生任何元素（画布没获得焦点？）")
                    return 1
                print(f"A 场景元素：{await element_ids(tab_a)}")

                sent_patch = None
                received_patch = None
                for _ in range(40):
                    await tab_a.pump(0.4)
                    await tab_b.pump(0.4)
                    if sent_patch is None:
                        for payload in tab_a.drain_frames("sent"):
                            if '"type":"patch"' in payload.replace(" ", ""):
                                sent_patch = payload
                                break
                    if received_patch is None:
                        for payload in tab_b.drain_frames("received"):
                            if '"type":"patch"' in payload.replace(" ", ""):
                                received_patch = payload
                                break
                    if sent_patch and received_patch:
                        break

                if not sent_patch:
                    print("A 没有上行 patch —— onChange → diff → WS 这段断了")
                    return 1
                print(f"A 已上行 patch（{len(sent_patch)} 字节）")
                if not received_patch:
                    print("B 没收到 patch —— 服务端广播或对端订阅断了")
                    return 1
                print(f"B 已收到 patch（{len(received_patch)} 字节）")

                # 帧收到 ≠ 应用成功：还要确认 B 的场景里真的有 A 那个元素
                applied = False
                for _ in range(20):
                    await tab_b.pump(0.3)
                    if "smoke-a-1" in await element_ids(tab_b):
                        applied = True
                        break
                if not applied:
                    print(f"B 收到了 patch 但没应用上（场景：{await element_ids(tab_b)}）")
                    return 1
                print(f"B 场景已包含 A 的元素：{await element_ids(tab_b)}")

                # 再验一次：B 的改动也能回到 A（双向，不是单向广播）
                tab_a.clear_frames()
                tab_b.clear_frames()
                print("B 加矩形:", await add_rect(tab_b, "smoke-b-1", 480))
                back = None
                for _ in range(40):
                    await tab_a.pump(0.4)
                    await tab_b.pump(0.4)
                    for payload in tab_a.drain_frames("received"):
                        if '"type":"patch"' in payload.replace(" ", ""):
                            back = payload
                            break
                    if back:
                        break
                if not back:
                    print("B 的编辑没有回到 A —— 协作是单向的")
                    return 1
                print("A 收到了 B 的 patch（双向同步成立）")

                # 最后验一次落库：两人都离开后，重新打开画布应能看到这两个元素
                await tab_a.ws.close()
                await tab_b.ws.close()
                persisted: list[str] = []
                for _ in range(25):
                    await asyncio.sleep(0.4)
                    async with httpx.AsyncClient(base_url=BACKEND, timeout=20) as client:
                        resp = await client.get(
                            f"/api/canvases/{canvas_id}",
                            headers={"Authorization": f"Bearer {token}"},
                        )
                    state = (resp.json().get("data") or {}).get("state") or {}
                    persisted = [item.get("id") for item in state.get("elements") or []]
                    if "smoke-a-1" in persisted and "smoke-b-1" in persisted:
                        break
                if not ("smoke-a-1" in persisted and "smoke-b-1" in persisted):
                    print(f"落库不完整（画布里只有 {persisted}）")
                    return 1
                print(f"落库校验通过：{persisted}")

                print("OK  两端协同通过：双向同步 + 场景应用 + 落库")
                return 0
            finally:
                for tab in (tab_a, tab_b):
                    try:
                        await tab.ws.close()
                    except Exception:  # noqa: BLE001 - 已关过就算了
                        pass
    finally:
        chrome.terminate()
        try:
            chrome.wait(timeout=10)
        except subprocess.TimeoutExpired:
            chrome.kill()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
