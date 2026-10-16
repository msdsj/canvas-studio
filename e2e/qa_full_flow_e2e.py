#!/usr/bin/env python3
"""canvas-studio 端到端全链路验收脚本（QA 独立编写）。

用途：**真实启动三件套**（backend:8000 + gateway:8100 + frontend dev:5173），
以真实 HTTP 请求走通并验证 PRD 核心链路与四个异常场景：

  注册(pending) → 邮箱确认(active) → 登录 → 初始额度 200
  → 生图（Demo 自动降级占位图，demo=true）扣 10 余 190
  → 结果未读提醒 / 已读清除（P0-31）
  → 幂等去重：同 Idempotency-Key 只建一个任务、只扣一次费（P0-32）
  → 暂停 → 恢复 → 刷新续接（重启 backend 后任务仍可查，P0-28/29/30）
  → 放弃 → 幂等回滚额度（P0-29）
  → 上游不可达显式反馈、不扣额、不产生卡死任务（P0-36）

运行方式（在仓库根目录）：
  backend/.venv/bin/python e2e/qa_full_flow_e2e.py

脚本自带黑盒「黑洞」上游（accept 后不应答）用于制造“任务进行中”的确定性场景，
测试结束自动清理所有子进程、临时数据库与临时存储目录。
"""
from __future__ import annotations

import os
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
GATEWAY = ROOT / "gateway"
FRONTEND = ROOT / "frontend"

BACKEND_PORT = 8000
GATEWAY_PORT = 8100
FRONTEND_PORT = 5173
INTERNAL_TOKEN = "qa-e2e-internal-token"
ADMIN_EMAIL = "admin@canvas.studio"
ADMIN_PASSWORD = "Admin@12345"

BACKEND_BASE = f"http://127.0.0.1:{BACKEND_PORT}"
GATEWAY_BASE = f"http://127.0.0.1:{GATEWAY_PORT}"
FRONTEND_BASE = f"http://127.0.0.1:{FRONTEND_PORT}"

RESULTS: list[tuple[str, bool, str]] = []


# --------------------------------------------------------------------------
# 结果记录
# --------------------------------------------------------------------------
def check(name: str, ok: bool, detail: str = "") -> bool:
    """记录一条断言结果并打印。"""
    RESULTS.append((name, ok, detail))
    flag = "PASS" if ok else "FAIL"
    line = f"[{flag}] {name}"
    if detail and not ok:
        line += f"  → {detail}"
    print(line, flush=True)
    return ok


# --------------------------------------------------------------------------
# 进程 / 端口 工具
# --------------------------------------------------------------------------
def port_free(port: int) -> bool:
    """端口是否空闲。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind(("127.0.0.1", port))
            return True
        except OSError:
            return False


def wait_http(url: str, timeout: float = 40.0, expect: int = 200,
              headers: dict | None = None) -> bool:
    """轮询等待 URL 返回期望状态码。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            resp = httpx.get(url, timeout=3.0, headers=headers or {})
            if resp.status_code == expect:
                return True
        except Exception:  # noqa: BLE001
            pass
        time.sleep(0.4)
    return False


def start_proc(cwd: Path, cmd: list[str], env: dict, log_path: Path) -> subprocess.Popen:
    """启动一个子进程并重定向输出到日志。"""
    log = open(log_path, "w")  # noqa: SIM115
    return subprocess.Popen(
        cmd, cwd=str(cwd), env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True
    )


def stop_proc(proc: subprocess.Popen | None) -> None:
    """终止子进程及其进程组。"""
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:  # noqa: BLE001
        proc.terminate()
    try:
        proc.wait(timeout=10)
    except Exception:  # noqa: BLE001
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except Exception:  # noqa: BLE001
            proc.kill()


