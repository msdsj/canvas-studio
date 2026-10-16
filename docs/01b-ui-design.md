# canvas-studio 视觉设计规范（UI Design Spec）

> 版本：v1.0 · 2026-10-16 · 产品经理：许清楚
> 配套：`docs/01-prd.md` · 设计稿：`docs/design/*.html`
> 目标：**专业克制的 SaaS 审美**（参考 Linear / Vercel / Notion），杜绝霓虹渐变与过度 AI 化装饰。

---

## 1. 设计原则

| # | 原则 | 说明 |
|---|------|------|
| D-01 | **内容优先** | UI 是画布与作品的画框，不是主角。留白、低饱和、弱装饰，把视觉焦点让给用户创作内容。 |
| D-02 | **克制而专业** | 中性灰阶打底，品牌色只在"可操作/选中/聚焦"处点睛；不使用大面积渐变、发光、玻璃拟态。 |
| D-03 | **反馈即时** | 每个操作都有状态（hover/loading/成功/失败）；生图等长任务必须有进度，不允许"点了没反应"。 |
| D-04 | **一致可预期** | 同一语义在双主题、双语言、全端下表现一致；组件行为可被用户预测。 |
| D-05 | **暗色等同优先** | 暗黑模式是同级一等公民，非亮色反相；双主题分别调校对比度与层级。 |

---

## 2. 色彩体系

### 2.1 品牌色（个性主色）

选择 **Teal（深青绿）** 作为品牌主色 —— 冷峻、专业、有科技感但远离"烂大街紫渐变"，在暗色下依然清晰。辅以低饱和的中性灰阶，形成克制的高级感。

### 2.2 亮色主题（Light）

| 语义 Token | 值 | 用途 |
|-----------|-----|------|
| `--color-bg` | `#FFFFFF` | 页面最底背景 |
| `--color-bg-subtle` | `#F7F8FA` | 分区背景、画布底 |
| `--color-surface` | `#FFFFFF` | 卡片/面板表面 |
| `--color-surface-raised` | `#FFFFFF`（+shadow） | 浮层/弹窗表面 |
| `--color-surface-hover` | `#F2F4F7` | 可交互项 hover |
| `--color-border` | `#E4E7EC` | 常规边框/分隔线 |
| `--color-border-strong` | `#D0D5DD` | 强调边框/输入框 |
| `--color-text` | `#101828` | 主文本 |
| `--color-text-secondary` | `#475467` | 次要文本 |
| `--color-text-tertiary` | `#98A2B3` | 辅助/占位文本 |
| `--color-text-inverse` | `#FFFFFF` | 反色文本（深底上） |
| `--color-brand` | `#0D9488` | 品牌主色（按钮/选中/链接） |
| `--color-brand-hover` | `#0F766E` | 品牌 hover |
| `--color-brand-active` | `#115E59` | 品牌 active |
| `--color-brand-subtle` | `#E6F4F2` | 品牌浅底（选中背景/标签） |
| `--color-brand-text` | `#0F766E` | 品牌色文本（浅底上） |
| `--color-success` | `#16A34A` | 成功 |
| `--color-success-subtle` | `#E7F6EC` | 成功浅底 |
| `--color-warning` | `#D97706` | 警告/额度预警 |
| `--color-warning-subtle` | `#FEF3E2` | 警告浅底 |
| `--color-danger` | `#DC2626` | 危险/错误/删除 |
| `--color-danger-subtle` | `#FDECEC` | 危险浅底 |
| `--color-info` | `#2563EB` | 信息/提示 |
| `--color-focus-ring` | `#14B8A6` | 聚焦描边（2px） |

### 2.3 暗色主题（Dark）

