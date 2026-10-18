# Canvas Studio × Lovart 对标实现方案 + 开发提示词

**日期**：2026-10-17
**适用代码库**：`/Users/meishiduoshuijiao/Desktop/canvas-studio`
**技术栈**：React 19 + Vite 6 + Tailwind 4 + Zustand / FastAPI + SQLAlchemy 2.0 async + SQLite / 独立 gateway（转发 gpt-image-2 与对话模型）
**阅读对象**：直接落地的开发同学 / AI 编码代理

---

## 0. 一句话结论

现有代码已经完成「画布 + 选区编辑 + 上游出图 + 额度」的主干，**缺的是三件事**：
① 提交前的**需求分析与数量确认**（现在是直接按 `n` 出图）；
② **会话 ↔ 画布**的一对一绑定（现在所有会话共用同一块画布，新建/切换都不换画布）；
③ 选区交互的**多气泡调度**与**画笔选区**（现在画笔只是标注，不是可提交的掩码；多区域只有一个气泡是展开的）。

本方案不推倒重来，全部基于现有模块增量实现，并给出可直接交给编码代理的分阶段提示词（第 8 节）。

---

## 1. 现状盘点（决定"改哪里"，不要重复造）

### 1.1 已经能用的（直接复用，不要重写）

| 能力 | 现状 | 位置 |
|---|---|---|
| 画布（Excalidraw） | 元素内嵌 `state` JSON，自动保存、缩略图、分享 | `frontend/src/components/canvas/CanvasExcali.tsx`、`hooks/use-canvas-autosave.ts`、`backend/app/services/canvas_service.py` |
| 文生图 | `POST /api/generate/image`，异步任务 + 轮询 + 失败退款 | `backend/app/routers/generate.py`、`services/generate_service.py` |
| 图生图 / 局部编辑 | `POST /api/generate/edit`（multipart：base + guide + ops），走 gpt-image-2；⚠️ 当前 `_run_edit_task` **只发一张标注图，没有把 mask 传给上游**（`_render_union_mask` 是未接线的死代码） | 同上；能力注册表 `services/edit_handlers.py` |
| 能力注册表 | restyle / cutout / transparent / remove / enhance，声明式扩展 | `services/edit_handlers.py` |
| 意图分析（**未接入出图主链路**） | `POST /api/generate/plan` 用对话模型把自然语言 → `ops` | `services/plan_service.py`、`routers/generate.py` |
| 编辑思考过程 | `params.thinking` 逐步落库，前端展示 | `generate_service._push_thinking`、`GenerationResultCard.tsx` |
| 提示词优化 | 提交前用对话模型改写指令（区域编号校验） | `services/edit_prompt_service.py` |
| 额度 | 预扣 / 确认 / 幂等退款 | `services/quota_service.py` |
| 会话 | 建/删/切、消息、SSE 流式对话 | `services/chat_service.py`、`routers/chat.py` |
| 结果安全区 | 生成结果先落右侧，点了才进画布 | `components/canvas/ResultDock.tsx` |
| 视觉系统 | 冷白/暗色双主题 + 靛紫品牌色 + 渐变按钮 | `styles/tokens.css`、`index.css` |

### 1.2 半成品（要补逻辑，不是新写）

| 能力 | 差什么 | 位置 |
|---|---|---|
| 选区 | 只有「矩形框」；「画笔」产出的是涂鸦标注，**没有转成掩码**；且后端目前根本不发 mask | `components/canvas/ImageEditLayer.tsx`、`generate_service._run_edit_task` |
| 多区域气泡 | 有 `activeRegionId`，但同时只有 1 个展开；收起态是 chip，**没有碰撞避让**，贴边会被裁 | 同上 `regionBubbleStyle()` |
| 编辑分析 | 只做「提示词改写」，**不判断生成数量**，也不回传"我理解成了什么" | `services/edit_prompt_service.py` |
| 会话 | `chat_sessions.canvas_id` 字段存在但**前端不用**：新建会话传当前画布，切换会话不换画布 | `ChatPanel.handleCreateSession`、`WorkspaceView` 的画布解析 effect |

### 1.3 完全没有（本方案新增）

1. **数量确认交互**：AI 判定「1 张 / 2 张」不确定时，在对话流里插入可点选卡片，并把选择结果写回消息。
2. **生成前的分析事件流**：文生图没有 SSE/分步状态，只有一个 30% 的进度。
3. **会话级画布生命周期**：新建会话 → 建新画布（空）；切换会话 → 保存当前 → 载入目标；删除会话 → 画布保留但解绑。
4. **画笔选区的掩码上传**（现在 mask 只由后端按矩形生成）。
5. **统一的 `AnalyzeCard` / `ConfirmCountCard` / `SelectionToolbar` 组件**。

