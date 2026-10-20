# 团队协作 · 角色引导 · 生图链路 —— 实现说明（v3）

> 承接 `10-architecture-analysis-and-team-design.md` 的分析与设计。本文只写
> **落地了什么、怎么用、边界在哪、怎么验证**，不重复架构论证。

## 1. 本次交付一览

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M0 | 数据模型 + 幂等迁移（`team_id` / `visibility` / `version` / `scope`） | ✅ |
| M1 | 团队账户体系：建团、席位、邀请、成员、所有权转移、审计 | ✅ |
| M2 | 团队空间：项目/画布/资产/会话的团队归属与可见性 | ✅ |
| M3 | 统一模型配置：owner 配置、成员只读、个人配置被接管时封禁 | ✅ |
| M4 | 角色引导 + 技能包（16 包 / 490 条）注入提示词 | ✅ |
| M5 | 生图链路：服务端重试、模型清单驱动选择器、失败态收敛 | ✅ |
| M6 | 实时协作：元素级增量合并 + presence（WebSocket） | ✅ |

## 2. 角色引导与技能包

### 流程
注册/登录后若 `users.persona_key` 为空 → `ProtectedRoute` 重定向到 `/onboarding`。
三步：选场景（7 个 persona）→ 可选「顺手建个团队」→ 完成。可随时跳过；
跳过后 `persona_key` 写入 `general`，不会再打扰。

### 内容来源
`backend/app/data/skill_packs/*.json`（16 个包，490 条提示词骨架）+ `personas.json`
（7 个场景到包键的映射）。内容是**产品资产、随代码提交**，不从 Desktop 实时读取。

重新生成：

```bash
/Users/lxx/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/python/bin/python3 \
  scripts/import_skill_prompts.py
./backend/.venv/bin/python scripts/export_design_skill_packs.py
```

### 生效范围
- 个人：`PUT /api/skills/mine` 设置启用的包；`POST /api/skills/mine/toggle` 单条开关。
- 团队：owner `PUT /api/skills/team/{team_id}` 设置团队默认包。
- 成员实际生效 = **团队包 ∪ 个人包 − 单条禁用**（`skill_packs.effective_items`）。
- 注入：`compose_service._user_skill_block` 按本轮需求 `match_items` 粗筛，
  最多 8 条、每条 200 字（`MAX_INJECT_ITEMS` / `MAX_INJECT_CHARS`）。
  注入失败只记日志、不中断生成。

## 3. 团队模式

### 角色与权限
- 平台角色（`users.role = admin`）与团队角色（`teams.owner_user_id` / `team_members.role`）
  **完全正交**：客户团队的管理员不是平台超管。
- `team_members.role ∈ {owner, admin, member}`；权限位 10 个
  （`DEFAULT_PERMISSIONS`），其中 `model.configure` **仅 owner** 恒为真。

### 关键接口
```
POST   /api/teams                          建团（创建者=owner）
GET    /api/teams                          我的团队列表
POST   /api/teams/active                   切换当前团队（null=个人空间）
PATCH  /api/teams/{id}                     改名/席位/共享额度开关
GET    /api/teams/{id}/members             成员列表
PATCH  /api/teams/{id}/members/{uid}       改角色/禁用
POST   /api/teams/{id}/transfer            转让所有权
POST   /api/teams/{id}/invitations         发邀请（邮件带 /team/join?token=）
POST   /api/teams/invitations/{token}/accept
GET/PUT /api/teams/{id}/model-config       统一模型（PUT 仅 owner）
GET    /api/teams/{id}/usage               用量汇总
POST   /api/teams/{id}/topup               充值（仅 owner）
GET    /api/teams/{id}/audit               操作日志（member.manage）
```

### 商用口径
- 加入团队即获得 Pro 能力（`unlocked_async`），前端 `isPro` 以 `teams.length > 0` 为准，
  切回个人空间不掉权限。
- 共享额度池**默认关闭**（`settings.shared_quota`）。开启时发放 2000 初始额度并记账到团队；
  池子耗尽**不会**静默回落到个人余额——那会让「公司买单」变成「员工自费」。
- 扣费顺序：团队池（若开启）→ 个人余额 → 全局中转站。

## 4. 统一模型配置

- 团队配置落成**单条 active 的 `ai_providers` 行**（`scope='team'`，`team_id`），
  历史行置为 inactive 而非删除（保留可追溯性）。
- `teams.settings.allow_personal_provider` 默认 `false`；此时成员的
  `/api/ai/providers` 写操作一律 403 `MODEL_CONFIG_FORBIDDEN`。
- 前端 `AIConfigDialog` 依据 `/api/ai/status.editable === false` 切换为只读说明卡，
  不展示「填了也存不进去」的表单。
- `GET /api/ai/models` 返回 `{configured, editable, source, image[], text[]}`，
  生图模型选择器据此渲染；本地缓存的模型若已被下线会自动纠正。

## 5. 生成链路改进

