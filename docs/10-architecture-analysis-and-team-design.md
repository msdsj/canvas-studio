# 架构分析与团队协作能力设计

> 日期：2026-10-20
> 范围：现状架构梳理、四项需求的差距分析、目标设计与实施计划
> 结论先行：现有项目是一套**单租户、以个人创作者为中心**的 AI 画布产品，链路完整、工程质量不低；要落地「引导 + 技能包 + 企业团队 + 统一模型配置 + 生图/对话重构」，关键不是堆功能，而是先补一层**租户（Team）与资源访问控制**，再在其上叠加协作与配置能力。

---

## 1. 结论摘要（TL;DR）

| 维度 | 现状 | 结论 |
|---|---|---|
| 架构 | 前端 SPA + 业务中台（FastAPI）+ 网关（FastAPI）+ 上游图片/文本服务 | 分层清晰，职责边界明确，可直接扩展 |
| 多租户 | **无**。所有资源按 `user_id / owner_id` 隔离 | 必须新增 Team 领域模型，并把散落 6 处的归属校验收敛为统一访问层 |
| 实时协作 | **无**。画布整场景 2s 防抖覆盖写 | 并发编辑会静默互相覆盖（丢数据），必须引入版本号 + 增量合并 + WebSocket |
| 技能体系 | 全局静态 78 条设计技能 + 6 个提示词模板 | 缺「用户级技能集」与「按场景初始化」，桌面提示词资源库完全未接入 |
| 模型配置 | **用户级** `ai_providers`，全局兜底默认关闭 | 与「仅超级管理员配置、成员直接用」相反，需要新增团队级配置与解析链 |
| 生图链路 | 能力完整（分析→澄清→提示词→多任务→落画布） | 但前端 1790 行单体组件、3 套轮询、模型清单硬编码，需重构而非重写 |
| 测试基线 | 后端 354 passed / 1 failed，网关 64 passed，前端 tsc 0 error | 唯一失败是**历史用例过期**（并发默认值 2→12），非真实缺陷 |

---

## 2. 现状架构

### 2.1 进程与部署拓扑

```
浏览器 (React 19 SPA)
   │  /api/*  /static/*        （仅此两条出口，前端不直连网关）
   ▼
业务中台 backend :27181      FastAPI + SQLAlchemy 2.0 async + SQLite(WAL)
   │  /gw/*  (内部令牌)
   ▼
网关 gateway :27182          FastAPI + httpx(async) + 账号池 + 模型路由
   │
   ▼
上游 :3000                   图片/文本 provider（chatgpt2api 容器或兼容网关）
```

- 本地一键启动：`启动.command` 依次拉起网关 → 后端 → 前端（`frontend` 的 Vite 代理 `/api`、`/static` 到 27181）。
- 生产：`deploy/docker-compose.yml` + nginx（`/api`、`/static` 反代，SSE 关闭缓冲）。
- 数据：SQLite 单文件（`backend/data/canvas_studio.db`），WAL + `busy_timeout=15s`；本地存储 `backend/data/storage`（335 个文件）。

### 2.2 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 前端 | React 19、TypeScript 5.7、Vite 6、Tailwind 4、Zustand 5、TanStack Router/Query、Excalidraw 0.18、i18next、GSAP、Radix UI、sonner | 269 个源文件，约 3.67 万行 |
| 后端 | FastAPI 0.115、SQLAlchemy 2.0 async、aiosqlite、PyJWT、passlib(bcrypt)、APScheduler、Pillow、httpx、pytest | 103 个 py，约 1.8 万行 |
| 网关 | FastAPI、httpx、Pillow | 29 个 py，约 2700 行 |
| 部署 | Docker Compose、nginx | 本地 / 生产两套 |

### 2.3 代码规模与热点

| 文件 | 行数 | 角色 | 评价 |
|---|---:|---|---|
| `frontend/src/components/canvas/ImageEditLayer.tsx` | 2891 | 画布内标注/编辑层 | 过大，交互与几何计算混在一起 |
| `frontend/src/components/canvas/WorkspaceView.tsx` | 1842 | 工作台三栏编排 + 落图 + 轮询 | 过大，职责过多 |
| `frontend/src/components/chat/ChatPanel.tsx` | 1790 | 对话区全流程 | **本次重构重点** |
| `backend/app/services/compose_service.py` | 1774 | 生图编排（分析/澄清/派发） | 过大，需拆包 |
| `backend/app/services/generate_service.py` | 1198 | 任务执行/编辑/掩码合成 | 偏大 |
| `backend/app/services/design_skills.py` | 1250 | 78 条设计技能数据 | 纯数据，健康 |
| `backend/app/services/skills.py` | 781 | 选区编辑意图编排 | 偏大 |

