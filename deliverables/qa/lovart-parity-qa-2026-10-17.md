# Lovart Parity QA 报告（会话↔画布 / 需求分析中转站 / 画笔自由选区）

- 报告人：严过关（Yan）· QA
- 日期：2026-10-17
- 被测对象：`/Users/meishiduoshuijiao/Desktop/canvas-studio`（前端 27180 / 后端 27181 / 网关 27182，运行中未重启）
- 测试方式：真实浏览器（Chrome 155 + CDP 直连，零依赖 Node 脚本）跑真实前后端；数据侧一律用后端 API 交叉验证，**未 mock 任何页面数据**
- 产物：截图 `deliverables/qa/shots/`；脚本 `deliverables/qa/{ab,cd,ef,gh,h2}.mjs` + `harness.mjs`

---

## TL;DR

| 项 | 结论 |
|---|---|
| 静态检查 4 项 | **全部通过**（tsc 10 条仅历史错误、build 成功、pytest 111 passed、SSE 9 事件） |
| 浏览器端到端 | **62 项断言：59 通过 / 3 失败** |
| 阻塞（P0） | 0 |
| 功能错（P1） | 1 —— 会话切换下拉在 1:1 改造后失效，界面无法切回历史对话 |
| 体验（P2） | 2 —— 任务耗时/时间戳时区错 8 小时；确认后刷新丢失「已选择」状态 |
| 观察（P3） | 2 —— 空画布显示「未保存的更改」；缩略导航计数在编辑态为 0 |
| 三块能力总评 | ①会话↔画布 一对一本体正确，但**切换入口**回归；②中转站完全达标；③画笔选区/气泡布局/掩码上行完全达标 |

一句话：**核心链路是真通的**——新建对话确实换空画布、切回确实恢复原画布、中转站步骤是逐条流出来的、确认卡确实不会自动扣费、mask 确实带 bytes 上行了。唯一的功能性问题是「切回」这条路在 UI 上被自己堵住了（只能靠 URL 直达）。

---

## 一、静态与后端检查（原始输出摘要）

### 1. 前端类型检查
```
$ cd frontend && npx tsc -p tsconfig.app.json --noEmit
src/components/canvas/CanvasExport.tsx(46,11): error TS2698
src/components/canvas/MaterialPanel.tsx(131,32): error TS2339 'prompt'
src/components/canvas/MaterialPanel.tsx(131,48): error TS2339 'filename'
src/components/canvas/MaterialPanel.tsx(136,32): error TS2339 'filename'
src/components/canvas/WorkspaceView.tsx(898,27): error TS2339 'filename'
src/components/ui/tabs.tsx(1,32): error TS2307 '@radix-ui/react-tabs'
src/routes/__root.tsx(21,3): error TS2322
src/routes/admin.pool.tsx(22,15): error TS2459 PoolAccount
src/routes/admin.pool.tsx(22,46): error TS2459 PoolStats
src/routes/login.tsx(196,22): error TS2741 'search' missing
=== ERROR COUNT: 10 ===
```
**结论：10 条，与基线逐条一一对应，零新增。**（未使用仓库根那个 `files: []` 的空跑 tsc）

### 2. 生产构建
```
$ cd frontend && npx vite build
✓ 4579 modules transformed.
✓ built in 21.87s
```
**成功。**
> 环境噪音（非代码问题）：直接用默认 outDir 时，本机 safe-delete shim 在 `emptyDir(dist/assets)` 拦下构建
> `[SAFE_DELETE][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":196,"threshold":50,...}`
> 改用 `--outDir=/tmp/cs_dist_qa --emptyOutDir=false` 后完全通过，产物落在 /tmp，未污染仓库。

### 3. 后端单测
```
$ cd backend && .venv/bin/python -m pytest -q tests/
111 passed, 36 skipped in 66.61s
```
**与目标完全一致（111/0/36），未改任何测试。**

