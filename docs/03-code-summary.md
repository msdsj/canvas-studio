# canvas-studio 代码实现总结（Code Summary）

> 版本：v2.0 · 2026-10-20
> 输入：`docs/01-prd.md`、`docs/01b-ui-design.md`、`docs/02-architecture.md`、
> `docs/10-architecture-analysis-and-team-design.md`、`docs/11-team-collab-and-onboarding.md`
> 范围：v1 基线（Batch B1~B8）+ v2 增量（M0~M6：首登引导、团队体系、多人协作、生图链路、模型统管）

本文只回答「代码在哪、有多少、怎么跑、怎么验证」；设计论证见
`docs/10-architecture-analysis-and-team-design.md` 与 `docs/11-team-collab-and-onboarding.md`。

---

## 1. 交付总览

| 组件 | 技术栈 | 源文件 | 代码行 | 验证 |
|------|--------|--------|--------|------|
| **backend/app** | FastAPI + SQLAlchemy 2.0 async + aiosqlite + PyJWT + passlib + APScheduler + Pillow | 115 个 .py | 22,617 | ✅ 424 单测 |
| **backend/tests** | pytest + pytest-asyncio + ASGITransport | 37 个 .py | 9,426 | ↑ 同上 |
| **backend/scripts** | 端到端 / 浏览器冒烟（CDP） | 9 个 .py | 2,789 | ✅ 8 个脚本 |
| **gateway** | FastAPI + httpx(async) + Pillow | 29 个 .py（+9 测试） | 3,878 | ✅ 64 单测 |
| **frontend** | React 19 + TS 5.7 + Vite 6 + Tailwind 4 + Zustand 5 + TanStack Router/Query + Excalidraw 0.18 + i18next | 250 个 .ts/.tsx | 38,737 | ✅ tsc + build + 5 个浏览器冒烟 |
| **deploy** | Docker Compose + nginx + 本地脚本 | 8 个文件 | — | ✅ |

一键验收：`bash scripts/verify_all.sh`（12 步，见 §6）。

---

## 2. 目录结构

### 2.1 backend/

```
app/{main,config,database,security,deps,seed}.py
app/models/     22 张表（见下）
app/schemas/    common/auth/user/project/canvas/asset/chat/generate/task/quota/
                config/admin/team/onboarding/ai_provider
app/routers/    health/auth/me/projects/canvases/assets/chat/generate/tasks/quota/
                announcements/skills/ai/teams/onboarding/collab
app/routers/admin/  overview/users/pool/config/invites/announcements/logs
app/services/   access(权限中枢)/team_service/skill_packs/collab_hub/collab_service/
                canvas_doc/quota/task/generate/compose/chat/project/canvas/asset/
                relay_service/relay_chain/gateway_client/config/pool/audit/
                announcement/invite/pro_service/storage/scheduler/
                intent_plan/plan_service/plan_validator/batch_service/vision_service/
                edit_handlers/edit_ops/edit_prompt_service/cutout/polish/prompt/skills
app/utils/      errors/pagination/logging/ids
app/migrations/ run.py（幂等 ALTER：加列 / 加索引）
app/data/       personas.json + skill_packs/（16 包 · 490 条技能 · 已入库的产品资产）
scripts/        8 个验证脚本 + _smoke_common.py（见 §6）
tests/          37 个文件
```

**22 张表**：`users` `email_tokens` `teams` `team_members` `team_invitations`
`canvas_projects` `canvases` `canvas_collaborators` `assets` `chat_sessions`
`chat_messages` `generation_tasks` `skill_runs` `quota_transactions`
`ai_providers` `system_configs` `audit_logs` `announcements` `invite_codes`
`pro_codes` `user_skill_packs` `team_skill_packs` `user_skill_overrides`

v2 新增 7 张：`teams` / `team_members` / `team_invitations` /
`canvas_collaborators` / `user_skill_packs` / `team_skill_packs` / `user_skill_overrides`。

### 2.2 gateway/

```
app/{main,config,state,upstream}.py
app/routers/    health/chat/images/pool/config
app/services/   chat_router/image_router/demo_service/pool_service/
                account_pool/error_mapper/resilience/provider_client
app/schemas/    common/chat/image/pool
app/utils/      errors/streaming/upstream_json
```

网关不持有业务状态：只做「provider 转发 + 号池调度 + 演示降级」。
配置由后端 `POST /gw/config` 推送，运行时缓存在内存里——所以
**直接给网关进程设 `CS_DEMO_MODE` 会被后端推回**，改演示模式必须走
`PUT /api/admin/config`。