| 语义 Token | 值 | 用途 |
|-----------|-----|------|
| `--color-bg` | `#0B0D10` | 页面最底背景 |
| `--color-bg-subtle` | `#111418` | 分区背景、画布底 |
| `--color-surface` | `#16191E` | 卡片/面板表面 |
| `--color-surface-raised` | `#1C2026` | 浮层/弹窗表面 |
| `--color-surface-hover` | `#22262D` | 可交互项 hover |
| `--color-border` | `#262B33` | 常规边框/分隔线 |
| `--color-border-strong` | `#343A44` | 强调边框/输入框 |
| `--color-text` | `#ECEDEF` | 主文本 |
| `--color-text-secondary` | `#A6ADB8` | 次要文本 |
| `--color-text-tertiary` | `#6C7480` | 辅助/占位文本 |
| `--color-text-inverse` | `#0B0D10` | 反色文本 |
| `--color-brand` | `#2DD4BF` | 品牌主色（暗色下提亮） |
| `--color-brand-hover` | `#5EEAD4` | 品牌 hover |
| `--color-brand-active` | `#99F6E4` | 品牌 active |
| `--color-brand-subtle` | `#123A38` | 品牌浅底 |
| `--color-brand-text` | `#5EEAD4` | 品牌色文本 |
| `--color-success` | `#34D399` | 成功 |
| `--color-success-subtle` | `#12291F` | 成功浅底 |
| `--color-warning` | `#FBBF24` | 警告/额度预警 |
| `--color-warning-subtle` | `#2E2410` | 警告浅底 |
| `--color-danger` | `#F87171` | 危险/错误/删除 |
| `--color-danger-subtle` | `#2E1618` | 危险浅底 |
| `--color-info` | `#60A5FA` | 信息/提示 |
| `--color-focus-ring` | `#2DD4BF` | 聚焦描边（2px） |

> 实现约定：所有颜色通过 `:root` 与 `[data-theme="dark"]` 两组 CSS 变量切换；组件只用语义 token，禁止硬编码色值。

### 2.4 号池状态色

| 状态 | 亮色 | 暗色 | 语义 token |
|------|------|------|-----------|
| 正常 normal | `#16A34A` | `#34D399` | success |
| 限流 limited | `#D97706` | `#FBBF24` | warning |
| 异常 abnormal | `#DC2626` | `#F87171` | danger |
| 禁用 disabled | `#98A2B3` | `#6C7480` | text-tertiary |

---

## 3. 字体排版

### 3.1 字体栈

```
--font-sans: "Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont,
             "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif;
--font-mono: "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, monospace;
```

- 正文与 UI 统一用 `--font-sans`；代码/Key/Token/数值用 `--font-mono`。

### 3.2 字号阶梯

| Token | 字号 / 行高 | 用途 |
|-------|-----------|------|
| `--text-xs` | 12 / 16 | 角标、辅助说明 |
| `--text-sm` | 13 / 20 | 表格、次要信息 |
| `--text-base` | 14 / 22 | 正文默认 |
| `--text-md` | 16 / 24 | 强调正文、对话内容 |
| `--text-lg` | 18 / 28 | 小标题 |
| `--text-xl` | 22 / 30 | 页面标题 |
| `--text-2xl` | 28 / 36 | 大标题/数字指标 |

### 3.3 字重

`--fw-regular: 400`（正文） · `--fw-medium: 500`（按钮/标签/表头） · `--fw-semibold: 600`（标题/强调） · `--fw-bold: 700`（仅大数字指标）

### 3.4 行高与字距

- 正文行高 1.5–1.6；标题行高 1.25–1.35。
- 中文不使用负字距；英文大标题可用 `-0.01em` 微调。

---

## 4. 间距与圆角

### 4.1 间距（4px 基数）

| Token | 值 | | Token | 值 |
|-------|-----|-|-------|-----|
| `--space-1` | 4px | | `--space-6` | 24px |
| `--space-2` | 8px | | `--space-8` | 32px |
| `--space-3` | 12px | | `--space-10` | 40px |
| `--space-4` | 16px | | `--space-12` | 48px |
| `--space-5` | 20px | | `--space-16` | 64px |

### 4.2 圆角

| Token | 值 | 用途 |
|-------|-----|------|
| `--radius-sm` | 6px | 标签、徽章、小按钮 |
| `--radius-md` | 8px | 按钮、输入框、卡片 |
| `--radius-lg` | 12px | 面板、浮层 |
| `--radius-xl` | 16px | 大卡片、模态 |
| `--radius-full` | 9999px | 头像、药丸标签 |

### 4.3 阴影与层级

| Token | 值（亮色） | 用途 |
|-------|-----------|------|
| `--shadow-xs` | `0 1px 2px rgba(16,24,40,.05)` | 输入框/小卡片 |
| `--shadow-sm` | `0 1px 3px rgba(16,24,40,.1),0 1px 2px rgba(16,24,40,.06)` | 卡片 |
| `--shadow-md` | `0 4px 12px rgba(16,24,40,.10)` | 下拉/浮层 |
| `--shadow-lg` | `0 12px 32px rgba(16,24,40,.14)` | 模态 |