### 4. SSE 冒烟 `/api/chat/analyze`
```
data: {"event":"step","step":{"id":"parse","title":"读取需求","detail":"读到 2 个选区，已选中底图","status":"done"}}
data: {"event":"step","step":{"id":"decide","title":"判定产出","detail":"判定 2 张 · 1 处需要改图、1 处需要抠成素材","status":"done","elapsed_ms":1902}}
data: {"event":"step","step":{"id":"route","title":"编排决策","detail":"结论不唯一，交给用户选择","status":"done"}}
data: {"event":"step","step":{"id":"compose","title":"整理指令","detail":"整理了 2 条区域指令","status":"done"}}
data: {"event":"result", ...}
=== EVENT COUNTS: 9（8 step + 1 result） ===
```
result 关键字段：`status=confirm`、`image_count=2`、`confidence=88`、`rule_hit=ambiguous`、`demo=true`、`selection_fingerprint=44c68629`、`options=[单张/两张]`、`steps[4]=dispatch → skipped「尚未提交」`。**符合预期。**

---

## 二、A–H 逐条结论

### A. 新建对话 = 空画布 —— **8/8 通过 ✅**
| # | 断言 | 实际 |
|---|---|---|
| A00 | 通过真实 API 建干净基线会话 | `status=200`，session=3db1141e |
| A0 | 基线画布可读 | canvas=9f1c9e61，elements=0 |
| A1 | 放一张图后元素数 > 0 | elements=1（真实上传弹窗流程） |
| A2 | 点「＋新建对话」后 URL session 变新 | 3db1141e → d468886c |
| A3 | 后端 `chat_sessions.canvas_id` 有值 | canvas=703748de |
| A4 | 新旧 canvas_id 不同（**一对一成立**） | 9f1c9e61 ≠ 703748de |
| A5 | 新画布 elements = 0 | elements=0 |
| A6 | Excalidraw 仍挂载、前端画布为空 | `{hasExcalidraw:true, layerRows:0, minimap:"导航 0"}` |

证据：`shots/A-01-canvas-has-image.png`、`shots/A-02-new-session-empty.png`

### B. 切回历史对话 —— **6/7 通过，1 条 P1 红 ❌**
| # | 断言 | 实际 |
|---|---|---|
| B0 | 找到会话下拉按钮 | ✅ 当前会话「新对话」 |
| **B1** | **下拉能列出历史会话（可切换）** | **❌ 只有 1 项：`["新对话"]`** |
| B2 | `?session=` 打开历史会话后 URL 复原 | ✅ → 3db1141e |
| B3 | canvas_id 回到旧值 | ✅ 9f1c9e61 |
| B4 | 画布内容仍在（元素数一致） | ✅ elements=1 |
| B4b | 前端确实装载了该画布 | ✅ 缩略导航「导航 1」 |
| B5 | 两块画布互不影响 | ✅ 新会话画布仍 0 |

证据：`shots/B-00-session-dropdown.png`（下拉仅 1 项）、`shots/B-01-restored-canvas.png`（切回后那张图确实还在画布上）

> 说明：**「恢复画布」这条逻辑本身是对的**（B2–B5 全绿，截图可见原图仍在）。坏的只是「切换入口」。

### C. 有选区时聊天输入走中转站 —— **10/11 通过，1 条 P2 红 ❌**
| # | 断言 | 实际 |
|---|---|---|
| C0 | 会话就绪（含底图） | ✅ |
| C1 | 单击画布图片进入编辑层 | ✅ 基准图 600×600 |
| C2 | 框选出 1 个编号区域 | ✅ 区域数=1 |
| C3 | 区域气泡指令写入 | ✅ chip="1 换成白色背景" |
| C4 | **实时步骤块出现过（非最后一次性渲染）** | ✅ MutationObserver 捕获到 `[role=status]` 内含「读取需求」 |
| C4b | 步骤逐步追加 | ✅ 同块内标题数峰值 = 7（读取需求/判定产出/1330ms/编排决策/整理指令/提交生成/13ms） |
| C5 | 历史卡片保留 5 步完整轨迹 | ✅ 命中 5/5 |
| C5b | 卡片显示产出张数 + 置信度 | ✅「产出 1 张 · 置信度 90%」 |
| C6 | 出现任务卡或确认卡（非普通聊天） | ✅ 任务卡「生成中」+ 步骤流 |
| C7 | 结论明确时直接执行 | ✅ 任务数 0 → 1 |
| **C8** | **任务卡耗时显示正确** | **❌ UI 显示 `28800s`，实际约 `0s`** |

证据：`shots/C-01-region-filled.png`、`shots/C-02-steps-running.png`、`shots/C-03-outcome.png`