### 2.3 frontend/

```
src/lib/api/          auth/projects/canvases/assets/chat/generate/tasks/quota/
                      admin/ai/teams/onboarding/collab
src/stores/           auth/team/theme/quota/chat/canvas/ui
src/hooks/            use-auth/use-canvas-collab/use-team-scope/use-stage-timer/…
src/components/
  layout/             AppShell/ProtectedRoute/WorkspaceIdentityBar/UserMenu/PageShell
  canvas/             WorkspaceView/CanvasHeader/CollabPresence/
                      useSceneDiff/useCanvasCollabScene
  chat/               ChatPanel/ChatMessage/ChatTextarea/GenerationResultCard/
                      SessionSelector/ClarifyCard/SkillLibraryPanel/PolishPopover/…
  team/               TeamModelConfigCard/TeamSkillsCard/TeamSwitcher
  ai/                 AIConfigDialog
  ui/                 button/dialog/badge/smart-image/pagination/…
src/routes/           onboarding/skills/team{,.index,.members,.settings,.audit}/
                      team_.join/workspace/projects/assets/canvas.$id/…
src/i18n/locales/     zh-CN + en（namespace 由 import.meta.glob 自动收集）
```

> `team_.join.tsx` 的下划线是 TanStack Router 的「不套父布局」约定。
> 写成 `team.join.tsx` 会让邀请落地页渲染出团队设置页的布局（实测踩过）。

---

## 3. v2 新增模块速查

| 模块 | 位置 | 职责 |
|------|------|------|
| 访问中枢 | `services/access.py` | `TeamContext` / `resolve_context` / `require_permission` / `can_access_canvas` / 各处 `*_scope_clause`。**403 = 存在但你无权，404 = 不存在或不是成员** |
| 团队服务 | `services/team_service.py` | 建团、席位、成员、所有权转移、邀请、用量、充值、团队模型配置 |
| 技能包 | `services/skill_packs.py` | 加载 16 个内置包 → 按人格/团队/用户覆盖算出有效集 → 渲染进提示词（≤8 条 / 200 字） |
| 画布文档 | `services/canvas_doc.py` | 元素级 diff / patch / LWW 合并 / 墓碑清理，视口键永不合并 |
| 协作房间 | `services/collab_hub.py` | 内存房间、版本环形缓冲（200）、presence、`replay_after` |
| 协作持久化 | `services/collab_service.py` | 房间开合、票据、防抖落库（1.5s）、`flush_and_close` |
| 协作路由 | `routers/collab.py` | 票据、参与者、WS 端点（`?ticket=…&since=…`） |
| 前端协作 | `hooks/use-canvas-collab.ts` + `components/canvas/useSceneDiff.ts` + `useCanvasCollabScene.ts` | WS 生命周期、指数退避、scene diff、回环抑制 |

---

## 4. 关键不变量（改代码前先读）

1. **个人 provider 的唯一真源在「个人空间」**；团队模型只有一个入口
   `PUT /api/teams/{id}/model-config`。团队空间里 `editable` 恒为 `false`，
   `can_manage` 区分「没权限」与「换个地方改」。
2. **团队成员自动获得 Pro 能力**（`isPro = role==pro || admin || 属于某团队`），
   但「当前在团队空间」不影响这个判定——否则切回个人空间就掉权限。
3. **共享额度池 opt-in**（`settings.shared_quota`，默认 false）；
   开启时赠 `TEAM_INITIAL_GRANT=2000`；池空**不回落**个人余额。
4. **额度账本**：`pre_deduct`（原子条件 UPDATE）→ `confirm` / `refund`，
   幂等键 `(ref_id, type)`。退款必须退到**扣款时那个池**。
5. **平台角色与团队角色正交**：`users.role=admin` 与 `team_members.role=owner`
   互不影响，判断时永远看清楚问的是哪一个。
6. **技能包是产品资产**（`app/data/skill_packs/`），不在运行时读用户桌面；
   提示词注入任何异常都只 `logger.warning`，绝不让一轮对话失败。
7. **迁移必须幂等**：没有 Alembic，靠 `create_all` + `_ensure_column` / `_ensure_index`，
   新加的列要能在已有库上重跑。
8. **前后端契约要断言响应体**：`CanvasOut` 少一个 `team_id` 就让协作通道永不启动，
   而 HTTP 层一切正常（字段只是「没返回」）。见 §6 的第 11 步。

---

## 5. 本地启动