---

## 2. 目标架构

### 2.1 数据模型（增量，不破坏现有数据）

```text
chat_sessions
  + canvas_id           已有（FK canvases，nullable）——本方案改为「新会话必填」
  + last_message_at     新增（列表排序用，避免 order by updated_at 被自动保存刷新）
  + deleted_at          已有

chat_messages
  + meta JSON           新增：{analysis?: {...}, decision?: {n, at}, task_ids?: [...]}
                        —— 分析结论与"用户选了几张"必须持久化，刷新后仍可见

generation_tasks
  + params.analysis     已有 params JSON，写入 {intent, suggested_n, confidence, reasons}
  + params.decision     写入 {n, source: "auto"|"user", at}
  + params.thinking     已有

canvases
  （不改结构）
```

> 迁移策略：SQLite `ALTER TABLE ADD COLUMN`（nullable），老数据 `canvas_id` 为空时按"取该项目第一块画布"兜底（第 4.4 节）。

### 2.2 接口契约

#### A. 新增：`POST /api/generate/analyze`

提交前分析，返回是否可以直接出图、建议数量、优化后的提示词。

```jsonc
// 请求
{
  "message": "把这几个卖点做成两张海报",     // 用户原话（必填）
  "canvas_id": "uuid|null",
  "session_id": "uuid|null",
  "has_reference": true,                    // 是否带参考图/选区
  "region_count": 2,                         // 选区数量
  "mode": "generate" | "edit"                // 文生图 / 图生图
}

// 响应
{
  "code": "OK",
  "data": {
    "reply": "我理解你要做 2 张不同排版的卖点海报",   // 给用户看的一句话
    "intent": "marketing_poster",
    "suggested_n": 2,
    "confidence": 0.62,                        // < 0.75 时前端必须确认
    "needs_confirm": true,
    "options": [
      { "n": 1, "label": "先出 1 张", "hint": "更快，先看方向" },
      { "n": 2, "label": "出 2 张对比", "hint": "两种排版挑一个" }
    ],
    "optimized_prompt": "……（已补全主体/风格/比例/留白要求）",
    "reason": "用户说“两张”，但未指定差异点"
  }
}
```

规则：
- `confidence >= 0.75` 且能确定数量 → `needs_confirm=false`，直接进入生成。
- 模型超时（>8s）或解析失败 → 返回 `needs_confirm=true` + 默认 1 张，`reason="没太确定，先按 1 张来？"`。**绝不因为分析失败而阻断出图**。
- 该接口**不扣额度**。

#### B. 变更：`POST /api/generate/image` 增加字段

```jsonc
{
  "prompt": "...",
  "n": 1,
  "session_id": "...",
  "canvas_id": "...",
  "analysis": { "suggested_n": 2, "intent": "..." },   // 可选，落 params
  "decision": { "n": 2, "source": "user" }             // 可选，落 params
}
```

#### C. 变更：`POST /api/generate/edit` 增加 `brush_mask`

multipart 增加可选文件 `brush_mask`（PNG，透明=要改）。后端优先使用它；没有则沿用矩形并集掩码。

#### D. 新增：会话级画布

```text
POST   /api/chat/sessions            // 变更：body 增加 create_canvas=true
       → { session, canvas }         // 一次性把空画布建好并绑定
GET    /api/chat/sessions/{id}/canvas
       → { canvas }                  // 切换会话时取画布
DELETE /api/chat/sessions/{id}       // 只删会话与消息，画布保留（不级联删）
```

`create_canvas` 的语义：在同一 `project_id` 下新建一块空画布（`name` 取会话标题），绑定到 `canvas_id`。

#### E. 事件协议（SSE，编辑/生成任务共用）

前端已有 `useChatStream`（对话）与轮询（任务）。本方案把"分析过程"也做成事件，复用同一套渲染：

```text
event: analysis   data: {"step":"understanding","text":"正在读你的需求…"}
event: analysis   data: {"step":"prompt","text":"已整理成 3 条具体指令"}
event: analysis   data: {"step":"decide","text":"我理解要做 2 张","n":2,"confidence":0.62}
event: confirm    data: {"options":[{"n":1,...},{"n":2,...}]}   // 需要用户选
event: task       data: {"task_id":"...","status":"running","progress":45}
event: done       data: {"task_ids":["..."],"n":2}
```