> C4/C4b 的判定方式：在发送前注入 MutationObserver 记录 `[role="status"]` 块的内容变化，证明是**逐条追加**（峰值 7 个标题）而不是等结果回来一次性铺开。这块是「中转站」的核心承诺，实测成立。

### D. 确认卡不自动执行 —— **10/11 通过，1 条 P2 红 ❌**
| # | 断言 | 实际 |
|---|---|---|
| D0 | 会话就绪 | ✅ |
| D1 | 画布上标出 2 个区域 | ✅ 区域数=2 |
| D2 | 出现确认卡且给出两个方案 | ✅ runId=23f1027f |
| D3 | 两方案 =「1 张修改图」+「2 张：修改图+透明素材」 | ✅ |
| D4 | **未点击前 15 秒内不产生任何新任务** | ✅ 任务数 0 → 0（**不自动扣费**） |
| D5 | 能点到「出 2 张」方案 | ✅ |
| D6 | 点「就按这个来」后卡片变「已选择」 | ✅ |
| D7 | 确认后产生任务 | ✅ 任务数 0 → 1 |
| D8 | **刷新后仍保留步骤轨迹** | ✅ 命中 4 步 |
| **D9** | **刷新后仍显示「已选择」状态** | **❌ 看不到；方案按钮重新变可点** |
| D10 | 刷新后保留编排规则（可折叠）+ 置信度 | ✅ `rules=true, confidence=true` |

证据：`shots/D-01-two-regions.png`、`shots/D-02-confirm-card.png`、`shots/D-03-selected.png`、`shots/D-04-after-reload.png`

### E. 画笔自由选区 —— **8/8 通过 ✅**
| # | 断言 | 实际 |
|---|---|---|
| E0/E1 | 会话就绪 + 进入编辑层 | ✅ |
| E2 | 画笔工具激活 | ✅ |
| E3 | 第一笔 → 1 个带编号区域 | ✅ |
| E4 | 第二笔在别处 → 第 2 个区域，编号连续 1,2 | ✅ |
| E5 | 两个区域各有自己的输入面（1 展开气泡 + 1 chip） | ✅ |
| E6 | **在同一区域内续画不新增区域** | ✅ 区域数仍 2（笔迹合并） |
| E7 | **矩形 + 画笔混合，区域数正确** | ✅ 区域数=3 |

证据：`shots/E-01-brush-first.png`、`shots/E-02-brush-two.png`、`shots/E-03-mixed-three.png`

### F. 多气泡不重叠/不越界 —— **3/3 通过 ✅**
3 个区域（画笔1 / 画笔2 / 矩形）逐个点开气泡实测（工具条实测 y=188, h=95）：

| 区域 | 气泡 x,y,w,h | 与其它相交 | 在容器内 | 盖工具条 |
|---|---|---|---|---|
| 1 | 844, 404, 264, 120 | 0 | ✅ | 否 |
| 2 | 1114, 674, 264, 120 | 0 | ✅ | 否 |
| 3 | 809, 440, 264, 120 | 0 | ✅ | 否 |

即：F1 任意两气泡矩形不相交（`[0,0,0]`）、F2 全部在画布容器内、F3 均未覆盖顶部工具条。
证据：`shots/F-01-bubble-1.png`、`shots/F-02-bubble-2.png`、`shots/F-03-bubble-3.png`

### G. 掩码真的上行 —— **10/10 通过 ✅**
从真实 `POST /api/generate/edit` 抓到的 multipart（只观察请求，未改写）：
```json
{"key":"prompt","value":"【区域1】把这里的人物抠出来"}
{"key":"file","name":"base.png","type":"image/png","size":11462}
{"key":"mask","name":"edit-mask.png","type":"image/png","size":11154}
{"key":"guide","name":"edit-guide.png","type":"image/png","size":14419}
{"key":"region","value":"[{\"x\":0.188,\"y\":0.238,\"w\":0.324,\"h\":0.274}]"}
{"key":"ops","value":"[{\"region\":{...},\"handler\":\"cutout\",\"prompt\":\"把这里的人物抠出来\",\"intensity\":\"fine\"}]"}
```
- G3 `mask` 字段存在且 **11154 bytes > 0**，G8 类型 `image/png`
- G5/G6 `ops` 里带 region 且 handler 已被自动识别为 `cutout`（在气泡里写「抠出来」即命中）
- G9 后端受理并建了任务（`status=running`）

