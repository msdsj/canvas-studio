#!/usr/bin/env bash
# canvas-studio 本地常驻启动脚本（脱离 AI 会话独立运行）
#
# 用法：
#   ./start-local-daemon.sh start    启动全部服务（后台常驻）
#   ./start-local-daemon.sh stop     停止全部服务
#   ./start-local-daemon.sh restart  重启
#   ./start-local-daemon.sh status   查看状态
#   ./start-local-daemon.sh logs     跟踪日志（Ctrl+C 退出跟踪，服务不受影响）
#
# 访问：前端 http://localhost:27180
# 账号：admin@canvas.studio / Admin@12345

set -uo pipefail

# 脚本位于 deploy/scripts，仓库根目录需要向上两级。
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LOG_DIR="$ROOT/logs"
PID_DIR="$ROOT/.run"
NODE_BIN="${NODE_BIN:-$(dirname "$(command -v node 2>/dev/null || echo node)")}"

GW_PORT=27182
BE_PORT=27181
FE_PORT=27180

# 上游生图/生文服务（chatgpt2api）。不在本仓库内，默认取同级的 chatgpt2api-main。
# 未提供 UPSTREAM_DIR 或目录不存在时自动跳过，不影响三个主服务。
UPSTREAM_PORT="${UPSTREAM_PORT:-3000}"
UPSTREAM_DIR="${UPSTREAM_DIR:-$ROOT/../chatgpt2api-main}"

mkdir -p "$LOG_DIR" "$PID_DIR"

