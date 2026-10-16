#!/usr/bin/env bash
# 初始化管理员（幂等）：直接执行后端 migrations/seed
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR/backend"

if [ ! -x .venv/bin/python ]; then
  echo "未找到 backend/.venv，请先运行 deploy/scripts/start-local.sh 或手动创建虚拟环境" >&2
  exit 1
fi

.venv/bin/python -m app.migrations.run
echo "管理员已初始化：${CS_DEFAULT_ADMIN_EMAIL:-admin@canvas.studio}"