非流式兜底：任务轮询时读 `task.params.thinking` 渲染同样的步骤条。

### 2.3 前端状态

```text
ChatPanel
  ├─ messages: ChatMessage[]            // 含 meta.analysis / meta.decision
  ├─ pendingConfirm: ConfirmRequest|null // 数量确认卡片
  ├─ tasks: GenerationTask[]            // 轮询
  └─ timeline = merge(messages, tasks)  // 已有

WorkspaceView
  ├─ canvasId                            // 由 session.canvas_id 决定
  ├─ initialData                         // 切换画布时整块替换
  └─ autosave                            // 切换前必须 flush + cancel

ImageEditLayer
  ├─ tool: 'rect' | 'brush'              // 画笔改为"选区"
  ├─ regions: EditRegion[]               // 每个区域独立 prompt/handler/mask
  ├─ activeRegionId                      // 仅一个处于编辑态
  └─ bubbleLayout: Map<id, {x,y,side}>   // 碰撞计算后的位置
```

---

## 3. 核心模块实现方案

### M1 文生图 / 图生图（含二次编辑）

**目标**：画布上任意一张图，单击 → 进入编辑层 → 框选/涂抹 → 写指令 → 提交图生图；结果回到安全区，可再编辑。

**实现要点**

1. 文生图：`ChatPanel.send()` 在 `mode==='image'` 时，先调 `analyze`（M2），拿到 `optimized_prompt` 与 `n`，再调 `/generate/image`。
2. 图生图：`ImageEditLayer` 提交 `base + brush_mask + guide + ops`；**先补上「把 mask 真正传给上游」这一环**——现在 `_run_edit_task` 只发标注图，mask 被丢弃，这也是「框选不精确」的根因之一。改法：把 `_render_union_mask`（矩形并集）接进 `_run_edit_task` 的 files，有 `brush_mask` 时优先用它。沿用现有 `create_edit_task`（一次提交一次上游调用、按 `QUOTA_PRICE_EDIT` 计费）。
3. 二次编辑：结果图进入画布后，走的是同一套 `enterEdit(element)`（现有逻辑），不需要新入口。
4. 尺寸对齐：`base` 用原图原始尺寸，`size` 参数取 `f"{w}x{h}"`（≤2048），避免上游回 1024 导致合成错位。

**验收**：同一张图可连续编辑 3 次，每次都能框选新区域且旧区域像素不变。

---

### M2 智能需求分析中转站 + 数量确认

**目标**：每次提交前，先由对话模型判断「要几张、怎么改」，不确定时让用户点选，而不是猜。

**后端**

```
services/analyze_service.py
  async def analyze(db, user, *, message, mode, region_count, has_reference) -> AnalyzeResult
```

- 提示词模板：`app/prompts/analyze.md`（可被 `PROMPT_ANALYZE` 配置覆盖）。
- 输出严格 JSON：`{reply, intent, n, confidence, reason, optimized_prompt}`。
- 解析容错：围栏抽取 → 失败则 `n=1, confidence=0, needs_confirm=true`。
- 数量夹取：文生图 1~2，图生图固定 1（多区域仍是一次调用，见 M3）。
- 超时：`asyncio.wait_for(..., 8s)`。
- 结果写入 `chat_messages.meta.analysis`（用户消息那条），刷新后仍在。

**前端**

新增 `components/chat/ConfirmCountCard.tsx`：

```
┌────────────────────────────────┐
│ 我理解你要做 2 张不同排版的海报   │
│ 但没确定差异点，你想怎么来？      │
│  [先出 1 张]  [出 2 张对比]      │
│  12s 后默认按 1 张继续           │
└────────────────────────────────┘
```

- 位置：插在对话流对应消息之后（不是 modal），保证上下文可见。
- 倒计时 15s，超时按 `n=1` 继续，并在卡片上留一行"已按 1 张继续"。
- 选择后：卡片置为已选状态（保留在历史里），随后发起生成。
- **同一时刻只允许一个待确认卡片**；新提交会作废旧的（避免堆积）。

**状态机**

```
IDLE → ANALYZING → (needs_confirm? CONFIRMING : READY) → GENERATING → IDLE
              ↘ 失败(超时/解析) → CONFIRMING(默认1张)
CONFIRMING --用户选择/超时--> READY
```

---

### M3 选区交互（矩形 + 画笔）与多气泡调度