### H. 视觉回归 —— **4/4 通过 ✅**
| # | 断言 | 实际 |
|---|---|---|
| H1 | 暗色主题生效 | `data-theme=dark` |
| H2 | 亮色主题生效 | `data-theme=light` |
| H3 | 390px 移动端无横向滚动 | `innerW=390, scrollW=390, bodyScrollW=390` |

证据：`shots/H-04-dark-full-card.png`（暗色，含分析卡：产出 2 张·置信度 88%·表述不唯一 + 5 步轨迹 + 两个方案 + 编排规则 4 条）、`shots/H-05-light-full-card.png`、`shots/H-01-dark.png`、`shots/H-02-light.png`、`shots/H-03-mobile-390.png`

---

## 三、缺陷清单

### 🔴 P1-1　会话切换下拉在 1:1 改造后失效，界面里无法切回任何历史对话
- **严重级别**：P1（功能错，直接打掉需求 1 的「切换历史对话」这一半）
- **复现步骤**：
  1. 登录后进入 `/workspace`（账号下已有多个历史会话）
  2. 点左上角会话下拉（带消息图标的按钮）
  3. 观察菜单项数量
- **期望**：列出当前会话 + 其它历史会话，可点选切回
- **实际**：**只有 1 项（当前会话）**，历史会话一条都不显示；用户没有任何入口切回上一轮对话
- **证据**：`shots/B-00-session-dropdown.png`
- **根因（已定位实测）**：
  - `frontend/src/components/chat/ChatPanel.tsx:166` → `chatApi.listSessions(canvasId)`
  - `frontend/src/components/canvas/WorkspaceView.tsx:881/908/1034` → `<ChatPanel canvasId={canvasId ?? undefined}>`
  - `backend/app/routers/chat.py:27` → 支持 `?canvas_id=` 过滤
  - 实测：admin 名下 **13 个会话**；任一 canvas_id 过滤后 = **1 个**（因为现在每个会话一块独立画布）
- **归因**：`listSessions(canvasId)` 这行本轮之前就有（`git show HEAD:...ChatPanel.tsx` 同样存在），在旧的「多会话共用一块画布」模型下过滤后仍返回多条、切换可用；**本轮做成 1:1 后，这条过滤把列表压成 1 条** → 属本轮引入的交互回归
- **疑似文件**：`frontend/src/components/chat/ChatPanel.tsx`（`loadSessions`）；可选配合 `WorkspaceView.tsx` 的 `canvasId` 传参
- **修复方向（未改产品代码）**：会话列表不按 canvas_id 过滤（`listSessions()` 无参），当前会话高亮；或后端在 1:1 模型下改为按 project 维度返回
- **已验证的对照**：绕过下拉、直接用 `?session=<id>` 打开同一历史会话，画布**正确恢复**（B2–B5 全绿），说明坏的只是入口不是恢复逻辑

### 🟠 P2-1　任务耗时/时间戳把 UTC 当本地时间，固定多 8 小时
- **严重级别**：P2（显示错误 + 连带「生成慢」提示常驻，不影响功能）
- **复现**：任意一次生成，看任务卡头部
- **期望**：`生成中 · 3s，通常 30–90 秒`
- **实际**：刚提交就显示 **`生成中 · 28800s，通常 30–90 秒`**，且下面永远挂着 `仍在生成，超时会自动结束并退回额度`（因为 elapsed 恒 ≥ 28800 ≥ 180）
- **实测数据**：`UI 显示 28800s / 实际约 0s`；后端返回 `created_at=2026-10-17T16:11:32.367454`（**naive UTC，无 Z**），而浏览器按本地时区（UTC+8）解析 → 差值恰好 28800s
- **疑似文件**：`frontend/src/components/chat/GenerationResultCard.tsx:64-70`（`new Date(task.created_at)` 直接解析无时区字符串）；根治建议后端序列化时输出带 `Z`/`+00:00` 的 ISO
- **附带影响**：消息时间戳同样偏 8 小时（截图里本地 00:11 的消息显示为 `10–17 16:11`）

