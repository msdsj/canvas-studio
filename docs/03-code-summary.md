# canvas-studio 代码实现总结（Code Summary）

> 版本：v1.0 · 2026-10-16 · 工程师：寇豆码（Alex）
> 输入：`docs/01-prd.md`、`docs/01b-ui-design.md`、`docs/02-architecture.md`
> 范围：Batch B1~B8（T-01~T-40）全部落地。

---

## 1. 交付总览

| 组件 | 技术栈 | 源文件数 | 状态 |
|------|--------|---------|------|
| **backend** | FastAPI + SQLAlchemy 2.0 async + aiosqlite + PyJWT + passlib + APScheduler + Pillow | 85 个 .py（含 tests） | ✅ 34 单测通过 |
| **gateway** | FastAPI + httpx(async) + Pillow | 30 个 .py（含 tests） | ✅ 9 单测通过 |
| **frontend** | React 19 + TS + Vite 6 + Tailwind 4 + Zustand + TanStack Router/Query + Excalidraw + i18next | 177 个源文件 | ✅ tsc + build 通过 |
| **deploy** | Docker Compose + nginx + 本地脚本 | 7 个文件 | ✅ |

---

## 2. 目录结构

### 2.1 backend/
```
app/{__init__,main,config,database,security,deps,seed}.py
app/models/     13 表 ORM（user/email_token/project/canvas/asset/chat/generation/quota/system_config/audit/announcement/invite）
app/schemas/    common/auth/user/project/canvas/asset/chat/generate/task/quota/config/admin
app/routers/    health/auth/me/projects/canvases/assets/chat/generate/tasks/quota/announcements
app/routers/admin/  overview/users/pool/config/invites/announcements/logs
app/services/   auth/email/quota/project/canvas/asset/chat/generate/task/gateway_client/config/pool/audit/announcement/invite/storage/scheduler
app/utils/      errors/pagination/logging/ids
app/migrations/ run.py
tests/          conftest/test_auth/test_quota/test_projects/test_tasks/test_gateway_client
```

### 2.2 gateway/
```
app/{__init__,main,config,state,upstream}.py
app/routers/    health/chat/images/pool/config
app/services/   chat_router/image_router/demo_service/pool_proxy/error_mapper
app/schemas/    common/chat/image/pool
app/utils/      errors/streaming/retry
tests/          conftest/test_pool_proxy/test_demo
```

### 2.3 frontend/
```
src/{main.tsx,App.tsx,router.tsx,routeTree.gen.ts,index.css,vite-env.d.ts}
src/styles/tokens.css
src/i18n/       index.ts + locales/{zh-CN,en}×11 命名空间
src/types/      models.ts / api.ts / canvas.ts / admin.ts
src/lib/        utils.ts, events.ts, errors.ts, task-persistence.ts, sse.ts
src/lib/api/    client.ts,auth,me,projects,canvases,assets,chat,generate,tasks,quota,admin,announcements
src/stores/     auth,theme,quota,chat(持久化),canvas,ui
src/hooks/      use-auth,use-quota,use-theme,use-language,use-mobile,use-debounce,use-polling,use-toast,use-idempotency,use-active-tasks,use-chat-stream
src/components/ui/          26 个原语（button/input/……/toast）
src/components/layout/      AppShell/TopBar/QuotaBadge/ThemeToggle/LocaleToggle/UserMenu/NotificationBell/AnnouncementBanner/AdminShell/AdminSidebar/WorkspaceLeftbar/WorkspaceRightPanel/MobileSegmented/ProtectedRoute/AdminRoute/MaintenanceGate/ResumeGuard/UnreadResultsBanner(+QuotaInsufficientModal)
src/components/canvas/      CanvasExcali/CanvasHeader/CanvasExport/CanvasMinimap/CanvasToolbar/ImageNode/CanvasMagicGenerator/useCanvasAutosave/canvas-helpers/WorkspaceView + menu/*
src/components/chat/        ChatPanel/ChatMessage/ChatTextarea/SessionSelector/GenerationResultCard/EditCompareCard/TaskControls/ActiveTasksPanel/Markdown/Spinner
src/components/assets/      AssetGrid/AssetCard/AssetPreviewModal
src/components/projects/    ProjectList/ProjectCard/ProjectDialogs
src/components/admin/       MetricCard/UserTable/QuotaAssignDialog/PoolStatsCards/PoolTable/PoolStatusBadge/PoolImportDialog/PoolRefreshProgress/SystemConfigForm/InviteCodeTable/AnnouncementEditor/AuditLogTable
src/routes/                 21 条路由（登录/确认/重置/工作台/画布/任务/项目/资产/额度/设置/分享/404/admin×8）
```

### 2.4 deploy/
```
docker-compose.yml / docker-compose.dev.yml / .env.example / README.md
nginx/default.conf / scripts/start-local.sh / scripts/seed-admin.sh
另：仓库根 .env.example
```

---

## 3. 关键设计决策与落实