### 2.4 数据模型（16 张表）

```
users ─┬─ canvas_projects ── canvases ── chat_sessions ── chat_messages
       ├─ assets
       ├─ generation_tasks
       ├─ quota_transactions
       ├─ ai_providers
       ├─ skill_runs
       ├─ email_tokens
       ├─ invite_codes / pro_codes
       └─ audit_logs
system_configs（全局键值）      announcements
```

关键字段与约束：

- `users`：`role ∈ {user, pro, admin}`、`status ∈ {pending_verification, active, banned}`、`balance`（CHECK ≥ 0）、`token_version`。
- `generation_tasks`：状态机 `queued → running → (paused) → succeeded/failed/cancelled/timeout`，`UNIQUE(user_id, idempotency_key)`。
- `quota_transactions`：`UNIQUE(ref_id, type)`，预扣 `processing` → 确认 `success` / 回滚 `refunded`。
- `canvases.state`：整份 Excalidraw 场景 JSON（无版本号、无 updated_by）。
- `chat_sessions` / `chat_messages`：软删字段齐全。

### 2.5 关键链路

**注册登录**
`POST /api/auth/register` → 直接 `active` + 发放初始额度 + 签发 JWT（无邮箱确认环节）→ 前端 `AuthDialog` 写入 `cs.token` → 首页或工作台。
注意：注册成功后**没有任何身份/场景选择**，用户直接落到首页。

**生图主链路（对话式）**
```
ChatPanel.submitCompose
  → POST /api/chat/compose (SSE)
      compose_service.stream_compose
        1. 中转站就绪检查（未配置 → status=unconfigured）
        2. 多模态分析（流式，失败回落非流式 + 纠错重试）
        3. 需求不明确 → status=clarify，落 SkillRun + 澄清卡
        4. 明确 → 生成最终提示词 → _dispatch()
        5. 每项独立产出各建 1 个 generation_task
  → 前端轮询任务 → 结果落画布（占位卡 → 显影）
```
**画布编辑链路**：框选/涂鸦 → `/api/chat/analyze`（意图 → ops）→ 确认 → `/api/generate/edit`（multipart，含 mask/guide）→ 任务执行 → 像素级合成回原图。

**权限**：`require_pro`（`role ∈ {pro, admin}`）把「画布 / 对话 / 编辑 / 润色 / 图生图」锁在 Pro 之后；普通用户只有 `FreeStudioView`（纯文生图）。`role=admin` 是**平台级**运维角色，不是企业租户管理员。

**配置**：`system_configs` 表为唯一真源，`config_service` 解析后 `push_to_gateway` 即时生效；`ai_providers` 是用户自建中转站，全局兜底需 `AI_RELAY_ALLOW_GLOBAL=true`（默认关）。

### 2.6 现有不足（按严重度）

| 级别 | 问题 | 影响 |
|---|---|---|
| P0 | 无租户/成员模型，权限校验按 `owner_id` 硬编码在 `project_service`、`canvas_service`、`chat_service`、`asset_service`、`task_service`、`ai.py` | 企业功能无处挂载；改一处漏一处就是越权 |
| P0 | 画布保存为整场景覆盖写，无版本/冲突检测 | 两人同时编辑必丢一方的修改，且无提示 |
| P0 | 模型配置是「每人自建」，与「管理员统一配置」相反 | 需求 3 无法满足，成员各自配 Key 也无法治理 |
| P1 | 技能是全局静态集合，无用户级启用/初始化 | 引导流程无落点；桌面电商提示词库未接入 |
| P1 | `ChatPanel` 1790 行 + 3 套轮询 + 模型清单硬编码 | 体验问题难修、状态易错、扩展成本高 |
| P1 | 无「团队资源」概念，分享仅公开只读链接 | 团队素材/生成物无法统一管理 |
| P2 | 错误码无「配置无权限」语义；`audit_logs` 无 team 维度 | 企业审计不完整 |
| P2 | 无前端单测/组件测试工具链（无 vitest/testing-library） | 重构回归只能靠 tsc + 手工 |
| P2 | `docs/` 与实现存在历史偏差（如测试数量、表数量） | 文档可信度下降 |

### 2.7 基线验证（本次实测）

| 验证 | 命令 | 结果 |
|---|---|---|
| 后端 | `backend/.venv/bin/python -m pytest -q` | **354 passed, 1 failed, 36 skipped**（89.57s） |
| 网关 | `gateway/.venv/bin/python -m pytest -q` | **64 passed**（10.46s） |
| 前端类型 | `npx tsc --noEmit -p tsconfig.app.json` | **0 error** |