#### 3.1 两种选区

| 模式 | 交互 | 产出 |
|---|---|---|
| 矩形（rect） | 拖拽画框，松开即建区 | `region {x,y,w,h}`（归一化） |
| 画笔（brush） | 涂抹，松开后取笔迹包围盒 + 笔迹掩码 | `region`（包围盒）+ `mask`（笔迹 PNG） |

- 画笔必须产出**掩码**：前端在离屏 canvas 上以白色画笔迹、其余透明，导出 PNG 作为 `brush_mask`；后端收到后直接作为 `files` 里的 `mask`（矩形并集掩码 `_render_union_mask` 已存在，但**尚未接入 `_run_edit_task`**，本方案要接线）。
- 画笔粗细跟随笔刷设置；支持橡皮（`destination-out`）。
- 两种模式可混用：先框一块，再涂一块，形成 2 个区域。

#### 3.2 多气泡调度（本模块的核心）

规则（按优先级实现）：

1. **同一时刻只有一个区域处于编辑态**（`activeRegionId`），其余显示为**胶囊 chip**（内容截断 12 字）。
2. **位置**：气泡默认贴框下方 10px；下方空间不足（`bottom + 气泡高 + 10 > 容器高`）翻到框上方；水平方向 `clamp(8, 框左, 容器宽 - 气泡宽 - 8)`。
3. **碰撞避让**：所有可见气泡按 `top` 排序，若与上一个重叠，则整体下移 `overlap + 8`；仍超出容器则改为"向上堆叠"。计算结果缓存在 `bubbleLayout`，只在 regions/容器尺寸变化时重算（不要每帧算）。
4. **不打断输入**：点击气泡外部时——
   - 若该区域**已有文字**：收起为 chip（不删除）。
   - 若**没有文字**：保持展开（避免用户刚点开就被关掉）。
5. **层级**：编辑态 `z-40`，chip `z-30`；容器 `overflow: visible`（气泡必须挂在与图片同级的浮层，不能放在 `overflow-hidden` 的图片容器里）。
6. **删除**：框右上角 ×（已有）；删除时若它是 active，则 active 置空。
7. **数量上限**：8 个区域（已有），超出提示。
8. **提交前校验**：每个区域按 handler 判断是否需要文字（`needsPrompt`）；缺文字的卡片抖动 + 聚焦，不弹 toast。

#### 3.3 选区工具条

`SelectionToolbar`（图片上方浮条）：

```
[▭ 矩形] [✎ 画笔] [粗细 ●●●] [颜色] | [清空]
```

- 切换工具不清空已有选区。
- 画笔模式下显示笔刷粗细，矩形模式隐藏。

**验收**：3 个区域同时存在时，点任一 chip 能展开对应气泡；展开/收起 20 次无错位、无遮挡；气泡不超出画布可视区。

---

### M4 会话 ↔ 画布 绑定

**目标**：新建对话 = 全新空画布；切换对话 = 恢复当时的画布与编辑内容。

**后端**

```python
# services/chat_service.py
async def create_session(db, user, *, canvas_id=None, create_canvas=False, title=None):
    if create_canvas:
        canvas = await canvas_service.create_canvas(db, user, project_id=..., name=title or "新对话")
        canvas_id = canvas.id
    session = ChatSession(..., canvas_id=canvas_id)
```

`GET /api/chat/sessions/{id}/canvas` 返回该会话的画布（无则 404，前端兜底建一块）。

**前端**

1. `WorkspaceView` 的画布解析 effect 改为：
   ```ts
   if (sessionId) {
     const session = await chatApi.getSession(sessionId)      // 或从列表里取
     if (session.canvas_id) { load(session.canvas_id) }
     else { const created = await canvasesApi.create(...); await chatApi.bindCanvas(sessionId, created.id); load(created.id) }
   } else { /* 原有默认画布逻辑 */ }
   ```
2. **切换顺序（防串数据）**：
   ```
   await autosave.flush()      // 把当前场景写完
   autosave.cancel()           // 停掉旧画布的定时器
   setInitialData(undefined)   // 先卸载，避免旧场景残留
   const next = await load(targetCanvasId)
   setCanvasId(next.id); setInitialData(next.state)
   <CanvasExcali key={next.id} .../>   // key 变化强制重建，彻底清空撤销栈
   ```