### 🟠 P2-2　确认后刷新页面丢失「已选择」状态，方案按钮重新变可点
- **严重级别**：P2（状态一致性 / 明确写在验收口径里的能力未达成；**无重复扣费风险，已实测**）
- **复现步骤**：
  1. 两个区域（restyle + cutout）→ 侧栏发送「把背景换成白色，或者把人物抠出来」
  2. 出现确认卡 → 点「出 2 张」→ 点「就按这个来」（卡片正确变「已选择」）
  3. 刷新页面
- **期望**：该 assistant 消息仍显示「已选择：出 2 张…，正在生成」
- **实际**：轨迹（步骤 4 条）和编排规则都在，但**「已选择」不见**，两个方案卡片带着可点的「就按这个来」重新出现
- **证据**：`shots/D-04-after-reload.png`、`shots/H-04-dark-full-card.png`（可见按钮仍可点）
- **根因**：assistant 消息里的 run 快照是分析时的**冻结副本**：`GET /api/chat/messages` 返回 `status=confirm, task_ids=[], 无 chosen_option_id`；DB 里 `skill_runs.status` 已变 `completed`、`task_ids` 已填，但**没有回写到消息附件**，且 `SkillRun` 模型本身没有 `chosen_option_id` 字段
- **严重性下调依据（已实测）**：后端 `skills.confirm_run` 有幂等护栏（`status=completed and task_ids → 直接返回既有 task_ids`）。我用同一 run 再确认一次：`{"status":"completed","task_ids":["c9e69be2..."],"tasks":[]}`，任务总数 `1 → 1`，**没有二次建任务、没有重复扣费**
- **疑似文件**：`frontend/src/components/chat/ChatPanel.tsx`（applyResult/恢复 pending 逻辑）、`backend/app/services/skills.py:921`（幂等分支）、消息附件序列化处

### ⚪ P3-1　新建的空画布顶部显示「未保存的更改」
- 新建对话后画布明明是空的，右上角仍显示 `未保存的更改`（见 `shots/A-02-new-session-empty.png`、`shots/B-00-session-dropdown.png`）
- 体感问题：空画布没有可保存内容却提示脏状态。疑似 `applyScene(空)` 触发 onChange 把 dirty 置真
- 严重级别 P3，不影响功能

### ⚪ P3-2　缩略导航计数在编辑态显示 0
- 画布上明明有 1 张图（后端 `elements=1` 已核对），进入图片编辑层后右下角仍显示 `导航 0`（`shots/F-02-bubble-2.png`、`shots/E-03-mixed-three.png`）
- 刷新后正常显示 `导航 1`（`shots/B-01-restored-canvas.png`）。疑似 store 里的 `canvas.state` 在编辑态未同步
- 严重级别 P3，纯显示
> 注：B4b 的断言用的是「刷新后」的快照，因此该 P3 不影响 B 组结论。

---

## 四、我改过的测试文件与理由

**没有修改任何产品代码，也没有修改任何既有测试。** `pytest` 111/0/36 本来就达标，无需改断言。

本轮新增的都是**我自己的 E2E 脚本**（放在 `deliverables/qa/`，不在 `tests/` 或 `src/` 里，不进构建）：

| 文件 | 作用 |
|---|---|
| `harness.mjs` | 零依赖 CDP 封装（复用 `e2e/ui_verify.mjs` 范式）+ 真实登录 + 后端 API 交叉验证 + 同步落盘 trace |
| `ab.mjs` | 场景 A/B |
| `cd.mjs` | 场景 C/D |
| `ef.mjs` | 场景 E/F |
| `gh.mjs` | 场景 G/H |
| `h2.mjs` | 补拍「分析卡完整入镜」的暗/亮截图 |

调试过程中修掉的是**测试脚本自己的 bug**（均不涉及产品判定）：
1. `[role=status]` 只在分析进行中短暂存在，最初用「等它出现」的写法会偶发漏抓 → 改为 MutationObserver 记录（C4/C4b）
2. 会话下拉触发按钮存在 0×0 的隐藏副本，取 `find` 第一个会点到不可见元素 → 改为过滤 `width>0`
3. Radix DropdownMenu 不认 `el.click()`，必须真实鼠标事件 → 改为 `Input.dispatchMouseEvent`
4. 页内 `fetch` 打 27181 会被 CORS 拦 → 数据校验全部改走 Node 侧直连后端
5. 编辑层里有两个「生成」（中栏素材面板 tab + 编辑气泡按钮）→ 改为按祖先里最近的编辑气泡提示语打分挑选
6. 任务卡耗时断言起初在 POST 后 100ms 查任务数 → 改为轮询 30s
7. E5 断言写错（刚画完的区域是**展开气泡**不是 chip）→ 改为「气泡 + chip 合计 = 区域数」