唯一失败：`tests/test_qa_tasks_api.py::test_qa_concurrency_limit_exceeded_429`。
原因：用例假定每用户并发上限默认 2，但 `config.py` 已改为 12，且 seed 会把旧默认值 2 升级为 12。**属历史用例过期**，实现无缺陷。修复方式：用例改为读取配置值或显式注入上限（M0 处理）。

---

## 3. 需求差距分析

### 3.1 需求一：首登引导 + 场景技能集

| 需要 | 现状 | 缺口 |
|---|---|---|
| 注册/登录后选择身份场景 | 注册即登录，直接进首页 | 无引导页、无 persona 字段、无完成标记 |
| 多场景选项（开发/UI/电商…） | 无 | 需定义场景目录与映射 |
| 按场景内置技能集 | 全局 78 条 `DesignSkill` + 6 个 prompt 模板 | 无「用户技能集」；`compose_service._skill_block()` 不区分用户 |
| 参考桌面 skills 提示词库 | 完全未接入 | 需 docx/xlsx 解析 → 结构化技能包 → 版本化入库 |
| 团队场景下技能继承 | 无团队 | 需团队级技能包 + 成员覆盖 |

### 3.2 需求二：团队模式

| 需要 | 现状 | 缺口 |
|---|---|---|
| 公司主账号（超管） | 无 | 新表 `teams` + `team_members.role=owner` |
| 子账号创建/分配/权限 | 平台 admin 可建用户，但不是租户语义 | 团队邀请、角色、权限位、席位上限 |
| 多人同时编辑同一画布 | 整场景覆盖写 | 版本号 + 增量 patch + WebSocket + 冲突处理 |
| 团队资源共享 | 资源全私有 | `team_id` + `visibility` + 画布协作者 ACL |
| 团队内容/素材统一管理 | 无 | 团队素材库、团队作品、团队用量 |
| 审计 | `audit_logs` 无 team | 增加 `team_id`，覆盖成员/权限/配置变更 |

### 3.3 需求三：生图全流程 + 左侧对话区

| 需要 | 现状 | 缺口 |
|---|---|---|
| 生图流程体验与效率 | 链路完整但状态分散 | 统一任务状态源、SSE 替代轮询、阶段耗时、重试/取消一致 |
| 模型可选 | 前端硬编码 3 个 GPT 模型 | 服务端能力清单 + 管理员/团队白名单 |
| 左侧对话交互 | 1790 行单体；无搜索/无虚拟化/操作少 | 拆 hook + 子组件；会话搜索、消息操作、性能优化 |
| 错误与恢复 | 有错误码映射 | 缺 trace 展示、缺统一重试语义 |

### 3.4 需求四：模型统一配置

| 需要 | 现状 | 缺口 |
|---|---|---|
| 仅超管可配对话模型 | 每个用户都能配 `ai_providers` | 需团队级 provider + 角色门禁 |
| 成员无需配置直接使用 | `relay_service.resolve()` 只查 user → global | 解析链缺 team 层 |
| 管理员配置对全员生效 | 全局 `system_configs` 有，但语义是平台级 | 团队级配置与平台级配置要分开 |
| 成员界面不出现配置入口 | `AIConfigDialog` 始终可编辑 | 需只读态 + 来源说明 |

---

## 4. 目标架构设计

### 4.1 领域模型

```
Platform（平台运维）
  └─ admin（users.role=admin）：全局配置 / 号池 / 全站用户

Team（企业租户） 1 ─── n TeamMember ─── 1 User
  ├─ role: owner（超级管理员） / admin / member
  ├─ 资源：projects / canvases / assets / chat_sessions / tasks（team_id）
  ├─ 配置：team_ai_providers（对话+图片模型）
  ├─ 技能：team_skill_packs
  └─ 额度：team 共享池（可选）

User（个人）
  ├─ 个人资源（team_id = NULL）
  ├─ 个人技能包 / persona
  └─ 个人 provider（仅未被团队接管时可用）
```

**平台角色与团队角色是两套正交体系**：`role=admin` 仍是平台运维；企业超管通过 `team_members.role=owner` 表达，避免把平台运维权限下放给客户。

### 4.2 数据模型变更

新增表（`create_all` 自动建）：