3. 新建对话：`chatApi.createSession({ create_canvas: true })` → 后端返回 `{session, canvas}` → 前端直接 `setCanvasId(canvas.id)` + 空 `initialData`，并 `navigate({ search: { session } })`。
4. 删除会话：只删会话；画布留在项目里（用户可在「我的项目」找回）。

**边界**

- 同一画布被两个会话引用（历史数据）：允许，但新建时不再复用。
- 切换过程中用户快速连点：用 `switchSeqRef` 序号丢弃过期响应。
- 自动保存冲突：以 `updated_at` 较新者为准；保存接口带 `If-Unmodified-Since` 语义（可选，二期）。

---

### M5 侧栏对话流与状态可视化

**消息类型**（渲染分派）

| 类型 | 组件 | 说明 |
|---|---|---|
| user | `ChatMessage` | 右对齐，中性气泡 |
| assistant | `ChatMessage` + Markdown | 左对齐 |
| analysis | `AnalysisSteps` | 步骤条（理解 → 整理提示词 → 决定数量） |
| confirm | `ConfirmCountCard` | 数量选择 |
| task | `GenerationResultCard` | 结果 + 思考过程 + 投放/重试 |

**布局**

- 会话头：`会话选择 ⌄` + `＋`；有任务时右侧 `● 生成中 N`。
- 消息区：`gap-3`，AI 侧 24px 头像，用户侧无头像靠右。
- 输入区：`＋`（上传/素材）、模式切换（对话/生图）、发送/停止。
- 新消息跟随：距底 <80px 才自动滚；否则出「回到最新 · N」。

**即时反馈**

- 选区绘制：拖拽时显示虚线预览；松开有 120ms 的缩放落位动画。
- 提交：按钮转圈 + 输入框禁用；分析阶段显示 `正在理解需求…`。
- 生成中：骨架 + 计时 + 90/180s 安抚文案（已有）。

---

### M6 视觉统一（对标 Lovart 的"干净"）

| 项 | 规范 |
|---|---|
| 品牌色 | 靛紫 `#5B5BD6`，渐变 `#6D5EFC → #5B5BD6 → #4F7CF7`（仅主按钮/CTA） |
| 背景 | `bg #F2F4FA` / 暗色 `#0A0B10`；工作区分栏缝隙 `gutter #DDE2EE` |
| 卡片 | 圆角 14–16px，`border-border/60`，阴影 `shadow-sheet`，悬浮 `shadow-lift` |
| 控件 | 按钮/输入 10–14px 圆角；高度 36/40px；焦点只提亮描边，不做常驻光圈 |
| 气泡 | 用户 `surface-hover`；AI 无气泡；区域气泡 `surface + border-brand` |
| 图标 | lucide 16/18px，stroke 1.6 |
| 动效 | 120ms 颜色 / 200ms 位移 / 320ms 浮层；`prefers-reduced-motion` 全关 |

**禁止**：纯色大色块、1px 分割线切版、超过两级阴影、渐变文字。

---

## 4. 关键时序

### 4.1 文生图（需确认）

```
用户输入 ──► analyze(8s) ──► needs_confirm?
                              ├─ 否 → /generate/image(n) → 轮询 → 结果卡
                              └─ 是 → ConfirmCountCard
                                        ├─ 用户选 n → /generate/image(n)
                                        └─ 15s 超时 → n=1
```

### 4.2 图生图（多区域）

```
框选/涂抹 ×N ──► 每区域填指令 ──► 提交
   │                              │
   └─ 生成 brush_mask ────────────┤
                                  ▼
                    /generate/edit (base+mask+guide+ops)
                                  ▼
                    上游 gpt-image-2（一次调用）
                                  ▼
                    结果 → 安全区 → 用户点「放入画布」
```

### 4.3 新建 / 切换会话

```
新建: create_session(create_canvas) ─► canvas 空 ─► remount 画布(key)
切换: flush autosave ─► cancel ─► 卸载 ─► 载入目标 canvas ─► remount
```

---

## 5. 交互细则（可逐条验收）

