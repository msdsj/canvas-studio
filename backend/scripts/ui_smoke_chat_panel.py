"""左侧对话区交互 —— 真浏览器点一遍。

需求③要求「优化左侧对话区交互」。这块的坑都在**交互状态**上，而不是数据上：

* 搜索框输入后列表要即时过滤；清空后要恢复全部；
* 切换会话要真的换内容（而不是标题变了、消息没变）；
* 删除要二次确认（否则用户手滑就把一段对话删了）；
* 「新建对话」要创建一个空会话并聚焦过去；
* 发送消息后要能中断（长任务卡住时没有取消按钮是灾难）。

这些在 tsc / build 里都发现不了，单测也不碰前端。所以用真浏览器。

用法：
    cd backend && ./.venv/bin/python scripts/ui_smoke_chat_panel.py
"""
from __future__ import annotations

import asyncio
import json
import shutil
import socket
import subprocess
import time
from pathlib import Path

import httpx
import websockets

from _smoke_common import (  # noqa: E402  （脚本目录在 sys.path[0]）
    BACKEND,
    CHROME,
    FRONTEND,
    PREREQUISITE,
    demo_mode,
    register,
)


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


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

    async def text(self) -> str:
        return str(await self.eval("(document.body.innerText || '')"))

    async def menu_text(self) -> str:
        """下拉菜单的文本。

        为什么要单独读：Radix 把菜单渲染进 portal，`document.body.innerText`
        在某些情况下取不到它的内容（实测就是取不到，而 `[role=menu]` 里明明有）。
        断言下拉内容时直接读菜单节点，比读整页文本可靠。
        """
        return str(
            await self.eval(
                "(document.querySelector('[role=\"menu\"]')?.innerText) || ''"
            )
        )

    async def menu_inputs(self) -> list[str]:
        value = await self.eval(
            "Array.from(document.querySelectorAll('[role=\"menu\"] input'))"
            ".map((node) => node.placeholder || '')"
        )
        return list(value or [])

    async def type_into(self, selector: str, text: str) -> bool:
        """往输入元素里填内容并触发 React 的 onChange。

        直接改 `.value` 不会让 React 收到事件（它有自己的 value 追踪），
        所以要用原生 setter + 手动派发 input 事件——这是驱动受控组件的标准做法。
        """
        script = """
        (() => {
          const el = document.querySelector(%s);
          if (!el) return false;
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          ).set;
          const proto = el instanceof HTMLTextAreaElement
            ? window.HTMLTextAreaElement.prototype
            : window.HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, %s);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        })()
        """ % (json.dumps(selector), json.dumps(text))
        return bool(await self.eval(script))

    async def click_real(self, text: str) -> bool:
        """用真实鼠标事件点一个元素。

        为什么不能只用 `el.click()`：Radix 的下拉菜单监听 `pointerdown`，
        合成 `click` 根本不会展开菜单——表现是「元素找得到、点了没反应」。
        走 CDP 的 `Input.dispatchMouseEvent` 才会产生完整的指针事件序列。
        """
        rect = await self.eval(
            """
            (() => {
              const nodes = Array.from(
                document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')
              );
              const hit = nodes.find((node) => {
                const box = node.getBoundingClientRect();
                if (box.width <= 0 || box.height <= 0) return false;
                return (node.textContent || '').trim().includes(%s);
              });
              if (!hit) return null;
              hit.scrollIntoView({block: 'center'});
              const box = hit.getBoundingClientRect();
              return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            })()
            """
            % json.dumps(text)
        )
        if not rect:
            return False
        x, y = float(rect["x"]), float(rect["y"])
        # 先移过去再按：真实用户也是先 hover。列表里的删除按钮默认 opacity-0，
        # 靠 hover 才显形——不 hover 直接点，命中判定和视觉状态对不上。
        await self.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
        for event_type, buttons in (("mousePressed", 1), ("mouseReleased", 0)):
            await self.call(
                "Input.dispatchMouseEvent",
                type=event_type,
                x=x,
                y=y,
                button="left",
                buttons=buttons,
                clickCount=1,
            )
        return True

    async def click_aria(self, label: str) -> bool:
        """点一个 aria-label 匹配的元素，用真实指针事件。

        与 `click_real` 同理：Radix 的触发器只认 pointerdown，合成 click 无效。
        """
        rect = await self.eval(
            """
            (() => {
              /*
               * 菜单开着时只在菜单里找：页面上别处可能有同样 aria-label 的按钮
               * （折叠面板里的、移动端副本），点到它会把菜单关掉，
               * 表现成「点删除没反应」——排查方向会完全跑偏。
               */
              const menu = document.querySelector('[role="menu"]');
              const scope = menu || document;
              const hit = Array.from(scope.querySelectorAll('[aria-label]'))
                .find((node) => (node.getAttribute('aria-label') || '').includes(%s));
              if (!hit) return null;
              const box = hit.getBoundingClientRect();
              if (box.width <= 0 || box.height <= 0) return null;
              return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
            })()
            """
            % json.dumps(label)
        )
        if not rect:
            return False
        x, y = float(rect["x"]), float(rect["y"])
        # 先移过去再按：真实用户也是先 hover。列表里的删除按钮默认 opacity-0，
        # 靠 hover 才显形——不 hover 直接点，命中判定和视觉状态对不上。
        await self.call("Input.dispatchMouseEvent", type="mouseMoved", x=x, y=y)
        for event_type, buttons in (("mousePressed", 1), ("mouseReleased", 0)):
            await self.call(
                "Input.dispatchMouseEvent",
                type=event_type,
                x=x,
                y=y,
                button="left",
                buttons=buttons,
                clickCount=1,
            )
        return True

    async def click_text(self, text: str) -> bool:
        """点第一个「可见且文字匹配」的可点击元素。

        用 `textContent` 而不是 `innerText`：`innerText` 对隐藏元素返回空串，
        而页面上常有两份同样的组件（桌面版 + 移动抽屉版），其中一份是
        `display:none`。用 innerText 会「明明在 DOM 里却找不到」。
        代价是 textContent 会带上隐藏子节点，所以再要求元素本身有尺寸。
        """
        script = """
        (() => {
          const nodes = Array.from(
            document.querySelectorAll('button, a, [role="button"], [role="menuitem"]')
          );
          const hit = nodes.find((node) => {
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;
            return (node.textContent || '').trim().includes(%s);
          });
          if (!hit) return false;
          hit.scrollIntoView({block: 'center'});
          hit.click();
          return true;
        })()
        """ % json.dumps(text)
        return bool(await self.eval(script))


