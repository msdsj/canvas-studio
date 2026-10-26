#!/usr/bin/env bash
# 本地零依赖一键启动（无 Docker 回退路径）：后端 + 网关 + 前端
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="${PYTHON_BIN:-python3}"

echo "==> 准备后端虚拟环境"
cd "$ROOT_DIR/backend"
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
.venv/bin/pip install -q -r requirements.txt

echo "==> 初始化数据库 + 管理员 seed"
.venv/bin/python -m app.migrations.run

echo "==> 准备网关虚拟环境"
cd "$ROOT_DIR/gateway"
if [ ! -d .venv ]; then
  "$PY" -m venv .venv
fi
.venv/bin/pip install -q -r requirements.txt

echo "==> 启动网关 (:27182)"
( cd "$ROOT_DIR/gateway" && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 27182 --workers 1 & )
sleep 2

echo "==> 启动后端 (:27181)"
( cd "$ROOT_DIR/backend" && .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 27181 --workers 1 & )

echo "==> 启动前端 (:27180)"
cd "$ROOT_DIR/frontend"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi
npm run dev -- --port 27180

echo "已启动：前端 http://localhost:27180 · 后端 http://localhost:27181 · 网关 http://localhost:27182"
