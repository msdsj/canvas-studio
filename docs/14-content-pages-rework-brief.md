# 内容页改造任务书（Round 2 · 前端）

> 依据：`docs/12-visual-audit-2026-10-23.md`（缺陷）+ `docs/13-design-system-v3.md`（规格）
> 范围：**除工作台/画布之外的 20 个路由**。工作台另有一轮，不要动 `components/canvas/**`、`components/studio/**`、`components/chat/**`。

---

## 0. 一条总原则

现在的问题不是「每个页面不好看」，而是「20 个页面各好看各的」。
所以顺序必须是：**先把壳统一 → 再逐页填空**。任何页面都不许再自建 header、自建 gutter、自建空状态。

---

## 1. 壳层（先做，其它页都依赖它）

### 1.1 `components/layout/PageShell.tsx` 升级
保持现有 props 向后兼容，新增：

| prop | 类型 | 说明 |
|---|---|---|
| `tabs` | `{ items: {key,label,count?}[], value, onChange }` | 页头下方的 tabs 行，带底部 2px 青柠指示条（滑动过渡，非瞬间跳变） |
| `sticky` | `boolean` | 页头吸顶（滚动时收成紧凑版：标题缩小、描述淡出、只留标题 + 操作） |
| `width` | 已有 `'default' \| 'wide' \| 'narrow'` | 三档对齐 `--shell-max*` token |
| `bottomPad` | `'default' \| 'float'` | 有浮动操作条时用 `float` |

行为要求：
- gutter 用 `--shell-gutter` / `-md` / `-lg` 三档，**不许再写 `px-6 lg:px-10`**
- 页头结构：`h1` = `text-h2` + `--shell-header-min-h`；描述 `text-ui` 最大 64ch；操作按钮右对齐且 `items-center`
- 吸顶时用 `--shadow-sticky`，不画分割线
- 底部内边距用 `--shell-bottom-pad`，有浮条用 `--shell-bottom-pad-float`
- 滚动容器必须 `overflow-y-auto` + `overscroll-contain`，并给 `scrollbar-gutter: stable`

### 1.2 `components/layout/TopBar.tsx`
**当前问题**：全站导航被塞进左上角一个 15px 的九宫格图标下拉里；用户看不见自己在哪，也看不见还能去哪。

改成：
- 桌面（≥1280）：品牌 + 一条**可见的水平主导航**（工作台 / 项目 / 素材 / 任务 | 用量 / 设置），当前项加青柠下划线（2px，`layoutId` 式滑动可选，简单起见用 `transition-[color]` + 下划线 `scaleX` 过渡）
- ＜1280：导航收进下拉，但把触发图标从 15px 放大到 18px，并加 `aria-expanded`
- 右侧保留 额度 / 通知 / 头像
- 把硬编码的「我的工作室」换成 `t('nav.studio', { defaultValue: '我的工作室' })` 并补 en 翻译
- 顶栏高度保持 44px；`mx-2.5 mt-2.5` 保留（这是浮条语言）

### 1.3 `components/layout/AdminShell.tsx`
现在是「侧栏 + 一条写着 Admin 的 56px 顶栏 + 自己算的 max-w」。改成：
- 内部直接复用 `<PageShell>`（传 title/description/actions），删掉重复的 header 代码
- 顶部条换成：`← 返回工作室` + 面包屑（Admin / 当前页）+ 额度 + 头像
- 侧栏激活态对比度提到 ≥4.5:1（现在米色药丸上放深字只有 ~1.5:1）：激活用 `bg-accent-soft text-accent-ink` 或 `bg-surface` + 左侧 2px 青柠条 + `text-text font-medium`
- 侧栏宽度、圆角、间距与 `AppSidebar` 完全一致（两套侧栏必须同源）

### 1.4 `components/ui/empty-state.tsx`
- 图形容器 `--empty-glyph`，内嵌 28px lucide 图标，底色 `bg-bg-subtle` + `ring-1 ring-border-faint`，**不要**大灰圆
- 加可选 `hints?: string[]`（三条以内的「这里能做什么」）
- 加可选 `secondaryAction`
- 容器 `min-h: --empty-min-h`，垂直居中但不贴顶

### 1.5 新增 `components/ui/data-table-card.tsx`
统一表格外框：`rounded-[--table-radius] border border-border/70 bg-surface shadow-sheet`，
`<thead>` 用 `--table-th-h` + 无背景（只一道下边框），行高 `--table-row-h`，行 hover `bg-surface-hover/60`，
分页条 sticky 底部 + `--shadow-table-foot`，左侧显示「共 N 条」。