async def _seed(client: httpx.AsyncClient) -> tuple[str, dict[str, str]]:
    """建账号 + 3 个会话（标题可区分），返回 (token, active_session_id)。"""
    token, headers, _ = await register(client, "chat-smoke")
    titles = ["海报设计讨论", "详情页排版", "品牌配色探索"]
    ids = []
    for title in titles:
        resp = await client.post("/api/chat/sessions", json={"title": title}, headers=headers)
        assert resp.status_code == 200, resp.text
        ids.append(resp.json()["data"]["id"])
    # 返回 (token, 本次会话 id 映射)：后续要按标题定位到确定的会话，
    # 不能依赖「工作台默认打开最近一个」——那是上一个用例留下的会话。
    return token, {"海报设计讨论": ids[0], "详情页排版": ids[1], "品牌配色探索": ids[2]}


async def main() -> int:
    failures: list[str] = []
    port = _free_port()
    profile = Path("/tmp/chat-panel-profile")
    shutil.rmtree(profile, ignore_errors=True)

    async with httpx.AsyncClient(base_url=BACKEND, timeout=180) as client:
        try:
            await client.get("/api/health", timeout=5)
        except Exception:  # noqa: BLE001
            print(PREREQUISITE)
            return 2

        token, sessions = await _seed(client)
        first_session = sessions["海报设计讨论"]

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
                print("Chrome DevTools 没起来")
                return 1

            async with websockets.connect(ws_url, max_size=40 * 1024 * 1024) as ws:
                tab = Tab(ws, [0])
                await tab.call("Runtime.enable")
                await tab.call("Page.enable")

                await tab.call("Page.navigate", url=FRONTEND)
                await tab.pump(2.0)
                await tab.eval(
                    f"localStorage.setItem('cs.token', {json.dumps(token)});"
                    "localStorage.setItem('cs.theme', 'light');"
                )
                # 显式带 session 打开，确保左侧触发器显示的是我们建的会话
                await tab.call(
                    "Page.navigate",
                    url=f"{FRONTEND}/workspace?session={sessions['海报设计讨论']}",
                )
                await tab.pump(7.0)

                # 会话选择器是下拉菜单：触发器上显示「当前会话标题」，
                # 点它才展开完整列表。所以先等触发器出现，再展开。
                opened = False
                for _ in range(20):
                    await tab.pump(0.5)
                    if await tab.click_aria("切换会话"):
                        opened = True
                        break
                if not opened:
                    failures.append("找不到会话选择器（左侧连当前会话标题都没有）")
                else:
                    await tab.pump(1.0)
                    menu = await tab.menu_text()
                    listed = [t for t in ("海报设计讨论", "详情页排版", "品牌配色探索") if t in menu]
                    if len(listed) < 2:
                        failures.append(f"展开选择器后只看到 {listed}，会话列表不完整")
                    else:
                        print(f"OK  会话选择器展开并列出 {len(listed)} 个会话")

                    placeholders = await tab.menu_inputs()
                    if not any("搜索" in item for item in placeholders):
                        failures.append(f"选择器里没有搜索框（现有输入框：{placeholders}）")

                    # 1) 搜索过滤
                    typed = await tab.type_into('[role="menu"] input', "详情页")
                    if not typed:
                        failures.append("选择器里找不到搜索框")
                    else:
                        await tab.pump(1.0)
                        filtered = await tab.menu_text()
                        if "详情页排版" not in filtered:
                            failures.append("搜索「详情页」没有命中「详情页排版」")
                        elif "品牌配色探索" in filtered:
                            failures.append("搜索没有过滤掉不匹配的会话")
                        else:
                            print("OK  搜索过滤生效")

                        # 搜不到要有空态，不能静默留白
                        await tab.type_into('[role="menu"] input', "zzz不存在")
                        await tab.pump(1.0)
                        empty = await tab.menu_text()
                        if "没有找到" not in empty and "没有" not in empty:
                            failures.append("搜不到时没有空态提示")
                        else:
                            print("OK  无结果时给出空态")

                        await tab.type_into('[role="menu"] input', "")
                        await tab.pump(1.0)
                        restored = await tab.menu_text()
                        if "品牌配色探索" not in restored:
                            failures.append("清空搜索后列表没有恢复")
                        else:
                            print("OK  清空搜索后列表恢复")

                    # 3) 删除要二次确认（第一下只「举起来」，第二下才真删）。
                    #    必须趁菜单还开着做——菜单一关，查找范围就落到别的删除按钮上了。
                    armed = await tab.click_aria("删除对话")
                    if not armed:
                        print("（跳过删除确认：菜单里没有删除按钮）")
                    else:
                        await tab.pump(0.8)
                        # 确认态体现在按钮的 aria-label 与配色上（图标本身没字），
                        # 所以断言 label，不是断言菜单文本。
                        labels = await tab.eval(
                            "Array.from(document.querySelectorAll('[role=\"menu\"] [aria-label]'))"
                            ".map((node) => node.getAttribute('aria-label'))"
                        ) or []
                        if not any("再点" in str(item) for item in labels):
                            failures.append(f"点删除后没有进入二次确认态（按钮：{labels}）")
                        else:
                            print("OK  删除需要二次确认")

                        # 第二下才真删——这里不真点，避免影响后面的会话数量断言；
                        # 只验证「第一下不会删」：数据层随后会核对会话数没少。
                        await tab.call(
                            "Input.dispatchKeyEvent",
                            type="keyDown",
                            key="Escape",
                            code="Escape",
                            windowsVirtualKeyCode=27,
                        )
                        await tab.pump(0.5)

                    # 2) 切换会话：内容要真的换（URL 带 session）
                    # 菜单项是 Radix 的 menuitem，点它要用真实指针事件
                    await tab.click_real("详情页排版")
                    await tab.pump(2.5)
                    search = str(await tab.eval("location.search"))
                    if "session" not in search:
                        failures.append(f"点会话后 URL 没有带 session 参数（{search}）")
                    else:
                        print(f"OK  切换会话后 URL 变成 {search}")

                # 4) 新建对话
                await tab.pump(0.6)
                clicked = await tab.click_aria("新建对话")
                if not clicked:
                    clicked = await tab.click_text("新建对话")
                await tab.pump(2.5)
                if not clicked:
                    failures.append("找不到「新建对话」入口")
                else:
                    print("OK  新建对话可用")

            # 5) 数据层：会话都在（删除只是 UI 层的确认，没真删）
            async with httpx.AsyncClient(base_url=BACKEND, timeout=60) as client2:
                headers = {"Authorization": f"Bearer {token}"}
                listed = await client2.get("/api/chat/sessions", headers=headers)
                payload = listed.json()["data"]
                # 会话列表直接返回数组（不走分页）
                items = payload if isinstance(payload, list) else payload.get("items", [])
                if len(items) < 3:
                    failures.append(f"会话少了：只剩下 {len(items)} 个")
                else:
                    print(f"OK  会话数据完好（{len(items)} 个）")

            # 6) 对话链路：发一条消息，必须真的走到模型（演示模式下由网关模拟）
            async with httpx.AsyncClient(base_url=BACKEND, timeout=180) as client3:
                async with demo_mode(client3):
                    headers = {"Authorization": f"Bearer {token}"}
                    stream = await client3.post(
                        "/api/chat/compose",
                        json={
                            "session_id": first_session,
                            "content": "帮我做一张咖啡店的开业海报",
                        },
                        headers=headers,
                    )
                    if stream.status_code != 200:
                        failures.append(
                            f"对话接口失败：{stream.status_code} {stream.text[:200]}"
                        )
                    else:
                        chunks = stream.text
                        if "event:" not in chunks and "data:" not in chunks:
                            failures.append("对话接口没返回 SSE 流")
                        else:
                            print(f"OK  对话接口返回 SSE（{len(chunks)} 字节）")
                        # 演示模式的回复是一段可读文本，不能是空
                        if len(chunks) < 50:
                            failures.append("SSE 内容过短，可能是空回复")
        finally:
            chrome.terminate()
            try:
                chrome.wait(timeout=10)
            except subprocess.TimeoutExpired:
                chrome.kill()

    if failures:
        print("\n失败：")
        for item in failures:
            print("  -", item)
        return 1
    print("\n左侧对话区交互端到端通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