| 问题 | 处理 |
| --- | --- |
| 超时重试要重新跑一遍 LLM 规划，慢且结果可能变 | `POST /api/generate/tasks/{id}/retry` 复用原任务 `params`，只在 failed/timeout/cancelled 生效，支持 `Idempotency-Key` |
| 模型选择器硬编码三档 | 改为读 `/api/ai/models`；未配置才回退内置列表 |
| 团队未配模型时提示「去配置」但点开是只读 | 直接提示「联系团队超级管理员」，不再给假入口 |
| 生成失败后只有「重新生成」 | 结果卡保留「重试」（复用参数）与「重新生成」（重新规划）两条路径 |

## 6. 实时协作

### 协议
WebSocket `/api/collab/ws/{canvas_id}?ticket=...`

客户端 → 服务端：`patch{base_version, patch}` / `presence{cursor, selection}` / `resync` / `ping`
服务端 → 客户端：`snapshot{state, version, participants}` / `patch{version, patch}` /
`presence` / `peer_joined` / `peer_left` / `full_state` / `error{code, resync}`

- **票据**：`POST /api/collab/{canvas_id}/ticket` 换 30 秒（`COLLAB_TICKET_TTL`）、
  绑定单画布的 JWT（`typ='collab'`）。WebSocket 不能带自定义头，把 access token
  塞 query 会进浏览器历史与代理日志。
- **合并**：元素级 LWW，比较 `versionNonce`→`version`；删除留 tombstone 防复活；
  `appState` 的视图键（scrollX/scrollY/zoom/选中…）**永不合并**，各人视角独立。
- **版本**：房间保留最近 200 版（`VERSION_BUFFER`）；`base_version` 超出范围返回
  `CANVAS_VERSION_CONFLICT`，客户端 `resync` 拉全量。
- **降级**：拿不到票据 / WS 连不上 → `offline`，画布回到整场景防抖保存，
  不会因为协作不可用而停止保存。
- **写权限**：`CanvasCollaborator.role='viewer'` 的 peer 发 patch 会被房间拒绝；
  非 owner 走 patch 通道，owner 的整场景 PUT 仍是唯一能整体覆盖的路径。

### 前端接入
```
src/hooks/use-canvas-collab.ts        WS 连接 / 重连退避 / 心跳 / 消息分发
src/components/canvas/useSceneDiff.ts  元素级 diff 与回环抑制
src/components/canvas/useCanvasCollabScene.ts  上行推送 + 远端 apply
src/components/canvas/CollabPresence.tsx       在线头像与连接状态
```
`WorkspaceView` 只有在 `canvas.team_id` 存在时才连协作；其余走原自动保存。

## 7. 一致性约定

- **403 vs 404**：资源存在但无权限 → 403；资源不存在 / 不属于你所在团队 → 404。
  例外是团队本身不可见时统一 404（避免探测团队是否存在）。
- **迁移**：无 Alembic，靠 `create_all` + `migrations/run.py` 里幂等的
  `_ensure_column` / `_ensure_index`，重复执行安全。
- **序列化**：`users.active_team_id` 不加外键（与 `teams` 形成循环依赖，
  `create_all` 会失败），一致性由 `team_service` 维护。

## 8. 验证

```bash
bash scripts/verify_all.sh      # 全部七步，一键
```

等价于分别执行：

```bash
cd backend  && ./.venv/bin/python -m pytest -q                     # 421 passed, 36 skipped
cd gateway  && ./.venv/bin/python -m pytest -q                     # 64 passed
cd frontend && npx tsc --noEmit -p tsconfig.app.json               # clean
cd frontend && npx vite build                                      # clean
cd backend  && ./.venv/bin/python scripts/smoke_collab_ws.py       # 真 uvicorn + 真 WS
cd backend  && ./.venv/bin/python scripts/ui_smoke_pages.py        # 真 Chrome × 9 页面
cd backend  && ./.venv/bin/python scripts/ui_smoke_collab_two_tabs.py  # 双标签协同
```

后两个脚本需要开发服务在跑（backend:27181 / frontend:27180）。

新增测试文件：`test_collab.py`(22)、`test_teams_api.py`(18)、`test_onboarding_api.py`(23)，
覆盖合并算法、房间并发、断线补齐、权限矩阵、席位上限、共享额度记账、模型接管、
技能包并集、重试幂等。前端无测试框架（未安装 vitest/playwright），以类型检查 + 构建为准。

### 为什么还要一个真 WS 冒烟脚本

`test_collab.py` 用 `ASGITransport` 跑 HTTP，WS 那一层（握手、票据校验、房间生命周期、
跨连接广播、落库）它碰不到。这个脚本起一个真实 uvicorn + 真 `websockets` 客户端，
第一次跑就抓到一个致命 bug：`_authenticate` 读了 `User` 上并不存在的 `deleted_at`，
**线上每次 WS 握手都 500，协作功能整个不可用，而 22 个单测全绿**。
教训是负向用例（票据画布不匹配）不能代替正向路径。

### 部署侧的两处必要配置

协作走 WebSocket，普通 HTTP 反代不会转发 `Upgrade` 头：

