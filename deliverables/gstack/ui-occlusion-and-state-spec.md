# 界面遮挡与状态视觉规范 · canvas-studio

> 一页约束表。全部落到现有 token 名与 Tailwind 类，可直接抄。不含过程性推导。
> 基线：`src/styles/tokens.css`；状态可达性以产品裁定为准（paused 本期不可达）。

---

## 0. z 轴分层（唯一真值）

| 层 | z-index | 用途 |
|---|---|---|
| 画布元素占位 | `z-10` | 生成中骨架，跟随元素 bbox |
| 编辑层控件 | `z-20` | 编辑工具条 / 编辑气泡 |
| 编辑层根 | `z-30` | `pointer-events-none absolute inset-0` |
| Radix 浮层 | `z-50` | dropdown / popover / tooltip / select |
| 模态 · 抽屉 | `z-[1100]` | 必须高于 Excalidraw `--zIndex-modal:1000` |
| toast | 999999999 | sonner 默认，不改 |

---

## 1. 遮挡冲突清单

| # | 元素 | 现状 | 挡住谁 | 证据 | 修法 |
|---|---|---|---|---|---|
| C1 | CanvasToolbar | `absolute bottom-3 left-3`，z-auto | Excalidraw 原生缩放岛（`bottom:1rem;left:1rem`，`--zIndex-layerUI:4`）→ 自建 3 个按钮被压且点不到 | `canvas/CanvasToolbar.tsx:39` | 删自建缩放组；只留「加图/删除」并移入 CanvasHeader |
| C2 | CanvasMinimap | `absolute bottom-3 right-3` | 原生底部右岛（撤销/重做/帮助） | `canvas/CanvasMinimap.tsx:12` | 改 `bottom-3 left-1/2 -translate-x-1/2`（原生底带中间为空）或删 |
| C3 | 编辑层工具条 | `absolute top-[88px] z-20` + flex-wrap | 图在顶部时压图上沿；卡宽 <560 折 2 行占 ~110px，侵入画布中心 | `canvas/ImageEditLayer.tsx:762` | `top-[88px]` → `top-14 mt-2`（Excalidraw 顶带 = 12 + 44 = 56）；<1280 折叠为纯图标 |
| C4 | 编辑气泡 | `top = imgRect.y+h+12`，无钳制 | 被 `.cs-canvas-card` 的 `overflow-hidden` 裁掉「生成」按钮 | `ImageEditLayer.tsx:665-674,853-855`；`WorkspaceView.tsx:884` | `top = clamp(128, y+h+12, cardH-composerH-12)`，空间不足翻到图上方 |
| C5 | toast | `fixed` top:32 right:32 **w:360** | TopBar 右簇（y32–56）、CanvasHeader 分享/导出（y56–104）、Excalidraw 右上 library；3 条堆叠到 y≈250 | `ui/toast.tsx:8-16` | `position="top-left"` + `offset={{top:112,left:68}}` + `visibleToasts={2}`，宽 300 |
| C6 | Dialog | `fixed inset-0 z-50` / `fixed top-1/2 z-50` | 画布中心；z-50 < Excalidraw 内部 1000，同场必输 | `ui/dialog.tsx:17,43` | z → `z-[1100]`；QuotaInsufficientModal 改 `top-[18%]` |
| C7 | Dialog 无 max-height | 内容自适应 | 移动端溢出裁切 | `ui/dialog.tsx:43` | `max-h-[min(720px,calc(100dvh-96px))] overflow-y-auto`；移动 `calc(100dvh-32px)`，footer `sticky bottom-0 bg-surface-raised` |
| C8 | 浮层同层 | dropdown/popover/tooltip/select/dialog 全 `z-50` | 弹窗内下拉与弹窗抢层 | 5 个 ui 文件 | 按第 0 节分层 |

---

## 2. 零浮层区（铁律，1512×900 / dock 折叠）

| # | 区域 | 坐标 | 禁止 |
|---|---|---|---|
| ① | TopBar 交互带 | y∈[0,56]，x∈[W-260,W] | toast / 抽屉 / 任何 fixed |
| ② | CanvasHeader 右控件 | y∈[56,104]，x∈[W-200,W] | 同上 |
| ③ | 画布卡顶带 / 底带 | 卡内 y∈[0,56] 与 y∈[H-56,H] | 自有浮层（Excalidraw 岛专属） |
| ④ | 对话列输入区 | 列内 y∈[H-200,H]（输入块实测 ~140，展开 200） | toast / 抽屉 |
| ⑤ | dock 整列缩略图 | x∈[616,812]（1512 展开态） | 任何浮层 |
| ⑥ | 画布卡中心 | 居中 60% × 60% | **任何遮罩**；只允许元素级占位 |