| 表 | 关键字段 | 说明 |
|---|---|---|
| `teams` | `id, name, slug UNIQUE, owner_user_id, status, seat_limit, plan, settings JSON, balance, created_at, deleted_at` | 企业租户 |
| `team_members` | `id, team_id, user_id, role(owner/admin/member), status(active/invited/disabled), permissions JSON, invited_by, joined_at`；`UNIQUE(team_id,user_id)` | 成员与权限 |
| `team_invitations` | `id, team_id, email, role, token UNIQUE, expires_at, accepted_at, invited_by` | 邀请（复用现有邮件/令牌模式） |
| `canvas_collaborators` | `id, canvas_id, user_id, role(viewer/editor), created_by`；`UNIQUE(canvas_id,user_id)` | 画布级 ACL |
| `user_skill_packs` | `id, user_id, pack_key, source(onboarding/manual/team), created_at`；`UNIQUE(user_id,pack_key)` | 用户技能包选择 |
| `team_skill_packs` | `id, team_id, pack_key, created_at`；`UNIQUE(team_id,pack_key)` | 团队默认技能包 |
| `user_skill_overrides` | `id, user_id, skill_id, enabled`；`UNIQUE(user_id,skill_id)` | 单条技能开关 |

新增列（`migrations/run.py` 的 `_ensure_column` 幂等补列）：

| 表 | 列 | 说明 |
|---|---|---|
| `users` | `persona_key VARCHAR(32) DEFAULT ''`、`onboarding_completed_at DATETIME`、`active_team_id VARCHAR(36)` | 引导与当前团队 |
| `canvas_projects` | `team_id VARCHAR(36)`、`visibility VARCHAR(16) DEFAULT 'private'` | 团队项目 |
| `canvases` | `team_id`、`version INTEGER DEFAULT 0`、`updated_by VARCHAR(36)`、`collab_enabled BOOLEAN DEFAULT 0` | 协作基础 |
| `assets` | `team_id`、`visibility VARCHAR(16) DEFAULT 'private'` | 团队素材 |
| `chat_sessions` | `team_id`、`visibility` | 团队对话 |
| `generation_tasks` | `team_id` | 团队用量归属 |
| `skill_runs` | `team_id` | 审计 |
| `ai_providers` | `team_id VARCHAR(36)`、`scope VARCHAR(16) DEFAULT 'personal'` | 团队 provider |
| `quota_transactions` | `team_id VARCHAR(36)` | 团队额度流水 |
| `audit_logs` | `team_id VARCHAR(36)` | 团队审计 |

> 迁移约束：项目没有 Alembic，`create_all` 只建缺失的**表**，不会给已有表加索引/约束。新增列走 `_ensure_column`；新增索引需在 `migrations/run.py` 里用 `CREATE INDEX IF NOT EXISTS` 显式补。所有变更必须幂等、可重复执行。

### 4.3 权限模型

**团队角色默认权限位**（`team_members.permissions` 可覆盖）：

| 权限键 | owner | admin | member |
|---|:--:|:--:|:--:|
| `team.manage`（改名/删除/转让） | ✅ | ❌ | ❌ |
| `member.manage`（邀请/停用/改角色） | ✅ | ✅ | ❌ |
| `model.configure`（对话/图片模型） | ✅ | ❌ | ❌ |
| `billing.view` / `quota.adjust` | ✅ / ✅ | ✅ / ❌ | ❌ |
| `asset.manage`（团队素材删除/整理） | ✅ | ✅ | ❌ |
| `canvas.create` | ✅ | ✅ | ✅ |
| `canvas.edit.any`（编辑他人画布） | ✅ | ✅ | ❌ |
| `canvas.share.external` | ✅ | ✅ | ❌ |
| `team.resource.view` | ✅ | ✅ | ✅ |

**资源可见性判定**（统一收敛到 `app/services/access.py`）：

```
can_read(user, resource):
  if resource.owner_id == user.id: True
  if resource.team_id and is_team_member(user, resource.team_id):
      return resource.visibility == 'team' or has_explicit_grant(...)
  return resource.share_token and public

can_write(user, resource):
  if resource.owner_id == user.id: True
  if resource.team_id and is_team_member:
      if team_role in (owner, admin): True
      if resource.visibility == 'team' and resource.collab_edit == 'team': True
      return canvas_collaborators.role == 'editor'
  return False
```

> 这是本次改造的**最大风险点**：必须逐接口替换，并用参数化越权矩阵测试兜底（见 §6）。

**团队是否解锁 Pro**：现有 `require_pro` 会把普通用户挡在画布/对话之外。建议：**团队成员（席位内）自动视为 Pro 能力可用**，在 `deps.is_unlocked()` 中加入 team 判定；前端 `useAuth().isPro` 同步。否则企业买不到可用产品。

### 4.4 后端模块划分