is_alive() {  # $1=pidfile
  local pid
  pid="$(cat "$1" 2>/dev/null)" || return 1
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

port_busy() {  # $1=port
  lsof -iTCP:"$1" -sTCP:LISTEN -P -n >/dev/null 2>&1
}

stop_one() {  # $1=name
  local pid_file="$PID_DIR/$1.pid"
  if is_alive "$pid_file"; then
    local pid; pid="$(cat "$pid_file")"
    kill "$pid" 2>/dev/null
    for _ in {1..20}; do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
    kill -9 "$pid" 2>/dev/null
    echo "  ✓ 已停止 $1 (pid $pid)"
  else
    echo "  · $1 未在运行"
  fi
  rm -f "$pid_file"
}

start_one() {  # $1=name  $2=workdir  $3..=cmd
  local name="$1" workdir="$2"; shift 2
  local pid_file="$PID_DIR/$name.pid"

  if is_alive "$pid_file"; then
    echo "  · $name 已在运行 (pid $(cat "$pid_file"))"
    return 0
  fi

  ( cd "$workdir" && "$@" >"$LOG_DIR/$name.log" 2>&1 & echo $! >"$pid_file" )
  sleep 0.6
  if is_alive "$pid_file"; then
    echo "  ✓ 已启动 $name (pid $(cat "$pid_file"))"
  else
    echo "  ✗ $name 启动失败，见 $LOG_DIR/$name.log"; rm -f "$pid_file"; return 1
  fi
}

do_start() {
  echo "==> 启动 canvas-studio"

  # 上游只在这里做一次探测：真正拉起放在三个主服务之后（见下方 start_if_needed up），
  # 因为界面能不能打开不依赖它，只有号池/生图依赖。本机 Docker 通常不可用，
  # 走 .venv 直启；Docker 可用时才用容器。
  if port_busy "$UPSTREAM_PORT"; then
    echo "  ✓ 上游服务已在运行 ($UPSTREAM_PORT)"
  elif command -v docker >/dev/null 2>&1 \
       && docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx chatgpt2api; then
    echo "  … 正在启动上游容器 chatgpt2api"
    docker start chatgpt2api >/dev/null 2>&1
    sleep 5
    port_busy "$UPSTREAM_PORT" && echo "  ✓ 上游容器已启动 ($UPSTREAM_PORT)" \
                              || echo "  ! 上游容器启动失败，号池/生图不可用"
  else
    echo "  … 上游将由 .venv 直接拉起（Docker 不可用）"
  fi

  # 端口预检：区分「本脚本自己启动的」与「外部进程占用」
  for spec in "gw:$GW_PORT" "be:$BE_PORT" "fe:$FE_PORT"; do
    local n="${spec%%:*}" p="${spec##*:}"
    if port_busy "$p" && ! is_alive "$PID_DIR/$n.pid"; then
      echo "  ! 端口 $p 被外部进程占用，跳过 $n 服务"
      echo "    如需接管：kill $(lsof -tiTCP:$p -sTCP:LISTEN | tr '\n' ' ')"
    fi
  done

  start_if_needed() {  # $1=name  $2=port  $3=workdir  $4..=cmd
    local name="$1" port="$2" workdir="$3"; shift 3
    if is_alive "$PID_DIR/$name.pid"; then
      echo "  · $name 已在运行 (pid $(cat "$PID_DIR/$name.pid"))"
    elif port_busy "$port"; then
      echo "  ! $name 未启动（端口 $port 被占用）"
    else
      start_one "$name" "$workdir" "$@"
    fi
  }

  start_if_needed gw "$GW_PORT" "$ROOT/gateway" \
    "$ROOT/gateway/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$GW_PORT" || return 1

  start_if_needed be "$BE_PORT" "$ROOT/backend" \
    "$ROOT/backend/.venv/bin/uvicorn" app.main:app --host 127.0.0.1 --port "$BE_PORT" || return 1

  start_if_needed fe "$FE_PORT" "$ROOT/frontend" \
    env -u NODE_OPTIONS -u PYTHONPATH PATH="$NODE_BIN:$PATH" npm run dev -- --port "$FE_PORT" --host 127.0.0.1 || return 1

  # 上游最后启动：前端/后端/网关就绪即可浏览界面，上游只影响实际生图生文。
  if [ -d "$UPSTREAM_DIR" ] && [ -x "$UPSTREAM_DIR/.venv/bin/python" ]; then
    start_if_needed up "$UPSTREAM_PORT" "$UPSTREAM_DIR" \
      "$UPSTREAM_DIR/.venv/bin/python" -m uvicorn main:app --host 127.0.0.1 --port "$UPSTREAM_PORT" --log-level info
  else
    echo "  · 上游未配置（UPSTREAM_DIR=${UPSTREAM_DIR}），跳过；生图/生文将不可用"
  fi

  echo ""
  echo "==> 就绪（等待约 5 秒后访问）"
  echo "    前端http://localhost:$FE_PORT"
  echo "    后端    http://localhost:$BE_PORT/api/health"
  echo "    网关    http://localhost:$GW_PORT/gw/health"
  echo ""
  echo "  账号：admin@canvas.studio / Admin@12345"
}

do_stop() {
  echo "==> 停止 canvas-studio"
  for n in fe be gw up; do stop_one "$n"; done
  # 兜底：按端口清理残留
  for p in "$FE_PORT" "$BE_PORT" "$GW_PORT"; do
    local pids; pids="$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null)"
    if [ -n "$pids" ]; then kill -9 $pids 2>/dev/null; echo "  ✓ 清理端口 $p 残留进程"; fi
  done
  # 上游可能不是你启动的（外部进程），只在 pidfile 存在时才动它，避免误杀。
  if [ -f "$PID_DIR/up.pid" ]; then
    echo "  · 上游已按 pidfile 停止（端口 $UPSTREAM_PORT 未强制清理）"
  fi
}

do_status() {
  echo "==> 服务状态"
  printf "  %-10s %-8s %-10s %s\n" 服务 端口 PID 状态
  for spec in "上游:$UPSTREAM_PORT:up" "网关:$GW_PORT:gw" "后端:$BE_PORT:be" "前端:$FE_PORT:fe"; do
    local name="${spec%%:*}" rest="${spec#*:}"
    local port="${rest%%:*}" key="${rest##*:}"
    local st="未运行"
    if port_busy "$port"; then
      if is_alive "$PID_DIR/$key.pid"; then st="运行中"; else st="运行中(外部进程)"; fi
    fi
    printf "  %-10s %-8s %-10s %s\n" "$name" "$port" "$(cat "$PID_DIR/$key.pid" 2>/dev/null || echo -)" "$st"
  done
}

do_logs() {
  tail -f "$LOG_DIR"/*.log
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 1; do_start ;;
  status)  do_status ;;
  logs)    do_logs ;;
  *)       echo "用法: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