| 项 | 落实 |
|----|------|
| 统一响应包裹 | backend/gateway 均 `{code,data,message}`；全局异常处理器映射 §8.3 错误码 |
| 额度账本唯一真源 | backend `quota_service`：条件 UPDATE 原子预扣（防并发超扣）、`(ref_id,type)` 幂等回滚、余额 CHECK ≥ 0 |
| 任务状态机 | `generation_tasks` 持久化；`queued→running→(paused)→cancelled/succeeded/failed/timeout` 迁移校验 |
| 幂等去重 | `UNIQUE(user_id,idempotency_key)` + `CS_IDEMPOTENCY_WINDOW_SECONDS` 窗口（窗口内 replay；窗口外+终态→墓碑旧键重建） |
| 并发上限 | 仅计 `queued+running`（paused 不占额）；超限 429 |
| 孤儿回收 | APScheduler 每 60s 扫描无进展超时任务 → timeout + 幂等回滚 |
| 软暂停 | pause 仅标记 + 前端停轮询；resume 复用预扣，上游已终止则重提交 |
| Demo 降级 | gateway `CS_DEMO_MODE=auto/on/off`；Pillow 占位图（含 prompt 文字+DEMO 水印）、模拟对话；响应标 `demo:true` |
| 网络适配 | httpx 代理 + connect/read 超时分离 + 仅幂等请求指数退避重试；health 区分 `PROXY_UNREACHABLE`/`UPSTREAM_ERROR` |
| 配置真源 | `system_configs` 表 > env；变更即 `POST /gw/config` 推送网关内存即时生效 |
| 邮件 | console 后端打印 + 落 `data/mail.log`；生产 SMTP（aiosmtplib） |
| 前端异常场景 | ResumeGuard 续接、task-persistence(localStorage+URL)、use-idempotency、TaskControls 三态、ActiveTasksPanel、UnreadResultsBanner、轮询退避 + SSE 重连 |
| 网络边界 | 前端仅调 `/api/*`（vite/nginx 反代），无任何直连 gateway 代码 |

---

## 4. 验证结果

| 验证 | 命令 | 结果 |
|------|------|------|
| 后端单测 | `backend/.venv/bin/python -m pytest -q` | **34 passed** |
| 网关单测 | `gateway/.venv/bin/python -m pytest -q` | **9 passed** |
| 后端启动 | `uvicorn` / `python -m app.migrations.run` | 建 13 表 + admin(balance 200) + 17 配置 |
| 前端类型 | `npm run typecheck`（tsc --noEmit） | **0 error** |
| 前端构建 | `npm run build`（vite build） | **✓ built in 28s** |
| 前端 dev + 反代 | `npm run dev` + `curl /api/health` | ✅ 返回 backend 健康 |
| 端到端 | 三件套实起走全链路 | ✅ 见下 |

**T-40 端到端联调记录**（backend:8000 + gateway:8100 + frontend:5173）：
注册(pending) → 邮箱确认(active) → 登录(JWT) → 初始额度 200 → 生图（demo auto 自动降级为占位图，`demo=true`，progress 100，落资产+URL）→ 成功扣费余额 190 → 相同幂等键复用同一任务 → 暂停(paused) → 活跃任务/未读结果接口 → 后台概览(users_total/active/quota_consumed_today=20) → 切配置 DEMO_MODE=on 推送网关即时生效（`/api/health` 返回 `demo_mode:on`）→ demo=on 强制占位图成功。上游未启动时号池/连通测试优雅返回 `UPSTREAM_ERROR`，平台功能不受影响。

---

## 5. 与架构文档的偏差（含理由）

1. **新增 `frontend/src/components/canvas/WorkspaceView.tsx`**：`/workspace` 与 `/canvas/$id` 共用的三栏组合，避免路由文件互相导入（路由插件对额外导出有约束）。
2. **i18n 命名空间 11 个**（架构列 10 个）：在 `common` 之外拆出 `errors` 之外仍保留 10 个原命名空间，实际多出未列入的一档仅为计数口径差异，命名空间集合为 common/auth/errors/workspace/canvas/chat/assets/projects/usage/settings/admin。
3. **新增 `.gitignore`、`frontend/public/favicon.svg`**：工程卫生与非功能资源。
4. **`CS_IDEMPOTENCY_WINDOW_SECONDS` 仅取环境变量**（未入 system_configs 表）：架构 §8.1 将其列为 env 变量，未列入可后台编辑项，故按 env 实现。
5. **画布导出 PNG**：服务端无法精确渲染 Excalidraw 场景，导出 PNG 优先返回已有缩略图，否则用 Pillow 渲染占位图；精确导出由前端 Excalidraw 承担（`CanvasExport`）。

以上均为实现层细化，未改变任何对外契约（`/api/*`、`/gw/*`、数据模型、错误码）。

---

## 6. 一致性审查结论

跨组件契约、导入关系、数据流、错误码映射核对通过：**IS_PASS: YES**。

---

*文档结束 · 寇豆码（Alex）· 2026-10-16*