```
app/
├─ models/
│   ├─ team.py            (Team, TeamMember, TeamInvitation)
│   ├─ collaboration.py   (CanvasCollaborator)
│   └─ skill_pack.py      (UserSkillPack, TeamSkillPack, UserSkillOverride)
├─ routers/
│   ├─ onboarding.py      /api/onboarding/*
│   ├─ teams.py           /api/teams/*（成员/邀请/资源/用量/模型配置）
│   ├─ collab.py          /api/collab/*（ticket + WebSocket）
│   └─ skills.py          /api/skills/*（技能包目录/我的技能）
├─ services/
│   ├─ access.py          ★ 统一可见性/写权限
│   ├─ team_service.py
│   ├─ invitation_service.py
│   ├─ skill_packs.py     ★ 加载内置 JSON 技能包
│   ├─ onboarding_service.py
│   ├─ collab_hub.py      ★ 房间/广播/版本环缓冲
│   ├─ canvas_doc.py      ★ 增量合并（元素级 LWW + 墓碑）
│   └─ compose/           ★ 由 compose_service.py 拆分
│       ├─ analyze.py  prompt.py  dispatch.py  reply.py  stream.py
└─ data/skill_packs/      ★ 由桌面资源库导入并提交仓库的 JSON
```

### 4.5 API 设计（新增）

**引导 / 技能**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/onboarding/personas` | 场景目录（含推荐技能包、技能数、示例提示词） |
| GET | `/api/onboarding/state` | 是否已完成、已选场景/技能包 |
| POST | `/api/onboarding/complete` | `{persona_keys:[], pack_keys:[], create_team?}` 幂等完成 |
| GET | `/api/skills/packs` | 技能包目录（含来源、条数、场景标签） |
| GET | `/api/skills/mine` | 我的有效技能集（团队包 ∪ 个人包 − 禁用） |
| PUT | `/api/skills/mine` | 替换技能包选择 / 单条开关 |

**团队**

| 方法 | 路径 | 权限 |
|---|---|---|
| POST | `/api/teams` | 任意登录用户（创建即 owner） |
| GET | `/api/teams/mine` | 成员 |
| GET/PATCH | `/api/teams/{id}` | 成员读 / owner 写 |
| GET | `/api/teams/{id}/members` | 成员 |
| POST | `/api/teams/{id}/invitations` | `member.manage` |
| POST | `/api/teams/invitations/{token}/accept` | 被邀请人 |
| PATCH | `/api/teams/{id}/members/{uid}` | `member.manage`（角色/状态/权限） |
| DELETE | `/api/teams/{id}/members/{uid}` | `member.manage` |
| GET | `/api/teams/{id}/usage` | `billing.view` |
| GET | `/api/teams/{id}/assets` | 成员（团队素材） |
| GET/PUT | `/api/teams/{id}/model-config` | **owner only** |
| GET | `/api/teams/{id}/audit` | `member.manage` |

**协作**

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/canvases/{id}/collab-ticket` | 一次性票据（60s），供 WS 鉴权 |
| WS | `/api/collab/ws?ticket=...` | 加入房间、增量 patch、presence |
| GET | `/api/canvases/{id}/collab` | 协作者列表 / 在线状态 |
| PUT | `/api/canvases/{id}/collaborators` | 管理画布 ACL（editor/viewer） |