浮层允许位置与上限：

| 类型 | 允许区域 | 最大宽高 | 可关闭 | 自动消失 |
|---|---|---|---|---|
| toast | 对话列内 left 68 / top 112；≤768 改 top-center | 300 × 2 条 | 是 | success 3s / info 4s / error 6s |
| 模态 | 居中偏上 `top-[18%]` | `min(800,100vw-32)` × `min(720,100dvh-96)` | Esc/遮罩/× | 否 |
| 抽屉 | 贴边 `inset-y-0` | 400 × 100dvh（≤768：92vw） | 是 | 否 |
| 悬浮工具条 | 仅画布卡内，y≥64 | 高 40 单行，折行上限 2 行 | 否 | 否 |
| 元素级 loading | 元素 bbox | = 元素尺寸 | 否 | 任务结束 |
| 全屏 loading | **工作台内禁用** | — | — | — |

---

## 3. 六态矩阵（+ paused 兼容态）

| 状态 | 容器底 | 色 | 图标 | 动效 | 文案位置 | 可点击 |
|---|---|---|---|---|---|---|
| pending 提交中 | — | `text-text-tertiary` | Loader2 | `animate-spin` | 发送按钮内「提交中…」 | 全禁（`aria-busy`；输入框 `readOnly` 保焦点） |
| queued | `bg-bg-subtle` | `text-text-secondary` | Clock | 不确定态细条 | Badge「排队中」 | 仅「放弃」ghost |
| running | `bg-brand-subtle` | `text-brand-text` | Loader2 | 骨架 `animate-pulse` + 计时器 | Badge「生成中」+ 骨架下「生成中 · 12s · 通常 30–90 秒」 | **仅**「停止生成」（destructive ghost） |
| failed | `bg-danger-subtle` | `text-danger` | CircleAlert | 无 | 骨架同位（不塌） | 「重新生成」primary |
| timeout | `bg-danger-subtle` | `text-danger` | TimerOff | 无 | 同上 | 「重新生成」primary |
| cancelled | `bg-bg-subtle` + `opacity-70` | `text-text-tertiary` | CircleStop | **无** | Badge「已停止 · 额度已退回」 | 「重新生成」secondary |
| succeeded（未放） | `bg-success-subtle` | `text-success` | Check | 缩略图 300ms 入场 | Badge「已完成」 | 缩略图=看大图；「放入画布」primary +「再画一张」secondary |
| succeeded（已放） | 同上 | `text-text-secondary` | Check | 无 | Badge「已放入」 | `opacity-60 pointer-events-none`，位置尺寸不变 |
| paused（兼容态，不可达） | `bg-warning-subtle/60` + `opacity-70` | `text-warning` | CircleStop | **无旋转** | Badge「已停止 · 额度退回中」 | **无「继续」**，必须给「重新生成」 |

**硬规则**
1. `queued` 与 `cancelled` 必须三处可区分：图标（Clock / CircleStop）、明度（`opacity-100` / `opacity-70`）、动效（细条在动 / 完全静止）。
2. running 只允许**一个**破坏性按钮「停止生成」（直连 cancel，`task_service.py:232-245` 确认退款且幂等），不得同时出现「暂停」与「放弃」。二次确认文案：**「停止后本次不扣额度，已画出的画面不会保留」**。终态隐藏按钮，in-flight 禁用（`_check_transition` 会拦非法迁移）。
3. 停止后卡片态：Badge「已停止 · 额度已退回」+ 主按钮「重新生成」；额度退回用 `Badge variant="success"` + `RotateCcw 12` 可视化。
4. **进度条全站下线**：后端 `progress` 只有 0/30/100（`generate_service.py:203`），30% 会冻结最长 330s。结果卡内不得出现任何百分比数字与进度条元素，改「同尺寸骨架 + 计时器」；任务中心列表行才用 `h-1.5 animate-[cs-indeterminate_1.6s_var(--ease-in-out)_infinite]`，`prefers-reduced-motion` 降级为静态 30% 填充（不能停成 0）。
5. **失败卡结构 = 一句人话 + 一个动作**，禁止状态码入句。`GenerationResultCard.tsx:81` 的 `· ${error_code}` 整段删除。
6. **「重新生成 / 再画一张」是真发请求**，点击后按钮进 loading，新任务卡**原地**替换旧卡（不跳列表底部）。现状 `ChatPanel.tsx:169-175` 只 `setInput()`，文案叫「重试」是误导。
7. **等待文案按 5.5 分钟上限设计**（超时阈值 180s → 330s）。running 文案必须带预期管理「通常 30–90 秒」；超过 90s 追加 `text-caption text-text-tertiary`「还在画，可以先去别处看看」，超过 180s 追加「比平时久，可以继续等或停止生成」。**不得**用进度百分比或「马上就好」这类无法兑现的措辞。
8. **投放权归用户**：任务卡缩略图点击 = 看大图（不投放），投放只能由独立按钮或 dock 缩略图触发。dock 已投放的那一张置灰 `opacity-60` + 文案「已放入」+ `pointer-events-none`，位置尺寸不变；未投放的仍可点，点击投放**单张**。
9. **paused 历史数据禁止渲染成无按钮死卡**：一律「已停止 · 额度退回中」+「重新生成」。

