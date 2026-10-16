#!/usr/bin/env python3
"""全流程端到端验证（真实三件套：backend + gateway + 模拟上游）。

覆盖：登录 → 内置提示词配置 → 上传（带提示词）→ 文生图 → 图生图（框选 region + mask）
      → 任务终态 → 结果统一 PNG → 画布图层持久化（元素/文件）。

用法（先起 mock_upstream.py + gateway + backend）：
    python e2e/verify_flow.py
"""
from __future__ import annotations

import io
import json
import sys
import time

import httpx
from PIL import Image

BACKEND = "http://127.0.0.1:27181"
ADMIN_EMAIL = "admin@canvas.studio"
ADMIN_PASSWORD = "Admin@12345"

PASS: list[str] = []
FAIL: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASS if ok else FAIL).append(f"{name}{(' — ' + detail) if detail else ''}")
    print(f"{'✅' if ok else '❌'} {name}{(' — ' + detail) if detail else ''}")


def png_bytes(size=(512, 512), color=(30, 90, 200)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return buf.getvalue()


def is_png(data: bytes) -> bool:
    return data[:8] == b"\x89PNG\r\n\x1a\n"


def wait_task(client: httpx.Client, task_id: str, timeout: float = 60.0) -> dict:
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        resp = client.get(f"/api/generate/tasks/{task_id}")
        resp.raise_for_status()
        last = resp.json()["data"]
        if last["status"] in {"succeeded", "failed", "cancelled", "timeout"}:
            return last
        time.sleep(1)
    return last


def main() -> int:
    with httpx.Client(base_url=BACKEND, timeout=60.0) as client:
        # 1) 登录
        resp = client.post("/api/auth/login", json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD})
        check("登录超管账号", resp.status_code == 200, f"HTTP {resp.status_code}")
        if resp.status_code != 200:
            return 1
        token = resp.json()["data"]["access_token"]
        client.headers.update({"Authorization": f"Bearer {token}"})

        # 1.5) 强制关闭 Demo 降级：确保走真实上游链路（证明不是占位图兜底）
        resp = client.put(
            "/api/admin/config",
            json={"DEMO_MODE": "off", "CHATGPT2API_BASE_URL": "http://127.0.0.1:3000"},
        )
        check("关闭 Demo 降级（走真实上游）", resp.status_code == 200, f"HTTP {resp.status_code}")
        time.sleep(1)

        # 2) 内置提示词配置
        resp = client.get("/api/assets/prompt-presets")
        ok = resp.status_code == 200 and resp.json()["data"]["presets"]
        check("内置提示词配置接口", bool(ok), f"{len(resp.json()['data']['presets']) if ok else 0} 个预设")
        template = resp.json()["data"]["template"] if ok else ""

        # 3) 上传图片（带内置提示词）
        files = {"file": ("base.png", png_bytes(), "image/png")}
        resp = client.post(
            "/api/assets/upload", files=files, data={"prompt": "把背景换成纯白色"}
        )
        ok = resp.status_code == 200 and resp.json()["data"]["source_prompt"] == "把背景换成纯白色"
        check("上传图片并保存内置提示词", ok, resp.json()["data"].get("source_prompt", "") if resp.status_code == 200 else resp.text[:80])
        base_url = resp.json()["data"]["url"]
        base_id = resp.json()["data"]["id"]

        # 4) 文生图（上游返回 JPEG → 平台必须落 PNG）
        resp = client.post(
            "/api/generate/image",
            json={"prompt": "一只在草地上奔跑的橘猫", "session_id": None},
            headers={"Idempotency-Key": f"e2e-gen-{int(time.time())}"},
        )
        check("创建文生图任务", resp.status_code == 200, f"HTTP {resp.status_code}")
        gen_task = wait_task(client, resp.json()["data"]["id"])
        check("文生图任务成功", gen_task["status"] == "succeeded", gen_task.get("error_message") or gen_task["status"])
        gen_url = (gen_task.get("result_urls") or [""])[0]
        check("文生图结果为 .png 资源", gen_url.endswith(".png"), gen_url.rsplit("/", 1)[-1])
        if gen_url:
            raw = client.get(gen_url).content
            check("文生图产物字节为真 PNG", is_png(raw), f"{len(raw)} bytes")

        # 5) 图生图：框选区域 + 编号红框 mask + 用户提示词
        mask_bytes = png_bytes((512, 512), (255, 255, 255))
        region = [{"x": 0.25, "y": 0.25, "w": 0.3, "h": 0.3}]
        prompt = f"{template}\n把框里的人物换成穿红裙的女性"
        resp = client.post(
            "/api/generate/edit",
            files={
                "file": ("base.png", png_bytes(), "image/png"),
                "mask": ("region-mask.png", mask_bytes, "image/png"),
            },
            data={
                "prompt": prompt,
                "region": json.dumps(region),
                "base_asset_id": base_id,
            },
            headers={"Idempotency-Key": f"e2e-edit-{int(time.time())}"},
        )
        check("创建图生图（编辑）任务", resp.status_code == 200, f"HTTP {resp.status_code} {resp.text[:120]}")
        edit_task = wait_task(client, resp.json()["data"]["id"])
        check("图生图任务成功", edit_task["status"] == "succeeded", edit_task.get("error_message") or edit_task["status"])
        edit_url = (edit_task.get("result_urls") or [""])[0]
        check("图生图结果为 .png 资源", edit_url.endswith(".png"), edit_url.rsplit("/", 1)[-1])
        if edit_url:
            raw = client.get(edit_url).content
            check("图生图产物字节为真 PNG", is_png(raw), f"{len(raw)} bytes")
            with Image.open(io.BytesIO(raw)) as img:
                check("图生图产物可正常解码", img.size[0] > 0, f"{img.size[0]}x{img.size[1]} {img.format}")

        # 6) 任务参数透传（提示词原样送达上游）
        params = edit_task.get("params") or {}
        check("编辑任务记录了 region 选区", bool(params.get("edit_region")), json.dumps(params.get("edit_region"), ensure_ascii=False))
        check("编辑任务保留了 mask", bool(params.get("mask_url")))

        # 7) 画布图层持久化（图层面板数据源）
        resp = client.post("/api/projects", json={"name": "E2E 验证项目"})
        project_id = resp.json()["data"]["id"]
        resp = client.post(f"/api/projects/{project_id}/canvases", json={"name": "图层画布"})
        canvas_id = resp.json()["data"]["id"]
        element = {
            "id": "el-e2e-1",
            "type": "image",
            "x": 100,
            "y": 120,
            "width": 320,
            "height": 320,
            "fileId": "file-e2e-1",
            "customData": {"name": "E2E 图层"},
        }
        state = {"elements": [element], "appState": {"viewBackgroundColor": "#ffffff"}, "files": {}}
        resp = client.patch(f"/api/canvases/{canvas_id}", json={"state": state})
        check("保存画布图层状态", resp.status_code == 200, f"HTTP {resp.status_code}")
        resp = client.get(f"/api/canvases/{canvas_id}")
        saved = (resp.json()["data"].get("state") or {}).get("elements") or []
        ok = len(saved) == 1 and saved[0]["id"] == "el-e2e-1" and saved[0]["customData"]["name"] == "E2E 图层"
        check("图层元素可持久化并回读", ok, f"{len(saved)} 个元素")

        # 8) 额度扣减（编辑与生图都应扣费）
        resp = client.get("/api/me/quota")
        balance = resp.json()["data"]["balance"]
        check("额度已按任务扣减", balance < 200, f"当前余额 {balance}")

        # 9) 自清理：删除本次创建的验证项目，避免污染工作区
        cleanup = client.delete(f"/api/projects/{project_id}")
        check("清理验证项目", cleanup.status_code == 200, f"HTTP {cleanup.status_code}")

    print("\n" + "=" * 56)
    print(f"通过 {len(PASS)} 项 / 失败 {len(FAIL)} 项")
    if FAIL:
        print("失败项：")
        for item in FAIL:
            print("  -", item)
    return 0 if not FAIL else 1


if __name__ == "__main__":
    sys.exit(main())