```bash
# 后端 27181
cd backend && ./.venv/bin/python -m uvicorn app.main:app --port 27181

# 网关 27182
cd gateway && ./.venv/bin/python -m uvicorn app.main:app --port 27182

# 前端 27180（用 localhost 访问，vite 只绑 localhost）
cd frontend && npx vite --port 27180
```

演示模式（无需真上游也能出图）：

```bash
curl -X PUT http://127.0.0.1:27181/api/admin/config \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{"DEMO_MODE":"on"}'
```

重新生成技能包：

```bash
/Users/lxx/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 \
  scripts/import_skill_prompts.py
./backend/.venv/bin/python scripts/export_design_skill_packs.py
```

---

## 6. 验证

```bash
bash scripts/verify_all.sh
```

| # | 步骤 | 脚本 / 命令 | 覆盖什么 |
|---|------|------------|---------|
| 1 | 后端单测 | `backend/.venv/bin/python -m pytest -q` | 算法、权限、账本、幂等 |
| 2 | 网关单测 | `gateway/.venv/bin/python -m pytest -q` | 转发、号池、降级 |
| 3 | 类型检查 | `npx tsc --noEmit -p tsconfig.app.json` | — |
| 4 | 构建 | `npx vite build` | — |
| 5 | 生图全流程 | `backend/scripts/smoke_generation_flow.py` | 创建→出图→落盘→入库→扣费→重试守卫→图生图 |
| 6 | 共享额度池 | `backend/scripts/smoke_shared_quota.py` | 开关双向生效、池空不回落、充值权限 |
| 7 | 协作协议 | `backend/scripts/smoke_collab_ws.py` | 真 uvicorn + 真 WS：握手/广播/replay/落库 |
| 8 | 页面渲染 | `backend/scripts/ui_smoke_pages.py` | 真 Chrome × 10 页面 + 协作 WS 收到帧 |
| 9 | 首登引导 | `backend/scripts/ui_smoke_onboarding.py` | 三步流程 + 不弹回 + 技能包真装上 |
| 10 | 团队权限 | `backend/scripts/ui_smoke_team_permissions.py` | owner / member 双账号，UI + API 双侧 |
| 11 | 双端协同 | `backend/scripts/ui_smoke_collab_two_tabs.py` | 两个标签页双向同步 + 应用 + 落库 |
| 12 | 对话区交互 | `backend/scripts/ui_smoke_chat_panel.py` | 会话切换 / 搜索过滤 / 新建 / 删除二次确认 / SSE |

第 5 步起需要三个服务在跑（脚本会先探活并给出启动命令）。
共用部件在 `backend/scripts/_smoke_common.py`。

**为什么需要这么多层**：单测跑在 `ASGITransport` 上，碰不到 WS 握手、真浏览器路由、
真文件落盘。每一层都抓到过「单测全绿但功能是坏的」缺陷——清单见
`docs/11-team-collab-and-onboarding.md` §8。

---

## 7. 与 v1 文档的偏差（含理由）

1. **新增 `frontend/src/components/canvas/WorkspaceView.tsx`**：`/workspace` 与
   `/canvas/$id` 共用的三栏组合，避免路由文件互相导入（路由插件对额外导出有约束）。
2. **i18n 命名空间增至 13 个**：新增 `team`、`onboarding`；其余保持 v1 集合。
3. **`CS_IDEMPOTENCY_WINDOW_SECONDS` 仅取环境变量**（未入 `system_configs`）：
   架构 §8.1 将其列为 env 变量，未列入可后台编辑项。
4. **画布导出 PNG**：服务端无法精确渲染 Excalidraw 场景，导出优先返回已有缩略图，
   否则用 Pillow 渲染占位图；精确导出由前端 `CanvasExport` 承担。
5. **`users.active_team_id` 不建外键**：`users → teams → users` 会形成循环外键，
   `create_all` 建表顺序无解。改为普通列 + 服务层校验（`set_active_team` 会验成员身份）。
6. **团队协作走 WebSocket，不走轮询**：画布编辑的延迟必须低于人的感知阈值，
   轮询做不到；同时用元素级增量而不是整场景覆盖，否则两人同时编辑会互相抹掉。

以上均为实现层细化，未改变既有对外契约（`/api/*`、`/gw/*`、错误码）。
v2 新增的对外契约见 `docs/11-team-collab-and-onboarding.md` §4~§6。

---

## 8. 一致性审查结论

跨组件契约、导入关系、数据流、错误码映射核对通过：**IS_PASS: YES**。

---

*文档结束 · 2026-10-20*