| # | 规则 |
|---|---|
| R1 | 提交后 300ms 内必须出现"正在理解"状态，否则用户会重复点击 |
| R2 | 分析失败不得阻断出图，默认 1 张并提示 |
| R3 | 确认卡片 15s 倒计时，倒计时结束按默认值继续，卡片保留"已按 1 张继续" |
| R4 | 同一时刻只允许一个待确认卡片 |
| R5 | 矩形/画笔可混用，切换工具不清空已有选区 |
| R6 | 画笔必须产出掩码，不能只靠包围盒 |
| R7 | 每个区域独立 prompt/handler，互不影响 |
| R8 | 气泡默认在框下方，空间不足翻上方，水平夹取 |
| R9 | 气泡之间不重叠（重叠则下移/上翻） |
| R10 | 点气泡外部：有文字→收起；无文字→保持 |
| R11 | 气泡层级高于图片、低于模态 |
| R12 | 删除区域时若为 active，active 置空 |
| R13 | 缺必填文字的区域，提交时聚焦该气泡并抖动，不用 toast |
| R14 | 新建对话 = 新画布；旧画布不被清空 |
| R15 | 切换对话先保存再卸载，避免串场景 |
| R16 | 切换后撤销栈必须清空（key 重挂载） |
| R17 | 删除会话不删画布 |
| R18 | 生成失败自动退款（已有），文案不暴露内部错误 |
| R19 | 生成结果不自动落画布（已有），必须显式投放 |
| R20 | 所有异步按钮有 loading，且防连点 |
| R21 | 暗色/亮色两套下，气泡与卡片对比度 ≥ 4.5:1 |
| R22 | 移动端（<768）对话与画布分段切换，气泡宽度自适应 |
| R23 | 分析/思考过程刷新后仍可见（落库，不只存内存） |
| R24 | 任何"AI 在做什么"的状态都必须可解释，不允许纯转圈超过 2s |

---

## 6. 验收清单

**功能**
- [ ] 文生图：输入"做两张不同风格的海报" → 出现确认卡 → 选 2 → 出 2 张 → 都进安全区
- [ ] 不确定时（"做个海报"）默认 1 张，15s 后自动继续
- [ ] 图生图：框 2 块 + 涂 1 块 → 3 个区域各有指令 → 一次提交成功 → 结果只改这 3 处
- [ ] 画笔掩码生效：只涂人物轮廓，背景像素不变
- [ ] 新建对话 → 画布清空；切回旧对话 → 旧画布内容完整恢复
- [ ] 连续新建 5 个会话，每个画布互不影响
- [ ] 删除会话后，项目里仍能找到那块画布

**交互**
- [ ] 3 个区域的气泡无重叠、不超出可视区
- [ ] 气泡收起/展开 20 次位置稳定
- [ ] 缺指令提交时定位到对应气泡
- [ ] 生成中 90s/180s 有安抚文案
- [ ] 断网重连后，分析/任务状态能恢复

**视觉**
- [ ] 亮/暗两套下所有新组件对比度达标
- [ ] 无纯色大色块、无 1px 分割线切版
- [ ] 移动端 390px 宽不横向溢出

---

## 7. 工作量与顺序（建议）

| 阶段 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| P0 | 会话↔画布绑定（M4） | 无 | 1.5d |
| P0 | analyze 接口 + 确认卡（M2） | 无 | 2d |
| P1 | 画笔选区 + brush_mask（M3.1） | 后端掩码支持 | 2d |
| P1 | 多气泡调度（M3.2） | 无 | 1.5d |
| P1 | 文生图接入 analyze（M1） | M2 | 1d |
| P2 | 事件流/思考过程统一（M5） | M2 | 1.5d |
| P2 | 视觉收口（M6） | 全部 | 1d |

---

## 8. 开发提示词（可直接复制给编码代理）

> 每段都自包含：背景、要改的文件、验收标准。按顺序执行，每段结束跑 `vite build` 与 `pytest -q`。

### 提示词 1：会话与画布一对一

```text
你在 /Users/meishiduoshuijiao/Desktop/canvas-studio 这个项目里工作。
技术栈：React19 + Vite + Zustand（frontend/），FastAPI + SQLAlchemy async + SQLite（backend/）。

目标：让「一个会话 = 一块画布」。

后端：
1. backend/app/services/chat_service.py 的 create_session 增加参数 create_canvas: bool=False。
   为 True 时用 canvas_service 在用户默认项目下新建一块空画布，name 用会话标题，写入 chat_sessions.canvas_id。
2. 新增 GET /api/chat/sessions/{id}/canvas，返回该会话绑定的画布；无绑定返回 404。
3. DELETE 会话只删会话与消息，不删画布。
4. 给 chat_sessions 增加 last_message_at（nullable），发消息时更新。

前端：
1. frontend/src/components/chat/ChatPanel.tsx 的 handleCreateSession 改为调用
   chatApi.createSession({ create_canvas: true })，拿到 {session, canvas} 后回调 onSessionChange(session.id) 与 onCanvasChange(canvas.id)。
2. frontend/src/components/canvas/WorkspaceView.tsx：
   - 画布解析 effect 改为：有 sessionId 时先取 session.canvas_id，没有就建一块并绑定；
   - 切换画布前必须 await autosave.flush() → autosave.cancel() → setInitialData(undefined) → 载入新画布 → setCanvasId；
   - <CanvasExcali> 加 key={canvasId}，保证撤销栈清空。
3. 快速连点切换用自增序号丢弃过期响应。

验收：
- 新建对话后画布为空，旧对话切回来内容完整；
- 连续新建 5 个会话互不影响；
- 切换 10 次后 console 无报错、无重复 autosave 定时器。
```