# --------------------------------------------------------------------------
# 黑洞上游：accept 连接但从不响应（制造“任务进行中”）
# --------------------------------------------------------------------------
class Blackhole:
    """一个只 accept、不回复的 TCP 服务，用于让上游请求挂起。"""

    def __init__(self) -> None:
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", 0))
        self._sock.listen(16)
        self.port = self._sock.getsockname()[1]
        self._held: list[socket.socket] = []
        self._stop = False
        self._thread = threading.Thread(target=self._serve, daemon=True)
        self._thread.start()

    def _serve(self) -> None:
        self._sock.settimeout(0.5)
        while not self._stop:
            try:
                conn, _ = self._sock.accept()
                self._held.append(conn)
            except socket.timeout:
                continue
            except OSError:
                break

    @property
    def base_url(self) -> str:
        """给上游使用的地址。"""
        return f"http://127.0.0.1:{self.port}"

    def close(self) -> None:
        """关闭监听与所有已持有连接。"""
        self._stop = True
        for conn in self._held:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass
        try:
            self._sock.close()
        except Exception:  # noqa: BLE001
            pass


# --------------------------------------------------------------------------
# 数据库读取（跨进程读临时 sqlite）
# --------------------------------------------------------------------------
def db_scalar(db_path: Path, sql: str, params: tuple = ()):  # noqa: ANN201
    """读取单个标量值。"""
    con = sqlite3.connect(str(db_path), timeout=5)
    try:
        row = con.execute(sql, params).fetchone()
        return row[0] if row else None
    finally:
        con.close()


def latest_verify_token(db_path: Path) -> str | None:
    """读取最新未使用的确认 token。"""
    return db_scalar(
        db_path,
        "SELECT token FROM email_tokens WHERE type='verify' AND used_at IS NULL "
        "ORDER BY created_at DESC LIMIT 1",
    )