- `frontend/vite.config.ts`：`/api` 代理必须 `ws: true`，且 `timeout: 0`
  （默认超时会让空闲画布反复掉线重连）；
- `frontend/nginx.conf` / `deploy/nginx/default.conf`：`/api/collab/ws/` 单独一段，
  带 `Upgrade` / `Connection "upgrade"` 与 3600s 读写超时。

漏掉任一处，前端表现都是「团队画布打开后一直显示协作未连接」，
而所有后端测试仍然通过。

### 三层验收，各自抓不同的 bug

```bash
bash scripts/verify_all.sh      # 一次性跑完下面全部
```

| 层 | 覆盖 | 只有这一层能发现的 bug |
| --- | --- | --- |
| 后端单测（424） | 合并算法、权限矩阵、配额记账、幂等 | 逻辑错 |
| 真 WS 冒烟 | 握手、票据、房间生命周期、广播、落库 | `ASGITransport` 根本走不到 WS |
| 真浏览器冒烟 | 路由、i18n、渲染、协作上下行 | 前后端契约少字段、路由套错布局 |

本轮真机冒烟抓到四个单测全绿时依然存在的缺陷：

1. **`_authenticate` 读了 `User.deleted_at`**（该字段不存在）→ 每次 WS 握手 500，
   协作功能完全不可用。只有真连一次才暴露。
2. **`CanvasOut` 缺 `team_id`** → 前端判断「要不要开协作」时永远得到 false，
   协作通道从不启动。HTTP 层一切正常，因为字段只是「没返回」而不是报错。
3. **`/team/join` 被套进团队布局** → 用户点邀请链接看到「还没有团队 + 创建团队」。
   正确写法是 `team_.join.tsx`（下划线 = 不要父布局）。
4. **`SessionSelector` 写好了却没人挂载** → 组件里搜索、时间分组、二次确认全做了，
   但 `ChatPanel` 的会话条仍然只是一行静态标题。用户能看到「当前是哪段对话」，
   却换不了、搜不了、删不了。**死代码和可用功能在 `tsc`/`build` 眼里完全一样**——
   只有真点一遍才发现「点它没反应」。已挂回 `ChatPanel`，并补 `aria-label="切换会话"`
   （原来触发器的可访问名就是会话标题，读屏软件念出来是「海报设计讨论」，
   完全没表达「点它可以切换」）。

### UI 冒烟脚本测什么

`scripts/ui_smoke_pages.py`：用 CDP 驱动系统 Chrome 打开 9 个页面
（onboarding / skills / team ×4 / join / workspace / assets / canvas），断言
「根节点有文本 + 出现该页特征文本 + 无未捕获异常」，并对画布页断言
「协作 WS 已建立且收到过服务端帧」。截图留在 `/tmp/ui-smoke/`。

`scripts/ui_smoke_collab_two_tabs.py`：开两个标签页连同一块团队画布，
A 加元素 → 断言 A 发出 patch 帧、B 收到并应用（场景里真出现该元素）；
反向再来一次验双向；最后关掉两端、断言内容已落库。

`scripts/ui_smoke_chat_panel.py`：驱动真浏览器点左侧对话区——展开会话选择器、
搜索过滤（含空态与清空恢复）、切换会话（断言 URL 带上 session）、新建对话、
删除二次确认（第一下只「举起来」，断言按钮 `aria-label` 变成「再点一次确认删除」），
最后走一遍 `/api/chat/compose` 断言真的返回 SSE 流。

> 这两个脚本依赖 `window.__csCanvas`（仅 `import.meta.env.DEV` 下挂载）。
> Excalidraw 的场景在 canvas 里、DOM 上读不出来，没有这个钩子就没法断言
> 「对端真的应用了」。生产构建会把这段摇掉。

### 用 CDP 驱动 Radix 组件的三个坑

写 `ui_smoke_chat_panel.py` 时踩到的，记下来省下次的时间：

1. **合成 `click` 打不开 Radix 菜单**。`DropdownMenuTrigger` 监听的是
   `pointerdown`，`el.click()` 只派发 `click`，菜单纹丝不动——现象是
   「元素找得到、点了没反应」。必须走 `Input.dispatchMouseEvent`
   （`mousePressed` + `mouseReleased`）才有完整的指针事件序列。
2. **`innerText` 读不到 portal 里的菜单**。菜单明明 `[role=menu]` 且
   `data-state=open`，`document.body.innerText` 里却什么都没有。断言下拉内容
   要直接读 `[role="menu"]` 节点，别读整页。
3. **`[aria-label]` 要在菜单作用域里找**。页面上别处有同样 label 的按钮
   （折叠面板里的、移动端副本），点到它会把菜单关掉，表现成
   「点删除没反应」——排查方向会完全跑偏。

另外一个产品侧的细节：列表里的删除按钮默认 `opacity-0`、hover 才显形，
所以真实鼠标点击前要先 `mouseMoved` 过去，否则命中判定和视觉状态对不上。
