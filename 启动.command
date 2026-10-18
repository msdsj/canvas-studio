#!/usr/bin/env bash
# canvas-studio 一键启动（双击运行，无需命令行知识）
#
# 用法：双击本文件即可；或终端执行 ./启动.command
# 停止：再次双击会自动切换为停止
#
# 访问：http://localhost:27180
# 账号：admin@canvas.studio / Admin@12345

cd "$(dirname "$0")" || exit 1
ROOT="$(pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

BOLD=$'\033[1m'; DIM=$'\033[2m'; GRN=$'\033[32m'; YEL=$'\033[33m'; RST=$'\033[0m'

port_busy() { lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1; }

# 若已在运行则停止，否则启动
if port_busy 27181 || port_busy 27180; then
  echo "${BOLD}停止 canvas-studio...${RST}"
  for p in 27180 27181 27182; do
    pids=$(lsof -tiTCP:$p -sTCP:LISTEN 2>/dev/null)
    [ -n "$pids" ] && kill $pids 2>/dev/null
  done
  sleep 2
  echo "${GRN}✓ 已停止${RST}"
  osascript -e 'display notification "canvas-studio 已停止" with title "Canvas Studio"' 2>/dev/null
  echo ""
  read -r "?按回车键关闭此窗口..."
  exit 0
fi

echo "${BOLD}启动 canvas-studio...${RST}"
echo ""

# 检查依赖
if [ ! -d "$ROOT/backend/.venv" ] || [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "${YEL}首次运行，正在安装依赖（可能需要几分钟）...${RST}"
  /usr/bin/sed -i '' -e 's|^HTTP_PROXY=.*|HTTP_PROXY=http://127.0.0.1:7890|' -e 's|^HTTPS_PROXY=.*|HTTPS_PROXY=http://127.0.0.1:7890|' "$ROOT/backend/.env" 2>/dev/null
  mkdir -p "$ROOT/backend/data/storage"
  "$ROOT/backend/.venv/bin/python" -m app.migrations.run >/dev/null 2>&1
  ( cd "$ROOT/frontend" && PATH="/Users/meishiduoshuijiao/.nvm/versions/node/v26.10.0/bin:$PATH" npm install --no-audit --no-fund >/dev/null 2>&1 )
fi

# 确保上游容器在运行（生图必需）
if port_busy 3000; then
  echo "${GRN}✓${RST} 上游服务  http://localhost:3000（已在运行）"
elif command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx chatgpt2api; then
  echo "${YEL}上游容器未运行，正在启动 chatgpt2api...${RST}"
  docker start chatgpt2api >/dev/null 2>&1
  sleep 5
  port_busy 3000 && echo "${GRN}✓${RST} 上游服务  http://localhost:3000" || echo "${YEL}!${RST} 上游容器启动失败，生图不可用"
else
  echo "${YEL}!${RST} 未找到 chatgpt2api 容器，生图不可用（画布/编辑等功能正常）"
fi
echo ""

# 启动网关
( cd "$ROOT/gateway" && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 27182 >"$LOG_DIR/gw.log" 2>&1 & )
sleep 2
echo "${GRN}✓${RST} 网关      http://localhost:27182"

# 启动后端
( cd "$ROOT/backend" && .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 27181 >"$LOG_DIR/be.log" 2>&1 & )
sleep 2
echo "${GRN}✓${RST} 后端      http://localhost:27181"

# 启动前端
( cd "$ROOT/frontend" && env -u NODE_OPTIONS -u PYTHONPATH PATH="/Users/meishiduoshuijiao/.nvm/versions/node/v26.10.0/bin:$PATH" npm run dev -- --port 27180 --host 127.0.0.1 >"$LOG_DIR/fe.log" 2>&1 & )
sleep 5
echo "${GRN}✓${RST} 前端      http://localhost:27180"

# 健康检查
echo ""
if curl -s -m 5 http://127.0.0.1:27181/api/health >/dev/null 2>&1; then
  echo "${GRN}${BOLD}全部就绪${RST}"
else
  echo "${YEL}后端还在启动，稍等几秒再刷新页面${RST}"
fi
echo ""
echo "  ${BOLD}账号${RST}  admin@canvas.studio / Admin@12345"
echo "  ${DIM}日志  $LOG_DIR/{gw,be,fe}.log${RST}"
echo ""

open "http://localhost:27180"
osascript -e 'display notification "启动成功，点击打开的浏览器窗口即可使用" with title "Canvas Studio"' 2>/dev/null

echo "  ${DIM}此窗口可安全关闭，服务会继续运行${RST}"
echo "  ${DIM}要停止服务：再次双击本文件${RST}"
echo ""
read -r "?按回车键关闭此窗口..."