def balance_of(db_path: Path, email: str) -> int | None:
    """读取用户余额。"""
    return db_scalar(db_path, "SELECT balance FROM users WHERE email=?", (email,))


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------
def main() -> int:  # noqa: C901 - 顺序编排，可读性优先
    for port in (BACKEND_PORT, GATEWAY_PORT):
        if not port_free(port):
            print(f"端口 {port} 被占用，无法进行端到端测试。", file=sys.stderr)
            return 2

    tmp = Path(tempfile.mkdtemp(prefix="canvas-e2e-"))
    db_path = tmp / "e2e.db"
    storage_dir = tmp / "storage"
    storage_dir.mkdir(parents=True, exist_ok=True)
    log_dir = tmp / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)

    blackhole = Blackhole()
    procs: dict[str, subprocess.Popen] = {}

    backend_env = {
        **os.environ,
        "CS_DATABASE_URL": f"sqlite+aiosqlite:///{db_path}",
        "CS_STORAGE_DIR": str(storage_dir),
        "CS_SECRET_KEY": "qa-e2e-secret",
        "CS_GATEWAY_BASE_URL": GATEWAY_BASE,
        "CS_GATEWAY_INTERNAL_TOKEN": INTERNAL_TOKEN,
        "CS_DEMO_MODE": "auto",
        "CS_TASK_ORPHAN_SCAN_SECONDS": "5",
    }
    gateway_env = {
        **os.environ,
        "CS_GATEWAY_INTERNAL_TOKEN": INTERNAL_TOKEN,
        "CS_DEMO_MODE": "auto",
        "CS_GW_CONNECT_TIMEOUT": "2",
        "CS_GW_READ_TIMEOUT": "20",
    }

    try:
        # ---- 启动网关 ----
        procs["gateway"] = start_proc(
            GATEWAY,
            [str(GATEWAY / ".venv/bin/python"), "-m", "uvicorn", "app.main:app",
             "--host", "127.0.0.1", "--port", str(GATEWAY_PORT), "--log-level", "warning"],
            gateway_env,
            log_dir / "gateway.log",
        )
        ok_gw = wait_http(
            f"{GATEWAY_BASE}/gw/health", 40,
            headers={"X-Internal-Token": INTERNAL_TOKEN},
        )
        check("网关启动 (:8100 /gw/health)", ok_gw)

        # ---- 启动后端 ----
        procs["backend"] = start_proc(
            BACKEND,
            [str(BACKEND / ".venv/bin/python"), "-m", "uvicorn", "app.main:app",
             "--host", "127.0.0.1", "--port", str(BACKEND_PORT), "--log-level", "warning"],
            backend_env,
            log_dir / "backend.log",
        )
        ok_be = wait_http(f"{BACKEND_BASE}/api/health", 60)
        check("后端启动 (:8000 /api/health)", ok_be)

        # ---- 启动前端 dev（可选）----
        frontend_ok = False
        if shutil.which("npm") and (FRONTEND / "node_modules").exists():
            if port_free(FRONTEND_PORT):
                procs["frontend"] = start_proc(
                    FRONTEND,
                    ["npm", "run", "dev", "--", "--host", "127.0.0.1",
                     "--port", str(FRONTEND_PORT)],
                    {**os.environ},
                    log_dir / "frontend.log",
                )
                frontend_ok = wait_http(FRONTEND_BASE + "/", 90)
        check("前端启动 (:5173)", frontend_ok, "npm/node_modules 不可用则跳过")

        if not (ok_gw and ok_be):
            print("核心服务未就绪，终止。", file=sys.stderr)
            return 1

        client = httpx.Client(base_url=BACKEND_BASE, timeout=30)

        # ================= 1. 注册 → 确认 → 登录 =================
        email = f"qa-e2e-{uuid.uuid4().hex[:8]}@example.com"
        password = "Passw0rd123"

        reg = client.post("/api/auth/register", json={"email": email, "password": password})
        check("注册成功 (P0-01/02)", reg.status_code == 200
              and reg.json()["data"]["status"] == "pending_verification",
              reg.text)

        pre_login = client.post("/api/auth/login", json={"email": email, "password": password})
        check("未确认不可登录 → 403 (P0-02)", pre_login.status_code == 403, pre_login.text)

        token = latest_verify_token(db_path)
        check("确认链接已生成 (P0-02)", bool(token))
        if token:
            verify = client.post("/api/auth/verify-email", json={"token": token})
            check("邮箱确认 → active (P0-02)",
                  verify.status_code == 200 and verify.json()["data"]["status"] == "active",
                  verify.text)

        login = client.post("/api/auth/login", json={"email": email, "password": password})
        check("登录签发 JWT (P0-04)", login.status_code == 200, login.text)
        auth = {"Authorization": f"Bearer {login.json()['data']['access_token']}"}

        quota = client.get("/api/me/quota", headers=auth)
        check("初始额度 = 200 (P0-05/13)", quota.json()["data"]["balance"] == 200, quota.text)

        # ================= 2. Demo 自动降级生图 + 扣额 =================
        gen1 = client.post(
            "/api/generate/image",
            json={"prompt": "一只在雨天打伞的柴犬，扁平插画风"},
            headers={**auth, "Idempotency-Key": f"e2e-gen-{uuid.uuid4().hex}"},
        )
        task1 = gen1.json()["data"] if gen1.status_code == 200 else {}
        check("创建生图任务 (P0-08)", gen1.status_code == 200 and task1.get("id"), gen1.text)

        task1 = _poll_task(client, auth, task1.get("id"), terminal=True, timeout=40)
        check("生图完成 succeeded (P0-08)", task1.get("status") == "succeeded",
              f"status={task1.get('status')} err={task1.get('error_code')}")
        check("Demo 自动降级 demo=true (P0-08)", task1.get("demo") is True, str(task1.get("demo")))
        check("结果图片已落库 (P0-08)", bool(task1.get("result_urls")), str(task1.get("result_urls")))
        check("生图扣除 10 → 余额 190 (P0-12)", balance_of(db_path, email) == 190,
              f"balance={balance_of(db_path, email)}")

        # ================= 3. 结果不丢失（未读 → 已读）=================
        unread = client.get("/api/tasks/unread", headers=auth).json()["data"]
        check("未读结果提醒含该任务 (P0-31)", task1["id"] in [r["id"] for r in unread])
        client.post(f"/api/generate/tasks/{task1['id']}/seen", headers=auth)
        unread2 = client.get("/api/tasks/unread", headers=auth).json()["data"]
        check("标记已读后从 unread 消失 (P0-31)", task1["id"] not in [r["id"] for r in unread2])

        # ================= 4. 幂等去重 =================
        idem_key = f"e2e-idem-{uuid.uuid4().hex}"
        a = client.post("/api/generate/image", json={"prompt": "幂等A"},
                        headers={**auth, "Idempotency-Key": idem_key}).json()["data"]
        b = client.post("/api/generate/image", json={"prompt": "幂等A"},
                        headers={**auth, "Idempotency-Key": idem_key}).json()["data"]
        check("同幂等键返回同一任务 (P0-32)", a["id"] == b["id"], f"{a['id']} vs {b['id']}")
        _poll_task(client, auth, a["id"], terminal=True, timeout=40)
        # 两次提交后仅多扣 10（190 → 180）
        check("幂等只扣一次费 (P0-32)", balance_of(db_path, email) == 180,
              f"balance={balance_of(db_path, email)}")

        # ================= 5. 暂停 → 恢复 → 刷新续接（持久化）=================
        # 让网关切到 off + 黑洞上游，使任务确定性地停留在 running
        push = client_gw_post(
            "/gw/config",
            {"demo_mode": "off", "chatgpt2api": {"base_url": blackhole.base_url}},
        )
        check("推送网关配置生效 (P0-24)", push.status_code == 200, push.text)

        gen2 = client.post(
            "/api/generate/image",
            json={"prompt": "暂停用例"},
            headers={**auth, "Idempotency-Key": f"e2e-pause-{uuid.uuid4().hex}"},
        )
        task2 = gen2.json()["data"]
        time.sleep(1.0)
        running = _poll_task(client, auth, task2["id"], terminal=False, timeout=5)
        check("任务处于进行中 running (P0-28)", running.get("status") == "running",
              f"status={running.get('status')}")

        active = client.get("/api/tasks/active", headers=auth).json()["data"]
        check("活跃列表含进行中任务 (P0-30)", task2["id"] in [r["id"] for r in active])

        paused = client.post(f"/api/generate/tasks/{task2['id']}/pause", headers=auth)
        check("暂停 → paused (P0-28)", paused.json()["data"]["status"] == "paused", paused.text)
        active_p = client.get("/api/tasks/active", headers=auth).json()["data"]
        check("暂停任务仍在活跃列表 (P0-30)", task2["id"] in [r["id"] for r in active_p])

        resumed = client.post(f"/api/generate/tasks/{task2['id']}/resume", headers=auth)
        check("恢复 → running (P0-29)", resumed.json()["data"]["status"] == "running", resumed.text)

        # ---- 刷新续接：重启 backend 进程，任务仍应可查（持久化）----
        stop_proc(procs.get("backend"))
        procs["backend"] = start_proc(
            BACKEND,
            [str(BACKEND / ".venv/bin/python"), "-m", "uvicorn", "app.main:app",
             "--host", "127.0.0.1", "--port", str(BACKEND_PORT), "--log-level", "warning"],
            backend_env,
            log_dir / "backend2.log",
        )
        restarted = wait_http(f"{BACKEND_BASE}/api/health", 60)
        check("后端重启成功 (P0-30 前置)", restarted)

        active_r = client.get("/api/tasks/active", headers=auth)
        ids_r = [r["id"] for r in active_r.json()["data"]] if active_r.status_code == 200 else []
        check("重启后任务仍可查（持久化 P0-30）", task2["id"] in ids_r,
              f"status={active_r.status_code}")

        # ================= 6. 放弃 → 幂等回滚 =================
        before = balance_of(db_path, email)
        cancelled = client.post(f"/api/generate/tasks/{task2['id']}/cancel", headers=auth)
        check("放弃 → cancelled (P0-29)", cancelled.json()["data"]["status"] == "cancelled",
              cancelled.text)
        after = balance_of(db_path, email)
        check("放弃后回滚未消耗额度 (P0-29)", after == before + 10, f"{before} → {after}")

        again = client.post(f"/api/generate/tasks/{task2['id']}/cancel", headers=auth)
        check("重复放弃幂等，余额不变 (P0-29)",
              again.json()["data"]["status"] == "cancelled" and balance_of(db_path, email) == after,
              again.text)

        # ================= 7. 上游不可达：显式反馈、不扣额 =================
        # 指向一个确定不可达端口（demo off，不降级）
        client_gw_post(
            "/gw/config",
            {"demo_mode": "off", "chatgpt2api": {"base_url": "http://127.0.0.1:1"}},
        )
        before2 = balance_of(db_path, email)
        gen3 = client.post(
            "/api/generate/image",
            json={"prompt": "上游不可达"},
            headers={**auth, "Idempotency-Key": f"e2e-up-{uuid.uuid4().hex}"},
        )
        task3 = gen3.json()["data"]
        task3 = _poll_task(client, auth, task3["id"], terminal=True, timeout=40)
        check("上游不可达任务进入终态失败 (P0-36)",
              task3.get("status") == "failed", f"status={task3.get('status')}")
        check("上游不可达错误码归一 (P0-36)",
              task3.get("error_code") in {"PROXY_UNREACHABLE", "UPSTREAM_ERROR"},
              str(task3.get("error_code")))
        check("上游不可达不扣额 (P0-36)", balance_of(db_path, email) == before2,
              f"{before2} → {balance_of(db_path, email)}")

        # 恢复 demo，验证服务端仍可用
        client_gw_post("/gw/config", {"demo_mode": "auto", "chatgpt2api": {"base_url": "http://localhost:3000"}})
        health2 = client.get("/api/health")
        check("上游异常后服务端仍健康 (P0-36)", health2.status_code == 200, health2.text)

        # ================= 8. 前端反代（若已启动）=================
        if frontend_ok:
            proxied = httpx.get(f"{FRONTEND_BASE}/api/health", timeout=10)
            check("前端 dev 反代 /api → backend",
                  proxied.status_code == 200 and proxied.json()["code"] == "OK",
                  proxied.text[:200])

        client.close()

    finally:
        for proc in procs.values():
            stop_proc(proc)
        blackhole.close()
        # 保留失败日志便于排查
        failed = [r for r in RESULTS if not r[1]]
        if failed:
            print(f"\n日志目录：{log_dir}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    total = len(RESULTS)
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    print(f"\n===== E2E 汇总：{passed}/{total} 通过 =====")
    return 0 if passed == total else 1


def _poll_task(client: httpx.Client, auth: dict, task_id: str | None,
               terminal: bool, timeout: float = 40) -> dict:
    """轮询任务直到满足条件或超时。"""
    if not task_id:
        return {}
    deadline = time.time() + timeout
    last: dict = {}
    while time.time() < deadline:
        resp = client.get(f"/api/generate/tasks/{task_id}", headers=auth)
        if resp.status_code != 200:
            return {"status": f"http_{resp.status_code}"}
        last = resp.json()["data"]
        if terminal and last["status"] in {"succeeded", "failed", "cancelled", "timeout"}:
            return last
        if not terminal and last["status"] == "running":
            return last
        time.sleep(0.4)
    return last


def client_gw_post(path: str, payload: dict) -> httpx.Response:
    """以内部令牌直接调用网关（模拟 backend 配置推送）。"""
    return httpx.post(
        f"{GATEWAY_BASE}{path}", json=payload,
        headers={"X-Internal-Token": INTERNAL_TOKEN}, timeout=10,
    )


if __name__ == "__main__":
    sys.exit(main())