---

## 五、demo 与真实链路的边界（重要）

**真实（这些结论可以当依据）**
- 会话 ↔ 画布的所有读写：`chat_sessions.canvas_id`、`GET /api/canvases/{id}` 的 elements 都是真实 DB 数据
- 需求分析中转站：真实 SSE 流（9 事件）、真实判定规则（`rule_hit=ambiguous`）、真实置信度、真实落库的 `skill_runs`
- 确认卡的执行与幂等：真实 `POST /api/chat/runs/{id}/confirm`，二次确认实测不重复建任务
- 画笔/矩形/套索选区、气泡布局、mask 生成：**前端真实计算**（mask 11154 bytes 的 PNG 真的进了 multipart）
- 任务创建、状态轮询、额度变更：真实后端任务表

**模拟（这些不能当依据）**
- **最终生成的图片是占位图，不是真实模型产物**：我把结果图下载下来看过，是「白底 + 蓝色圆 + 红色编号 1」的合成图（`/tmp/result_check.png`），与上传的底图（蓝圆+红方块）无关，也没有按任何 prompt 修改
- 也就是说：**「改图/抠图的效果」完全没被验证过**，只验证了「指令、选区、mask 有没有正确送达后端」。上游真实模型接通后，画质/贴合度/抠图边缘需要重新验一轮
- 观察项：该任务 `demo` 字段返回 `False`，但产物明显是占位图 —— 标记与实际不一致，建议后端确认（P3，不属本轮三块能力范围）
- 聊天（非选区路径）在网关不可达时走本地模拟回复，已在 UI 上明确标注「【演示模式】」

---

## 六、环境备注（与产品缺陷严格区分）

1. **Chrome 沙箱**：本机工具沙箱下 Chrome 需 `--no-sandbox`（否则 GPU/network service 崩溃），另加 `--enable-unsafe-swiftshader` 保证软件渲染。**环境问题，不影响结论。**
2. **CDP 新 tab 冻结**：`/json/new?url=` 建出来的后台 tab 会被 Chrome 冻结，`Runtime.evaluate` 直接超时（60s）。已改为复用已有 tab + 打开前 `Page.bringToFront`。**环境问题。**
3. **历史会话过重**：`cbf33148` 这块画布上有 30+ 张图，软件渲染下 Excalidraw 挂载会慢到超时。所有场景因此改用「通过真实 API 新建干净会话」做基线（仍是真实链路，只是数据量小）。**环境问题。**
4. **vite build 被 safe-delete shim 拦**：见前文，改 outDir 绕过。**环境问题。**
5. **端口 3000 不是模型上游**：3000 上跑的是一个 Next.js 页面（返回 `<!DOCTYPE html>...`），不是图像模型 API —— 这解释了为什么产物是占位图。**环境问题（上游未就绪），不算代码 bug。**

### 复跑方法
```bash
# 前置：Chrome 带调试端口启动
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/cs-chrome-qa \
  --no-sandbox --enable-unsafe-swiftshader --window-size=1440,900 about:blank &

cd deliverables/qa
node ab.mjs   # 场景 A/B
node cd.mjs   # 场景 C/D
node ef.mjs   # 场景 E/F
node gh.mjs   # 场景 G/H
# 进度日志会同步写到 /tmp/qa-trace.log（进程被强杀也不丢）
```

---

## 七、给主理人的建议排序

1. **修 P1-1**（会话切换入口）—— 这是需求 1 的一半，用户可感知且无替代路径。改动很小（去掉 canvas_id 过滤即可），但不能由我改产品代码。
2. **P2-1 时区** —— 一行改动（解析时补 `Z`，或后端输出带时区），但「28800s」这种数字出现在生产会很丢人。
3. **P2-2 已选择状态** —— 建议后端在 confirm 时把 `status/task_ids/chosen_option_id` 回写到消息附件；顺带给 `SkillRun` 加 `chosen_option_id` 字段。风险低（后端幂等已兜底）。
4. P3-1 / P3-2 可择机。
5. 上游模型接通后，**改图/抠图效果需要单独补一轮视觉验收**，本轮无法覆盖。