> 暗色主题阴影改为更深的黑色 + 叠加边框 `--color-border` 来区分层级。

---

## 5. 组件规范

### 5.1 按钮 Button

- **尺寸**：sm（h 32 / px 12 / text-sm）、md（h 36 / px 16 / text-base）、lg（h 44 / px 20 / text-md）。
- **类型**：

| 类型 | 亮色表现 | 状态枚举 |
|------|---------|---------|
| 主按钮 Primary | 底 `--color-brand`，字 `--color-text-inverse` | default / hover(`brand-hover`) / active(`brand-active`) / focus(2px ring) / disabled(opacity .5, 禁点) / loading(左侧 spinner，文字保留) |
| 次按钮 Secondary | 底 `--color-surface`，边框 `--color-border-strong`，字 `--color-text` | 同上，hover 底 `surface-hover` |
| 幽灵 Ghost | 透明底，hover 底 `surface-hover`，字 `--color-text-secondary` | default / hover / active / disabled |
| 危险 Danger | 底 `--color-danger`，字白 | default / hover(加深) / disabled |
| 纯文字 Link | 字 `--color-brand`，无底 | hover 下划线 |

- 图标按钮：正方形（32/36/44），圆角 `--radius-md`，图标 16–20px，必须有 aria-label。

### 5.2 输入框 Input / Textarea

- 结构：label（text-sm, `text-secondary`）+ 控件 + helper/error 文本。
- 控件：h 36（md），底 `--color-surface`，边框 1px `--color-border-strong`，圆角 `--radius-md`，内边距 px 12。
- 状态：default / hover(边框加深) / focus(边框 `--color-brand` + 2px `--color-focus-ring`) / error(边框 `--color-danger` + 红色 helper) / disabled(底 `bg-subtle`, 字 `text-tertiary`)。
- 带图标/前缀/后缀（如 Key 掩码、显示密码眼睛图标）。

### 5.3 模态 Modal / Dialog

- 遮罩：`rgba(16,24,40,.45)`（暗色 `rgba(0,0,0,.6)`）。
- 面板：宽 480（sm）/ 640（md）/ 800（lg），底 `surface-raised`，圆角 `--radius-xl`，阴影 `--shadow-lg`，内边距 `--space-6`。
- 结构：标题（text-lg, semibold）+ 关闭按钮 + 内容 + 底部操作区（右对齐，主次按钮）。
- 行为：ESC 关闭、点遮罩关闭（危险确认除外）、打开时锁滚动、焦点进入首个可交互项。

### 5.4 下拉 Select / Dropdown

- 触发器同输入框；菜单：底 `surface-raised`，圆角 `--radius-md`，阴影 `--shadow-md`，内边距 4。
- 选项：h 36，hover 底 `surface-hover`，选中项左侧对勾 + `brand-subtle` 底。
- 支持分组标题、禁用项、超出滚动。

### 5.5 标签 / 徽章 Badge / Tag

- 尺寸：sm（h 20, px 8, text-xs）、md（h 24, px 10, text-sm）。
- 变体：soft（浅底 + 同色字，用于状态）、outline（描边）、solid（实底，用于计数）。
- 号池状态用 soft 变体 + 左侧 6px 圆点。

### 5.6 卡片 Card

- 底 `--color-surface`，边框 1px `--color-border`，圆角 `--radius-lg`，内边距 `--space-5`，阴影 `--shadow-sm`。
- 可交互卡片：hover 抬升（阴影 `shadow-md` + 边框加深 + 轻微上移 1px）。
- 指标卡：左上标题（text-sm, secondary）+ 大数字（text-2xl, bold）+ 趋势/副标题。

### 5.7 表格 Table

- 表头：底 `bg-subtle`，字 `text-secondary`，text-sm，semibold，h 40。
- 行：h 52，下边框 `--color-border`，hover 底 `surface-hover`。
- 单元格：主列可含头像/首字母圆标；操作列右对齐（图标按钮或文字链）。
- 空态：整表区域居中空状态组件；加载态：骨架屏行。
- 分页：右下，页码 + 每页条数选择。

### 5.8 Toast

- 位置：右上角堆叠，宽 360，底 `surface-raised`，圆角 `--radius-md`，阴影 `--shadow-lg`，左侧 3px 语义色条。
- 变体：success / warning / danger / info，各含图标 + 标题 + 描述 + 关闭。
- 时长：默认 4s 自动消失，danger 需手动关闭。