---

## 4. 文案（取安全审计 B 表，只允许 `errors.json` 的 14 个 key）

**取用方式（根因，先于文案本身）**：`i18n/index.ts:68` 是 `defaultNS: 'common'`，`nsSeparator` 默认 `:`，而 `ERROR_I18N_KEY` 的值形如 `errors.internal_error` → 被解析为 **common 命名空间下的嵌套路径**，common.json 无 `errors` 节点 → **100% miss**。全库 0 处 `useTranslation('errors')`，所以 14 条文案从未生效过一次，屏幕上是后端 `envelope.message` 原文。
- 唯一允许的取用：`useTranslation('errors')`，或 `t(key, { ns: 'errors' })`。
- `errorMessage()` 兜底：`return t('errors.unknown', { ns: 'errors' })`。
- **任何情况下不允许 `error.message` 上屏**（后端 message 含「任务当前状态为 running，不允许变更为 paused」这类内部语）。
- 探针：把语言切到 en，错误文案必须随之变化；不变即说明仍在走 `defaultValue`。

| 场景 | 用户可见文案 | 动作 |
|---|---|---|
| failed / UPSTREAM_ERROR | 图片没生成出来，额度已经退回给你 | 重新生成 |
| timeout | 这次等得有点久，已经帮你停下了 | 重新生成；把描述写短一点 |
| 额度不足 | 这次需要的额度不够了 | 查看用量 |
| 并发上限 | 同时生成的数量有点多 | 等完成或先放弃一张 |
| 网络层 | 网络好像断了 | 确认联网后重试 |
| 未映射兜底 | 出了点小状况 | 重试一次；还不行请联系客服 |

约束：不出现「上游 / 中转 / 网关 / 号池 / 接口 / 状态码 / 超时 / 服务器 / 代理 / VPN」，不上屏 `error_code`、HTTP 码、后端 message。`chat.json:119` 的「演示模式：上游不可达」→「示例图（试运行）」。`__root.tsx:10` 的 `description={error.message}` → 固定插画 + 固定文案「出了点小状况」+ 重试按钮；**本版不显示错误 ID**（前端自造 ID 客服 grep 不到，等于假承诺；待后端在 `main.py` 异常出口生成并落 logger 后再上屏）。禁止用 `task_id` / `user_id` 片段派生 ID。

---

## 5. 消息区与栅格

- **生图 prompt 必须进消息流**：任何提交先插 optimistic 用户气泡，任务卡挂其下 8px、`ml-9` 对齐 AI 左沿；卡片不再用 40 字截断标题。
- 用户气泡：右对齐、`max-w-[85%]`、`bg-brand-subtle`、`rounded-lg rounded-tr-[6px] px-3 py-2 text-body`；上方 `text-micro text-text-tertiary`「你」，下方右侧时间戳 `text-micro text-text-faint mt-1`。
- AI 消息：左对齐、Avatar 28 `mt-1`、无气泡、`max-w-[68ch]`；整块 `group`，hover/focus-within 出复制按钮 `opacity-0 group-hover:opacity-100 transition-opacity duration-150`。
- 长 prompt：`line-clamp-3 whitespace-pre-wrap break-words` +「展开」`text-caption text-brand-text`。
- 空态（替换 `ChatPanel.tsx:248-250` 的 placeholder 复用）：`Sparkles 40 text-text-faint` + `text-h3`「描述你想要的画面」+ `text-caption` 副行 + 3 个示例 chip。
- 输入框：`maxLength={4000}`，>3600 出 `text-caption` 计数，超限 `text-danger` + 禁发。

| 张数 | 布局 |
|---|---|
| 1 | 单列 `aspect-square max-w-[320px]` |
| 2 | `grid-cols-2 gap-2` |
| 3 | 首图 `col-span-2 aspect-[16/10]` + 后两张两列 |
| 4 | `grid-cols-2` |
| 5–9 | `grid-cols-3`，第 9 张盖 `+N` 遮罩 `bg-[rgba(32,26,18,0.5)]` |