---

## 2. 逐页改造

### 2.1 `/projects`（My Projects）
1. **封面**：后端已补 `thumbnail_url`，`ProjectCard` 直接用；为空时不要放灰色网格图标，改为
   `ArtSwatch`（首页那套抽象图，`components/home/ArtSwatch.tsx`）按项目 id 取哈希调色板 —— 每个空项目都是一张不同的「纸卡」，不是一排灰块
2. **网格**：`grid-cols-1 sm:2 lg:3 2xl:4`，卡宽随之自适应；封面比例 `aspect-[4/3]`
3. **卡片信息**：名称 1 行截断、更新时间 12px、右下角显示 `item_count` 张（后端已补）
4. **有项目时也保留「新建」幽灵卡**：虚线边框 + 居中的加号 + 一行说明，放在网格第一位
5. **分页**：`total > size` 才出现，并贴内容底部
6. 空状态用新 EmptyState + `hints`（"从一句话开始" / "把素材拖进画布" / "团队成员可共享"）

### 2.2 `/assets`
1. **比例失真**：现在是 5 列固定 + 全部 `object-cover` 切方，351×1238 的竖图被裁掉大半。
   改成**按真实宽高比排版的瀑布流**（CSS `columns` 或 JS 分列都可，二选一），列数 `2 / 3 / 4 / 5` 响应式
2. 卡片底部元信息重排：左「1254×1254」+ 中间来源徽标（生成/上传），右 3 个操作图标**统一 16px、gap 12px、垂直居中**
3. 筛选条：All/Generated/Uploaded 从三个小胶囊改为页面 tabs（走 PageShell `tabs`），
   与「Upload image」主按钮同一基线
4. `routes/assets.tsx:113` 硬编码的 `全部/我的/团队共享` 改成 i18n
5. hover：图片 `scale(1.02)` + 卡片抬升，**不要**缩放导致布局抖动

### 2.3 `/tasks`
**当前问题**：页面叫「Generation history」，但只渲染 `ActiveTasksPanel`（只有进行中任务）。
用户历史里有几十条生成记录，打开这页却是「No active tasks」——功能与标题不符。

1. 新建 `components/tasks/TaskHistory.tsx`（**不要改 `components/chat/ActiveTasksPanel.tsx`**，那边有另一轮在改）
2. 数据用现成接口：`generateApi.listTasks({ page, size, status })`（`lib/api/generate.ts` 已有）
3. tabs：全部 / 进行中 / 已完成 / 失败，带数量；「进行中」保留原有停止按钮能力
4. 行卡片：56×56 缩略图（失败显示破图占位）+ 提示词 2 行 + 状态徽标 + 相对时间 + 右侧操作（查看 / 停止 / 重试）
5. 空状态补 `hints`（"在对话里描述需求，就会出现在这里" / "失败的生成会自动退回额度"）
6. 分页吸底

### 2.4 `/skills`
**当前最严重：底部卡片被裁、浮条遮住开关。**
1. 改用 PageShell（`width="default"` + `bottomPad="float"`），删掉自建 `max-w-5xl p-6`
2. **排版放大**：卡片 `--card-pad`（20px），标题 `text-ui font-semibold`，描述 `text-caption`（13px）行高 1.6，`line-clamp-2` 改 3 行
3. **开关前置**：每张卡右上角放真实 `<Switch>`（现在只有 10px 的 "Off" 文字，根本点不到）；
   整卡可点 = 切换，Switch 只做状态指示 + 键盘可达
4. 底部浮条：从 `sticky bottom-0` 改为 `fixed` 底部悬浮胶囊（居中，`bottom: 16px`），
   并给滚动容器加 `--shell-bottom-pad-float`，保证任何一行都不会被盖住
5. 浮条内容：左「已选 8 / 13」，右「保存」+「重置」；未变更时整条淡出（`translateY(8px)` + `opacity 0`），变更时滑入

### 2.5 `/usage`（重点：信息缺失）
1. **顶部 4 张 StatCard**：当前余额 / 累计获得 / 累计消耗 / 今日消耗。
   数据来自新接口 `GET /api/quota/summary`（`balance / total_granted / total_consumed / series / by_type`）
2. **消耗趋势图**（新增，手写 SVG，禁止引三方图表库）：
   - 近 14 天柱状或折线，用 `--chart-1`，网格 `--chart-grid`
   - 顶部可切换 7 / 14 / 30 天
   - hover 显示 tooltip（日期 + 消耗 + 笔数）
   - 数据为空时显示「这段时间还没有消耗」的空态，不要画一条 0 线