### 5.9 空状态 Empty State

- 居中：线性图标（48px，`text-tertiary`）+ 标题（text-md）+ 描述（text-sm, secondary）+ 主按钮（可选）。
- 例：画布无内容 →"开始你的第一个创作"+ 输入框引导；资产库空 →"还没有作品"+ 去创作按钮。

### 5.10 加载态 Loading

- 骨架屏：`surface-hover` 色块 + 微光扫过动画，用于列表/卡片/表格。
- 旋转器：16/20px 环形，`--color-brand` 描边。
- 生图进度：缩略图占位 + 进度文案（"生成中… / 排队中…"）+ 取消按钮。

### 5.11 头像 Avatar

- 圆形，尺寸 24/32/40；无图时用邮箱首字母 + 基于用户名哈希的柔和背景色（低饱和）。

---

## 6. 关键页面布局

> 断点：`sm < 640` · `md 640–1024` · `lg 1024–1440` · `xl ≥ 1440`

### 6.1 登录/注册页（`/login`）

- 布局：左右分栏（xl/lg）。左侧品牌区（40%，品牌色淡背景 + 品牌名 + 一句话卖点 + 抽象几何纹理，非霓虹）；右侧表单区（60%，居中的 400px 表单卡）。
- 表单：Logo/标题 → 登录/注册 Tab 切换 → 邮箱/密码/（注册含确认密码）→ 主按钮 → 辅助链接（忘记密码 / 切换）。
- **确认邮件已发送态**：表单区切换为"信封"图标 + 目标邮箱 + 倒计时 + 重发按钮。
- 响应式：`md` 及以下隐藏品牌区，表单全宽；表单卡去边框改为纯背景。

### 6.2 主工作台（`/workspace`）

- 三栏布局（桌面）：
  - **左栏（可选收起，260px）**：顶部项目切换 / 资产库快捷入口；下方工具区（添加图片、上传、画布工具）；底部账户 + 额度徽章。
  - **中央（自适应撑满）**：无限画布，点阵背景，缩小/缩放控制（左下角），画布缩略图导航（右下角 minimap）。顶部一条极简工具栏（项目名 + 保存状态 + 分享）。
  - **右栏（360–400px）**：AI 对话面板（会话头 + 消息流 + 输入区）。消息流含用户气泡、AI 文本、生图结果卡片（带"加入画布/再生成"按钮）、编辑对比卡。
- 顶栏（全局，h 56）：左 Logo + 项目名，右额度徽章 + 通知 + 语言切换 + 主题切换 + 头像菜单。
- 响应式：`lg` 及以下右栏可抽屉化；`md` 及以下左栏收起为图标条，右栏变底部抽屉/全屏切换（"画布 / 对话"分段切换）。

### 6.3 管理后台（`/admin/*`）

- 布局：左侧固定导航（240px，含概览/用户/号池/配置/邀请码/公告/日志）+ 右侧内容区。
- 顶部条：面包屑 + 全局搜索 + 管理员头像。
- **用户管理页**：筛选工具条（搜索框 + 角色/状态下拉 + 刷新）+ 用户表格（邮箱/角色/余额/状态/注册时间/操作）+ 分页；"分配额度"为行内操作弹窗。
- **号池管理页**：顶部 4 个指标卡（账号总数 / 正常 / 限流 / 异常+禁用）；工具条（批量导入 / 刷新额度 / 状态筛选 / 搜索）；账号表格（标识掩码 / 类型 / 状态徽章 / 额度 / 最后刷新 / 操作：启禁用·删除）。
- 响应式：`md` 及以下左侧导航收起为顶部汉堡菜单；表格横向滚动。

---

## 7. 无障碍与细节

- 交互元素最小点击区 32×32（移动 44×44）。
- 文本对比度：正文 ≥ 4.5:1，大号标题 ≥ 3:1（双主题均已校）。
- 焦点可见：所有可聚焦元素有 2px 品牌色描边，不用 `outline: none` 抹除。
- 动效：过渡 150–200ms `ease-out`；尊重 `prefers-reduced-motion`。
- 图标：统一 1.5px 线性风格（如 Lucide），尺寸 16/18/20。

---

*文档结束 · 许清楚 · 2026-10-16*