### 提示词 2：需求分析接口

```text
继续在 canvas-studio 项目工作。

目标：提交前先分析需求，判断生成数量，不确定时让用户确认。

后端：
1. 新建 backend/app/services/analyze_service.py：
   async def analyze(db, user, *, message, mode, region_count, has_reference) -> dict
   - 用 gateway_client.llm_completions，模型取 config LLM_MODEL / INTENT_PLANNER_MODEL；
   - 系统提示词放在 backend/app/prompts/analyze.md，占位符 {{message}} {{mode}} {{region_count}}；
   - 要求模型输出严格 JSON：{reply,intent,n,confidence,reason,optimized_prompt}；
   - n 夹取 1..2（mode=edit 时固定 1）；confidence<0.75 或解析失败 → needs_confirm=true；
   - 用 asyncio.wait_for 包 8 秒超时，任何异常都返回 {n:1, confidence:0, needs_confirm:true}，不抛错。
2. 新增 POST /api/generate/analyze（backend/app/routers/generate.py），schema 见
   backend/app/schemas/generate.py 的 AnalyzeRequest/AnalyzeResponse；接口不扣额度。
3. /api/generate/image 的 schema 增加可选 analysis/decision 字段，写进 task.params。
4. 把分析结果写进该用户消息的 chat_messages.meta.analysis（需要给 chat 消息加 meta JSON 列，nullable）。

验收：pytest 新增 3 条用例——能确定数量、不能确定、模型超时，三条都不得抛异常。
```

### 提示词 3：确认卡片与文生图接入

```text
继续在 canvas-studio 项目工作。承接上一个任务（analyze 接口已就绪）。

目标：前端在对话流里展示分析过程，并在数量不确定时插入可点选卡片。

1. 新建 frontend/src/components/chat/ConfirmCountCard.tsx：
   - props: { reply, reason, options:[{n,label,hint}], defaultN, onChoose(n), onTimeout() }
   - 15 秒倒计时（环形或进度条），到时自动 onTimeout；
   - 选择后卡片变灰显示"已选：出 2 张"，不可再点。
2. 新建 frontend/src/components/chat/AnalysisSteps.tsx：步骤条（理解 → 整理提示词 → 决定数量），
   进行中显示脉冲圆点，完成显示勾。
3. ChatPanel.send() 在 mode==='image' 时改为：
   analyze → 若 needs_confirm 渲染 ConfirmCountCard 并 await 用户选择（Promise）→
   调 generateApi.image({ prompt: optimized_prompt, n, analysis, decision })。
4. 同一时刻只允许一个 pendingConfirm，新提交作废旧卡片。
5. 卡片与步骤必须落在时间线里（不是 modal），刷新后从 message.meta 还原。

验收：输入"做两张不同风格海报"出现确认卡；选 2 后出 2 张；不选 15 秒后按 1 张继续；
刷新页面后卡片与步骤仍在。
```

### 提示词 4：画笔选区

```text
继续在 canvas-studio 项目工作。

目标：把「画笔」从标注升级为真正的选区（产出掩码参与 inpainting）。

前端 frontend/src/components/canvas/ImageEditLayer.tsx：
1. tool 改为 'rect' | 'brush'；画笔模式下画笔迹（perfect-freehand 已有），支持橡皮。
2. 松开画笔后：计算笔迹包围盒作为 region，并在离屏 canvas 生成同尺寸 PNG
   （白色=要改，透明=保留），存入该区域的 maskBlob。
3. 多个区域时，把所有 brush 掩码与矩形掩码合并成一张 mask（白色并集）。
4. buildEditPayload 增加 brushMaskFile，提交时作为 brush_mask 字段。

后端：
1. /api/generate/edit 增加可选 UploadFile brush_mask，存成资产，params.brush_mask_url。
2. generate_service._run_edit_task **目前完全没发 mask**，需要补：
   - 有 brush_mask_url 时，把它作为 files 里的 ("mask", ("mask.png", bytes, "image/png"))；
   - 否则用已有的 _render_union_mask(base_bytes, regions) 生成矩形并集掩码；
   - 两者都没有（纯涂鸦）时保持现状（只发标注图）。

验收：只涂人物轮廓提交后，背景像素与提交前逐像素一致（写一个 pytest 断言）；
框选 + 涂抹混用时，两者都被修改。
```