3. **价格区**：修掉右侧贴边溢出（现在 4 个块顶到卡片右边缘），改 2×2 / 4 列自适应 + 每格内边距 12px
4. **流水表**：用新的 `DataTableCard`；类型列用 Badge；`balance_after` 显示该笔之后余额；时间走 `useFormatters().dateTime`（现在 en-US 格式与中文界面不一致）
5. 顶部加类型筛选（全部 / 生成 / 编辑 / 对话 / 充值 / 调整）

### 2.6 `/settings`
1. 改成 **左侧分区导航 + 右侧内容**（1280 以上两栏，以下单栏 + 顶部 Select）：
   账户资料 / 安全 / AI 中转站 / 偏好 / 会话
2. 每个分区用 Card 包裹，Card 内：`h2` + 一句说明 + 表单字段（`FormField` 保留）
3. 「AI 中转站」不再只在弹窗里：分区里显示当前配置摘要（模型、网关、状态点）+「管理」按钮打开现有 `AIConfigDialog`
4. 危险区（退出全部设备）单独一张卡，红边框 `border-danger/30`，按钮 `variant="danger"` ghost
5. 保存按钮跟随分区卡片右下，sticky 于卡片底部

### 2.7 `/team`
1. 删掉自建白色通栏 header，改用 PageShell
2. 空状态升级：图形 + 标题 + 说明 + 三条 `hints`（共享技能包 / 共享额度 / 审计日志）+ 主行动「创建团队」+ 次行动「了解团队能力」（滚动到说明区）
3. 有团队时：顶部团队卡（名称、角色、成员数、额度）+ 下方成员预览 3 人 + 「管理成员」

### 2.8 `/admin`（Overview）
1. **删掉重复的 Pool normal**（现在第一行第 4 张 + 第二行第 2 张各一次）
2. 结构改为：
   - 第一行 4 张 KPI：总用户 / 活跃用户 / 今日消耗 / 号池可用（可用/总数 + 健康点）
   - 第二行左（2/3 宽）：**近 14 天趋势图**（新增用户 + 生成量双序列，手写 SVG，`--chart-1/2`）
   - 第二行右（1/3 宽）：**待处理**列表（待验证用户 / 号池异常 / 号池限流），每条可点击跳到对应页
   - 第三行：**最近动态**（`overview.recent`，最多 6 条，时间 + 类型图标 + 文本）	3. KPI 卡：数字用 `tabular-nums`，副行显示「较昨日 +12%」这类对比（有数据才显示，没数据不显示假数据）

### 2.9 `/admin/users`
1. 表格换 `DataTableCard`，分页吸底（现在 13 行后看不见分页）
2. 角色列用 Badge（admin = 青柠，pro = 墨，user = 灰）
3. 操作列：4 个图标改 16px + gap 8px，外扩 8px 内边距，hover 才显示（默认 40% 透明）以降低噪声
4. 工具栏：搜索框 240px + 角色/状态 Select + 右侧「新建用户」，同一行同一基线
5. 邮箱列可点击复制

### 2.10 `/`（首页，只做两处）
1. **演示区不要长时间空着**：`StoryDemos` 的循环里结果图被隐藏约 2 秒（每轮约 4.5 秒），
   改成「结果常驻、只在新一轮开始时快速淡出 0.2s」，让右侧面板永远有内容
2. 章节竖向节奏收紧：`--gap-section` 从 80 → 64（移动 48），减少 9000px 长页的疲劳感

---

## 3. 硬约束
- 禁止 emoji；图标只用 `lucide-react`，16/20/24 三档
- 禁止硬编码颜色（`#fff`/`#000` 除外）与硬编码间距（用 `--gap-*` / `--shell-*`）
- 动画只用 `transform` / `opacity`；禁止 `transition: all`
- 单文件 ≤300 行，超了拆子组件
- 所有新增文案必须同时补 `zh-CN` 与 `en` 两个 json
- 亮/暗双主题都要过一遍，暗色不能只靠"颜色变深"糊过去

## 4. 自检
```bash
cd frontend && npx tsc --noEmit          # 0 error
node scripts/visual-audit.mjs --theme both --mobile --out /tmp/cs-audit-after
```
`report.json` 里不允许有 `errorCount > 0` 或 `overflow > 0`；`textLength` 与改造前对比应上升（信息密度变高），首页除外。