缩略图统一相纸：`rounded-[3px] bg-mat p-[3px] shadow-sheet`。5–9 张三列同样适用于任务卡内（一次产出「1 张完整图 + N 张透明素材」时第 1 张与其余统一 `aspect-square`，不混比例）。

### 5.1 发现性（自动投放移除后的必要配套，非可选）

自动投放**整段砍掉**（不是加守卫——加守卫只防重复，防不了「图自己跑进画布」违背承诺）。替代方案必须同时给到：

| 通道 | 规格 |
|---|---|
| 成功 toast | 每次任务成功出一次：「生成完成，N 张已放入右侧结果区」，`success` 3s，落在对话列（left 68 / top 112） |
| dock 折叠态角标 | 未投放数量 `rounded-full bg-brand px-1.5 py-0.5 text-micro text-text-inverse`，>99 显示 `99+` |
| dock 展开态 | 未投放缩略图正常亮度；已投放 `opacity-60` + 「已放入」+ `pointer-events-none` |

**禁止**恢复顶部「N 个新的生成结果」横幅。`UnreadResultsBanner` 组件存在但工作台未挂载是故意的——上一轮用户明确要求移除，理由是常驻遮挡。任何以「提升发现性」为名的顶部横幅方案一律驳回。

---

## 6. 加载与图片

- 画布占位已是元素级（`WorkspaceView.tsx:911-921`，`border-dashed bg-surface-hover/70 animate-pulse`），保留；**禁加 backdrop-blur / bg-overlay**。
- 结果卡 running 即渲染与结果同尺寸的 `aspect-square rounded-[3px] animate-pulse` 骨架，避免 running→succeeded 高度跳变。
- 渐进加载：容器 `bg-mat`，`img` 带尺寸约束，初始 `opacity-0 blur-[6px] scale-[1.03]` → `onLoad` `opacity-100 blur-0 scale-100`，`transition-[opacity,filter,transform] duration-300 ease-[var(--ease-out)]`，`loading="lazy" decoding="async"`。
- **失败占位（三处：dock / 结果卡 / 画布元素）**：容器保比例不塌，居中 `ImageOff 20 text-text-faint` + `text-caption text-text-tertiary`「图片加载失败」+ `text-caption text-brand-text`「重试」，重试加 cache-bust。全前端当前 0 处 `onError`。

---

## 7. 断点（画布列 / 卡宽）

| 断点 | 左栏 | 对话列 | 素材 | dock | 1512→ 卡宽 | toast |
|---|---|---|---|---|---|---|
| ≥1536 | 56 | 320 | 240 | 196 | 700 / 684 | 300 top-left |
| 1280–1535 | 56 | 320 | 240 | **40（默认折叠）** | 784 / 768 | 300 |
| 1024–1279 | 56 | 320 | 隐藏 | 40 | 624 / 608 | 280 |
| 768–1023 | 56 | 320 → 抽屉 | 隐藏 | 隐藏 | ≥696 | 280 top-center |
| <768 | 隐藏 | 分段单栏 | 隐藏 | 隐藏 | 100vw-16 | `calc(100vw-24px)` max 360 |

规则：卡宽 <560 自动收 dock（Excalidraw 顶条会折行）；<480 隐藏素材列；<400 对话列改抽屉。1280 展开 dock 时卡仅 452 → dock 必须默认折叠。

dock 保持 196px **交互**缩略图（点击投放单张，已投放置灰不可点），因此 1512 画布列维持 856、本表不因「砍自动投放」而调整。

---

## 8. 按钮五态

| 态 | primary | secondary | ghost | danger |
|---|---|---|---|---|
| hover | `bg-brand-hover` | `bg-surface-hover` | `bg-surface-hover text-text` | `brightness-95` |
| active | `bg-brand-active` | `bg-surface-hover shadow-none` | `bg-surface-hover` | `brightness-90` |
| focus-visible | `ring-2 ring-[var(--color-focus-ring)] ring-offset-2 ring-offset-bg` | 同 | 同 | 同 |
| disabled | `opacity-40 saturate-50 pointer-events-none`（现 `opacity-50` 在 brand 底上与 hover 不可区分） | 同 | 同 | 同 |
| loading | 保留底色 + 内联 spinner + 文案，禁 hover 变化 | 同 | 同 | 同 |

触屏：`@media (pointer:coarse)` 下全部 `min-h-11 min-w-11`（44px）。现 `size=sm` 32px、ModeChip 26px、编辑层色板 20px、ToolButton 22px 均不达标。