### 提示词 5：多气泡调度

```text
继续在 canvas-studio 项目工作。

目标：多个选区同时存在时，气泡不重叠、不超出可视区、不打断输入。

修改 frontend/src/components/canvas/ImageEditLayer.tsx：
1. 保留 activeRegionId（同一时刻只有一个编辑态）。
2. 新增 bubbleLayout 计算：默认贴框下方 10px；下方空间不足翻到框上方；
   水平 clamp 到 [8, 容器宽-气泡宽-8]；所有可见气泡按 top 排序，重叠则下移 overlap+8，
   超出容器则改为向上堆叠。只在 regions/容器尺寸变化时重算。
3. 点气泡外部：该区域有文字→收起为 chip；无文字→保持展开。
4. chip 点击重新展开；删除区域时若为 active 则清空 active。
5. 提交时若某区域缺必填文字：聚焦该区域气泡并加 300ms 抖动动画，不弹 toast。

验收：3 个区域的气泡无重叠、不越界；连续展开/收起 20 次位置稳定；暗色下对比度正常。
```

### 提示词 6：视觉与反馈收口

```text
继续在 canvas-studio 项目工作。

目标：统一新组件的视觉与反馈，对标 Lovart 的干净质感。

1. 所有新组件（ConfirmCountCard / AnalysisSteps / SelectionToolbar）只用现有 token：
   品牌 #5B5BD6、渐变 --gradient-brand、卡片圆角 14px + border-border/60 + shadow-sheet。
2. 不允许出现纯色大色块、1px 分割线切版、常驻焦点光圈。
3. 选区绘制：拖拽时虚线预览，松开 120ms 缩放落位。
4. 提交按钮：loading 时禁用 + 转圈；分析阶段显示"正在理解需求…"。
5. 亮/暗两套下检查对比度 ≥4.5:1（气泡、卡片、次要文字）。
6. 390px 宽度下不横向溢出。

验收：截图对比亮/暗两套；跑 `npx vite build` 与 `pytest -q` 全绿。
```

---

## 9. 风险与回滚

| 风险 | 影响 | 对策 |
|---|---|---|
| analyze 增加 1 次模型调用 | 提交变慢 | 8s 超时 + 失败直通；前端先显示"正在理解" |
| 会话↔画布切换竞态 | 串场景/丢编辑 | flush→cancel→卸载→载入→remount，序号丢弃过期响应 |
| 画笔掩码尺寸与 base 不一致 | 上游报错/错位 | 生成掩码时以 base 原图尺寸为准，提交前断言尺寸相等 |
| 多气泡计算抖动 | 气泡跳动 | 只在 regions/容器尺寸变化时重算，布局写进 ref |
| 老数据 canvas_id 为空 | 切换会话白屏 | 兜底：无绑定则取项目第一块画布并回写绑定 |
| 数量确认打断节奏 | 用户烦 | 只在 confidence<0.75 时出现，且 15s 自动继续 |

**回滚**：所有新增字段 nullable、新增接口独立；前端用 feature flag `VITE_ENABLE_ANALYZE` 控制是否走分析链路，出问题可一键关掉退回"直接出图"。

---

## 10. 与现有实现的差异速查

| 需求 | 现在 | 本方案 |
|---|---|---|
| 文生图数量 | 前端传死 `n` | 先分析，再确认 |
| 分析过程 | 只有编辑的 thinking | 文生图也有步骤条 + 落库 |
| 画笔 | 涂鸦标注 | 掩码选区 |
| 多区域 | 单气泡展开，无避让 | 多气泡调度 + chip |
| 新建对话 | 复用当前画布 | 新建空画布 |
| 切换对话 | 不换画布 | 恢复对应画布 |
| 视觉 | 已统一 | 新组件沿用同一套 token |

---

> 本文档基于 2026-10-17 的代码现状编写，涉及的文件路径均已核对。落地时按第 7 节顺序执行，每阶段结束跑构建与测试。