**模型 / 生图**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/ai/models` | 可用对话/图片模型（按团队策略过滤） |
| GET | `/api/generate/capabilities` | 尺寸/质量/单价/是否支持编辑 |
| POST | `/api/generate/tasks/{id}/retry` | 失败任务原参数重试（新幂等键，只允许终态失败） |
| GET | `/api/generate/tasks/{id}/stream` | SSE 任务进度（替代轮询，保留轮询兜底） |

### 4.6 前端信息架构

```
/onboarding                 全屏引导（登录后未完成时强制）
/workspace                  工作台（画布 + 左侧对话）
/team                       团队空间（成员 / 素材 / 作品 / 用量）
/team/settings              团队设置（含模型配置，仅 owner）
/team/members               成员与邀请
/admin/*                    平台运维后台（保持现状）
```

- 顶部/左栏增加「团队切换器」：个人空间 ⇄ 团队空间；切换写入 `users.active_team_id` 与本地 store。
- 身份条 `WorkspaceIdentityBar` 显示团队徽标与角色（`owner` / `admin` / `member`）。
- 成员视角：模型配置入口替换为只读状态条「由团队管理员统一配置 · 当前模型 xxx」。
- 协作：画布右上角在线头像组、光标层、冲突提示条、自动重连状态。

### 4.7 实时协作方案（三选一）

| 方案 | 机制 | 优点 | 代价 | 结论 |
|---|---|---|---|---|
| **A. WS + 元素级增量合并** | FastAPI WebSocket 房间；客户端按元素 id 发 patch；服务端版本号 + LWW + 墓碑；presence 广播 | 纯 Python、无新服务、可控、能复用现有鉴权 | 冲突语义是 LWW 而非 CRDT；单进程房间 | **推荐** |
| B. Yjs / y-websocket | 引入 Node 协同服务 + y-py，CRDT 合并 | 最接近 Figma，天然解决并发 | 新增进程/依赖、数据模型迁移、运维复杂 | 二期可选 |
| C. 乐观锁 + 轮询 | `base_version` 校验，409 后提示刷新 | 改动最小 | 不是"同时编辑"，体验差 | 仅作降级 |

**推荐方案 A 的协议**：

```jsonc
// client → server
{"type":"join"}
{"type":"patch","base_version":12,"elements":{"added":[...],"updated":[...],"deleted":["id"]}}
{"type":"presence","cursor":{"x":120,"y":80},"selection":["el1"]}
// server → client
{"type":"snapshot","version":12,"state":{...},"participants":[...]}
{"type":"patch","version":13,"elements":{...},"by":{"id":"u1","name":"张三"}}
{"type":"presence","participants":[...]}
{"type":"resync","reason":"version_gap"}   // 环缓冲不足时要求全量
{"type":"error","code":"FORBIDDEN"}
```

- 合并规则：同元素按服务端接收顺序 LWW；`deleted` 写墓碑并带版本；`appState`（视口/缩放）**不合并**，各端独立。
- 持久化：房间内 1.5s 防抖 + 最后一人离开时落库；落库写 `canvases.state` 与 `version`。
- 回显抑制：客户端应用远端 patch 时置 `remoteApplyingRef`，避免 `onChange` 再次上传。
- 限制：**单进程内存房间**；多进程/多实例需 Redis Pub/Sub（文档标注，不在本期实现）。

### 4.8 模型配置解析链

```
relay_service.resolve(user)
  1) team provider：user.active_team_id 有 active team provider → source="team"
     （团队默认 strict：成员不可用个人 provider）
  2) personal provider：仅当不在团队，或团队 settings.allow_personal_provider=true
  3) global：system_configs 的 TEXT_*（需 AI_RELAY_ALLOW_GLOBAL=true）
```

- 新错误码 `MODEL_CONFIG_FORBIDDEN`（403，文案「对话模型由团队超级管理员统一配置」），仅用于团队成员的写操作。
- `/api/ai/status` 增加 `source ∈ {team,user,global,none}`、`editable`、`managed_by`、`team_name`。
- 平台 admin 仍管全局默认；团队 owner 管团队 provider；两者互不覆盖。
- 图片模型同理：团队 `model-config` 里维护 `enabled_image_models`，成员只能选白名单内的。

### 4.9 技能包导入流水线

```
桌面资源库（docx/xlsx）
  → scripts/import_skill_prompts.py（离线一次性）
      ├─ 解析段落 / 表格 / 工作表
      ├─ 清洗：去链接、去联系方式、去广告语、去重、长度上限
      ├─ 分类：按目录 + 关键词 → pack_key
      └─ 输出 backend/app/data/skill_packs/<pack>.json + index.json
  → 提交仓库（技能是产品资产，随代码版本走）
  → app/services/skill_packs.py 运行时加载（lru_cache，只读）
  → /api/skills/* + compose_service 注入
```

技能包与场景映射（首批）：

| pack_key | 名称 | 来源 | 场景 |
|---|---|---|---|
| `ecommerce_detail` | 电商详情页 | `7.AI电商详情设计提示词/*`（耳机/分子图/DeepSeek/文生图融图） | 电商 |
| `ecommerce_poster` | 电商海报 | `2、.../电商海报设计提示词`（8 套） | 电商、市场 |
| `promo_poster` | 商业促销海报 | `2、.../商业与促销海报提示词`（26 套） | 市场、电商 |
| `festival_poster` | 节气节庆海报 | `2、.../节气节庆海报提示词`（52 套） | 市场 |
| `font_effect` | 字体字效 | `1、.../AI字体字效提示词(205套）.xlsx` | 品牌、UI、市场 |
| `social_cover` | 自媒体封面 | `3、封面设计提示词`（35 套） | 市场、内容 |
| `packaging` | 产品包装 | `4、AI产品包装设计提示词`（12 套） | 品牌 |
| `creative_play` | 创意玩法 | `5、创意玩法提示词`（像素/鱼眼/祈运/创意） | 内容 |
| `photo_edit` | P 图与反推 | `AI生图 P图提示词合集`、`6.AI反推图片提示词教程` | 通用、电商 |
| `dev_ui` | 开发与 UI | 现有 `design_skills.py` 的 `ui/brand/illustration/photo/type/color/layout/print/deck` + 新增架构图/流程图/界面稿模板 | 开发、UI |
| `brand_vi` | 品牌与 VI | 现有 `design_skills.py` 的 `brand` 分类 | 品牌 |
| `general_design` | 通用设计 | 现有 78 条其余分类 | 通用 |

场景 → 技能包：

| persona | 默认技能包 |
|---|---|
| `developer` 开发 | `dev_ui`、`general_design` |
| `ui_designer` UI 设计 | `dev_ui`、`font_effect`、`brand_vi` |
| `ecommerce` 电商运营 | `ecommerce_detail`、`ecommerce_poster`、`promo_poster`、`photo_edit` |
| `marketing` 市场/社媒 | `social_cover`、`promo_poster`、`festival_poster`、`ecommerce_poster` |
| `brand` 品牌/包装 | `brand_vi`、`packaging`、`font_effect` |
| `content` 内容/插画 | `creative_play`、`social_cover`、`general_design` |
| `general` 通用 | `general_design`、`photo_edit` |

> 资源库以电商为主，`ecommerce` 作为引导页的「推荐」场景；其余场景用现有设计技能 + 少量新增模板补足，避免出现「选了开发却只有海报」的空包。

### 4.10 生图全流程重构

**后端**

1. `compose_service.py` 拆为 `app/services/compose/` 包，保持 `stream_compose` / `confirm_compose` 对外签名不变（前端零改动）。
2. 新增 `GET /api/ai/models` 与 `GET /api/generate/capabilities`：模型清单、尺寸、单价、能力（编辑/透明/参考图）由服务端下发，删除前端硬编码。
3. 统一 SSE 事件契约（`seq` + `event` + `data`）：`step / delta / thought / result / error / heartbeat`；任务流补 `progress / status / result_urls / cost / error_code`。
4. `POST /api/generate/tasks/{id}/retry`：仅终态失败可重试；沿用原 prompt/params，新幂等键，避免重复扣费。
5. 进度上报节流：任务执行中按 5% 或 500ms 上报，减少 DB 写。

**前端**

1. 新建 `src/features/generation/`：
   - `generationStore.ts`：任务唯一状态源（按 id 归一，替代 3 套轮询）。
   - `useTaskStream.ts`：SSE 优先、失败回落轮询（指数退避）。
   - `useGenerationController.ts`：提交/取消/重试/落图编排。
   - `resultPlacer.ts`：串行落图、去重、找空位、聚焦。
2. `ChatPanel` 拆分：`ChatPanel`（布局）+ `useComposeSession`（状态机）+ `MessageTimeline` + `ComposerDock` + `RunCard`。
3. 流式渲染按 `requestAnimationFrame` 批量 flush，避免每 token 一次 setState。
4. 结果卡统一：进度阶段、耗时、成本、对比、下载、继续编辑、重试。
5. 失败可恢复：保留输入、原参数重试、错误码 → 人话文案。

**左侧对话区优化**

| 项 | 方案 |
|---|---|
| 会话管理 | 搜索、置顶、重命名、批量删除、未读标记 |
| 消息操作 | 复制、重试、编辑重发、删除、把结果放进画布 |
| 输入区 | 拖拽/粘贴图片、@ 引用、模型选择、成本预估、停止生成、快捷发送 |
| 性能 | 时间线 memo + `content-visibility:auto`；流式 rAF 合并；切会话中止旧流 |
| 空态 | 按 persona 展示 3–6 个技能包示例提示词，一键填入 |
| 移动端 | 沿用现有 `MobileSegmented`，保证停止/重试可达 |
| 无障碍 | `aria-live` 流式区域、焦点管理、图标按钮 `aria-label` |

---

## 5. 实施计划

| 里程碑 | 内容 | 主要产出 | 验收 |
|---|---|---|---|
| **M0 基线与骨架** | 修复过期用例；`access.py` 骨架；迁移补列工具；错误码；前端测试工具链（vitest） | 1 天 | 后端全绿；`migrations` 幂等重跑 |
| **M1 引导 + 技能包** | 导入脚本 → JSON 技能包；`skill_packs` 服务；onboarding API/UI；`/api/skills/mine`；compose 按用户技能过滤 | 3–4 天 | 新用户注册 → 选场景 → 技能集正确；技能包 schema 测试 |
| **M2 团队账号体系** | `teams/team_members/team_invitations`；成员/邀请/权限；资源 `team_id`；团队空间 UI；审计 | 5–6 天 | 越权矩阵全绿；邀请闭环；团队素材/作品可见 |
| **M3 实时协作** | `canvas.version`；`canvas_doc` 合并；`collab_hub` + WS；ticket 鉴权；presence；冲突 UI；ACL | 5–7 天 | 双端并发编辑不丢改动；断线重连；越权拒绝 |
| **M4 模型统一配置** | 团队 provider；解析链 team→user→global；权限门禁；只读态 UI；团队设置页 | 2–3 天 | 成员无法写配置；成员开箱可用；owner 切换即生效 |
| **M5 生图/对话重构** | capabilities API；generation store/SSE；ChatPanel 拆分；结果卡；会话搜索/性能 | 6–8 天 | 三套轮询归一；流式 60fps；失败可重试 |
| **M6 回归与交付** | 全量测试、构建、E2E、文档与截图 | 2–3 天 | 后端/网关全绿；tsc + build 通过；关键路径 E2E |

> 粗估 25–30 人日（单人串行）。若并行（后端团队 / 前端团队），关键路径是 M2 → M3 → M5。

### 5.1 测试策略

| 层 | 内容 |
|---|---|
| 单元 | `canvas_doc` 合并规则（新增/更新/删除/墓碑/版本缺口）、`access.py` 判定、技能包 schema、模型解析链 |
| 接口 | onboarding 幂等、团队 CRUD、邀请过期/重复接受、成员权限矩阵、provider 门禁、retry 幂等 |
| 越权矩阵 | 参数化覆盖所有含 `{id}` 的路由：非属主/非成员/被停用成员 → 403/404 且不泄漏存在性 |
| 协作 | 双客户端并发 patch、乱序、版本缺口重同步、断线重连、权限撤销 |
| 前端 | vitest：store/reducer/合并工具；tsc；eslint；build |
| E2E | 注册 → 引导 → 建团队 → 邀成员 → 成员用团队模型生图 → 双人编辑画布 → 团队素材可见 |

### 5.2 兼容与回滚

- 所有新列可空、有默认值；旧数据 `team_id=NULL` 即个人资源，行为不变。
- 新路由独立前缀，不改既有 `/api/*` 契约；`compose_service` 拆包保留原导出名。
- 团队 provider 未配置时自动回落个人/全局，避免企业功能未就绪导致不可用。
- WS 失败自动降级为「乐观锁 + 轮询」，不阻塞编辑。
- 迁移脚本幂等；`_apply_column_patches` 在启动时自动执行，回滚只需回退代码（列保留无害）。

---

## 6. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 归属校验替换不彻底 | 越权读写 | `access.py` 单一入口 + 参数化越权矩阵测试 |
| SQLite 并发写 | 协作 patch 与任务进度写冲突 | 已开 WAL + 15s busy_timeout；patch 落库防抖；单进程房间 |
| 整场景覆盖写残留 | 协作时丢改动 | 协作画布禁用整场景 autosave，改走 patch 通道 |
| 技能包版权/联系方式 | 合规风险 | 导入时清洗 URL/联系方式/广告语；保留来源字段 |
| 团队成员解锁 Pro | 与现有付费模型冲突 | 以「席位」为准，`seat_limit` 由 owner 控制；平台 admin 可关 |
| i18n 文案量 | 英文缺失 | 先 zh-CN 完整、en 回落；新增命名空间 `onboarding` / `team` |
| 文档漂移 | 维护成本 | M6 统一更新 `docs/03-code-summary.md` 与 README |

---

## 7. 待确认决策

| # | 决策 | 选项 | 建议 |
|---|---|---|---|
| D1 | 多人协作实现深度 | A 纯 Python WS + 元素级合并 / B Yjs 独立服务 / C 乐观锁轮询 | **A**（本期），B 预留 |
| D2 | 团队额度 | A 团队共享池（可选开启）/ B 成员各自额度，团队仅看用量 | **A**，默认关闭，owner 可开 |
| D3 | 团队成员是否自动解锁 Pro 能力 | 是 / 否 | **是**（按席位） |
| D4 | 技能资源导入方式 | A 离线解析后提交 JSON / B 运行时读取桌面目录 | **A**（可版本化、可测试） |
| D5 | 引导形态 | A 注册后全屏引导（可跳过）/ B 弹窗 | **A** |

---

## 8. 附：本次未改动任何代码

本轮只做分析与设计，工作区代码保持原样（`git status` 仅含此前已存在的改动）。确认 §7 决策后，按 M0 → M6 顺序实施。
