#!/usr/bin/env bash
# 一站式验收：后端单测 + 网关单测 + 前端类型/构建 + 真浏览器冒烟。
#
# 为什么要跑这么多层：这套代码里有三类问题各自只会在某一层暴露——
#   * 后端单测：合并算法、权限矩阵、配额记账
#   * 真 WS 冒烟：握手 / 票据 / 房间生命周期（ASGITransport 碰不到）
#   * 真浏览器冒烟：路由、i18n、协作上行下行（前两层都碰不到）
# 只跑其中一层，另外两类问题会一路带到线上。
#
# 前置：backend 与 frontend 的开发服务需已启动（backend:27181 / frontend:27180）。
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAILED=0

# 冒烟脚本要连活着的服务：缺一个就直接说清楚，别让后面的失败变成谜题。
# 前端用 localhost 探活：vite 只绑 localhost（可能是 ::1），用 127.0.0.1 会误报未启动。
for target in "127.0.0.1:27181" "127.0.0.1:27182" "localhost:27180"; do
  if ! curl -s -o /dev/null --max-time 3 "http://$target/"; then
    printf '\033[33m%s 连不上，冒烟步骤会失败\033[0m\n' "$target"
    printf '需要：backend:27181 / gateway:27182 / frontend:27180 都在跑\n'
    FAILED=1
    break
  fi
done

step() { printf '\n\033[1m▶ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; FAILED=1; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$1"; }

step "后端单测"
if (cd backend && ./.venv/bin/python -m pytest -q 2>&1 | tail -3); then
  ok "后端单测通过"
else
  fail "后端单测失败"
fi

step "网关单测"
if (cd gateway && ./.venv/bin/python -m pytest -q 2>&1 | tail -3); then
  ok "网关单测通过"
else
  fail "网关单测失败"
fi

step "前端类型检查"
if (cd frontend && npx tsc --noEmit -p tsconfig.app.json); then
  ok "类型检查通过"
else
  fail "类型检查失败"
fi

step "前端构建"
if (cd frontend && npx vite build > /tmp/cs-build.log 2>&1); then
  ok "构建通过"
else
  fail "构建失败（见 /tmp/cs-build.log）"
fi

step "生图全流程冒烟（真后端 + 真网关 → 落盘 → 入库 → 扣费）"
if (cd backend && ./.venv/bin/python scripts/smoke_generation_flow.py 2>&1 | tail -4); then
  ok "生图流程通过"
else
  fail "生图流程失败"
fi

step "共享额度池冒烟（团队付钱、成员花）"
if (cd backend && ./.venv/bin/python scripts/smoke_shared_quota.py 2>&1 | tail -4); then
  ok "共享额度池通过"
else
  fail "共享额度池失败"
fi

step "协作通道冒烟（真 uvicorn + 真 WS）"
if (cd backend && ./.venv/bin/python scripts/smoke_collab_ws.py 2>&1 | tail -3); then
  ok "协作协议通过"
else
  fail "协作协议失败"
fi

step "页面渲染冒烟（真 Chrome）"
if (cd backend && ./.venv/bin/python scripts/ui_smoke_pages.py 2>&1 | tail -4); then
  ok "页面渲染通过"
else
  fail "页面渲染失败"
fi

step "首登引导冒烟（真浏览器点完整流程）"
if (cd backend && ./.venv/bin/python scripts/ui_smoke_onboarding.py 2>&1 | tail -4); then
  ok "引导流程通过"
else
  fail "引导流程失败"
fi

step "团队权限矩阵冒烟（owner / member 两个真账号）"
if (cd backend && ./.venv/bin/python scripts/ui_smoke_team_permissions.py 2>&1 | tail -4); then
  ok "权限矩阵通过"
else
  fail "权限矩阵失败"
fi

step "两端协同冒烟（两个真浏览器标签页）"
if (cd backend && ./.venv/bin/python scripts/ui_smoke_collab_two_tabs.py 2>&1 | tail -4); then
  ok "两端协同通过"
else
  fail "两端协同失败"
fi

step "左侧对话区冒烟（切换 / 搜索 / 新建 / 删除确认）"
if (cd backend && ./.venv/bin/python scripts/ui_smoke_chat_panel.py 2>&1 | tail -4); then
  ok "对话区交互通过"
else
  fail "对话区交互失败"
fi

printf '\n'
if [ "$FAILED" -eq 0 ]; then
  printf '\033[32m全部通过\033[0m\n'
else
  printf '\033[31m有失败项，见上\033[0m\n'
fi
exit "$FAILED"
