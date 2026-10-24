# 设计系统 v3 · 页面壳与区块规格

> 依据：`docs/12-visual-audit-2026-10-23.md`（Playwright 实拍 21 个路由，亮/暗/移动）
> 目标：把「每个页面各写一套壳」收敛成「**一套壳 + 一组可复用的区块规格**」，
> 让 10 个页面在 1440 视口下**左沿完全对齐、页头结构完全相同、节区节奏完全相同**。
>
> 本文所有数值都是可直接落地的 px / ms / 类名。凡未在此出现的数值，视为临时值，不得进组件。
>
> **不改设计语言**：暖砂纸底 `#F4F1E9` + 纯白卡面 + 墨黑主按钮 + 青柠信号色 `#CDF564` + 衬线 display。
> v3 只做收口、补缺、清噪，不换皮。

---

## 0. 一页速览（8 条核心规格）

| # | 规格 | 数值 |
|---|---|---|
| 1 | 容器：gutter 三档 + 单档 max-width | `20 / 32 / 48px`；`max-width: 1280px`（含 gutter）。1440 视口下内容左沿恒为 **128px** |
| 2 | 页头结构 | h1 `30px/1.22 · 600 · -0.016em`；desc `14px/1.5 · text-secondary · ≤64ch · mt 8`；actions `gap 8`；页头到内容 **24px** |
| 3 | 粘性页头 | 仅 `≥1024px` 生效；`data-stuck="true"` 时才挂 `--shadow-sticky`；**高度不变**（不塌陷、不抖） |
| 4 | 节区节奏 | 密 `24` / 常 `40` / 疏 `64`（首页级才有 `80`） |
| 5 | 卡片 | `radius 16 / 1px border(70%) / shadow-sheet / padding 20`；hover `translateY(-2px) 240ms` |
| 6 | 表格 | 必须包在卡片内；表头 `44px`；行 `56px`；hover `bg-surface-hover`；分页条 `sticky bottom-0` `56px` |
| 7 | 空状态 | 图形 `72×72`（图标 `28px / stroke 1.5`）+ 标题 `17px/600` + 说明 `≤46ch` + 主次行动 + 提示列表；`min-height 320px` |
| 8 | 动效口径 | hover `160` / enter `420` / exit `180` / loading `1.5s` / 路由 `320`+`180`；错峰 `60ms`，第 8 项封顶；只动 `transform / opacity` |

---

## 1. 页面壳（PageShell v3）

### 1.1 为什么必须改（审计 A2 的量化证据）

1440 视口下，各页标题左沿落在 5 个不同位置，因为**同时存在 5 个 max-width 和 3 套 gutter**：

| 页面 | 现状容器 | 现状标题左沿 | 现状实现 |
|---|---|---|---|
| `/assets` `/projects` `/tasks` `/usage` | `max-w-[1240px]` + `px-6 lg:px-10`（24/40） | 140px | `PageShell` |
| `/settings` | 同上但内容只有 600px 一列 | 140px（视觉像 238px） | `PageShell` + 自建窄列 |
| `/skills` | `max-w-5xl`(1024) + `p-6` | 232px | 自建容器 `routes/skills.tsx:131` |
| `/team` | `max-w-[1120px]` + 白底通栏 hero 带 | 176px | 自建容器 `routes/team.tsx:89,184` |
| `/admin/*` | `max-w-[1480px]` + `px-6 lg:px-10` | 296px | `AdminShell` |

### 1.2 唯一刻度（token 已落地，勿改值）

```css
--shell-gutter: 20px;      /* <640 */
--shell-gutter-md: 32px;   /* ≥640  */
--shell-gutter-lg: 48px;   /* ≥1024 */
--shell-max: 1280px;       /* 含 gutter 的外框宽度，全站唯一常用档 */
--shell-max-wide: 1440px;  /* 逃生档：仅 ≥1600 视口且表格列 ≥8；当前无页面使用 */
--shell-max-narrow: 880px; /* 仅「整页一个表单/一张空态」 */
--shell-bottom-pad: 48px;         /* 滚动容器底部安全间距，修 /skills 末行被裁 */
--shell-bottom-pad-float: 104px;  /* 有浮动操作条时（如 /skills 的保存条） */
```

**推算结果（必须与实现一致）**

| 视口 | 容器宽 | 内容宽（减 gutter） | 内容左沿 |
|---|---|---|---|
| 390（手机） | 390 | 350 | 20 |
| 768（平板） | 768 | 704 | 32 |
| 1024 | 1024 | 928 | 48 |
| 1440 | 1280 | 1184 | **128** |
| 1920 | 1280 | 1184 | 320 |

**类名（照抄，不要各自发挥）**

```tsx
// 容器：三档 gutter + 单档宽度
className="mx-auto w-full max-w-[var(--shell-max)]
           px-[var(--shell-gutter)]
           md:px-[var(--shell-gutter-md)]
           lg:px-[var(--shell-gutter-lg)]"
```

> 若 `var()` 写法在某些工具链里不生效，退化为字面量 `px-5 md:px-8 lg:px-12` + `max-w-[1280px]`，
> 数值必须一致。**禁止**再出现 `max-w-5xl` / `max-w-[1120px]` / `max-w-[1480px]`。

### 1.3 页头结构（唯一定义）

```
┌─ header (sticky ≥1024, z-20) ───────────────────────────────┐
│  ┌─ 容器（max-w + gutter）────────── padding-top 20 ────┐  │
│  │  左：h1 / desc                         右：actions    │  │
│  │  ──（有 tabs 时才画 1px 分隔线 + tabs 行 40px）──      │  │
│  └────────────────────────────── padding-bottom 16 ─────┘  │
└────────────────────────────────────────────────────────────┘
                          ↓ 24px
                    内容第一块
```

| 元素 | 规格 |
|---|---|
| 页头外框 | `min-height: 76px`（`--shell-header-min-h`）；`padding-top: 20px`；`padding-bottom: 16px`；背景 `var(--color-bg)`（不许 `bg-surface/85` + blur，纸感语言里页头不该是玻璃） |
| 标题行 | `flex items-start justify-between gap-6`；左列 `min-w-0`，actions `shrink-0` |
| h1 | `font-size: 30px`（`--text-h2`）；`line-height: 1.22`；`font-weight: 600`；`letter-spacing: -0.016em`；`color: var(--color-text)` |
| desc | `font-size: 14px`（`--text-ui`）；`line-height: 1.5`（`--lh-ui`）；`color: var(--color-text-secondary)`；`max-width: 64ch`；`margin-top: 8px` |
| actions | `display:flex; gap:8px; align-items:center`；主按钮永远在最右 |
| 分隔线 | 只在**有 tabs** 时出现：`1px solid var(--color-border-faint)`，画在 tabs 行的下沿；无 tabs 的页头不画线（靠留白分节） |

**移动端覆盖（<640）**：actions 换到标题下方一整行，右对齐：

```
h1
desc（≤2 行，超出截断）
[actions]  ← 右对齐，宽度 100%
```

实现：`flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between`。

### 1.4 页头 tabs（PageShell 新增插槽）

现状问题：`/assets` 的 All/Generated/Uploaded 是内容区里的三个小胶囊，与右上角主按钮体量断裂；
`/tasks` `/usage` 完全没有筛选。统一改为**页头 tabs**。

| 属性 | 值 |
|---|---|
| 行高 | `40px`（`--tab-h`） |
| 间距 | `gap: 24px` |
| 文字 | `14px / 500 / 0`，未选中 `text-tertiary`，选中 `text-text` + `600` |
| 指示条 | `2px`，颜色 `var(--color-brand)`（墨黑，**不用青柠**——青柠每屏只留给 ≤2 处信号） |
| 过渡 | `color 160ms`、指示条 `transform 160ms`（滑动式）或 `border-color 160ms`（逐项式） |
| 下沿 | `border-bottom: 1px solid var(--color-border-faint)`，指示条压在线上 |
| 触控 | 每项点击热区高度 40px、左右内距 2px、项与项之间 24px（满足 44px 目标靠 40px 行 + 上下各 2px 外扩） |
| tabs 到内容 | `20px`（`--shell-header-gap-tabs`） |

```tsx
<div role="tablist" className="flex items-center gap-6 border-b border-border-faint">
  <button role="tab" aria-selected className="relative h-10 text-ui font-medium
    text-text-tertiary transition-colors duration-[160ms] hover:text-text
    aria-selected:text-text aria-selected:font-semibold
    after:absolute after:inset-x-0 after:-bottom-px after:h-[2px]
    after:bg-transparent after:transition-colors aria-selected:after:bg-brand">
```

### 1.5 粘性行为（修「滚动后不知道自己在哪一页」）

| 条件 | 行为 |
|---|---|
| `<1024px` | **不粘**。手机屏矮，76px 页头常驻会吃掉 1/5 屏 |
| `≥1024px` | `position: sticky; top: 0; z-index: 20` |
| 未吸附（`data-stuck="false"`） | 无阴影、无分隔线，与内容融成一片纸 |
| 已吸附（`data-stuck="true"`） | `box-shadow: var(--shadow-sticky)`（1px 收边 + 极浅下投影） |
| 吸附过程中 | **尺寸零变化**：不隐藏 desc、不缩短 padding、不缩放标题。否则滚动时内容会跳 |
| 触发点 | `IntersectionObserver`，`rootMargin: '-1px 0px 0px 0px'`，回写 `data-stuck` |
| 类名 | `cs-sticky-edge`（过渡已在 `motion.css` 定义） |

> 结构要求：sticky 元素必须是**滚动容器的直接子元素**且横跨整宽；
> 内容容器（max-w + gutter）在它**内部**。否则背景只有 1280px 宽，
> 滚动时两侧会露出内容。

### 1.6 页面 → 档位归属（改造清单）

| 路由 | max-width | 页头 tabs | 备注 |
|---|---|---|---|
| `/assets` | 1280 | All / Generated / Uploaded（从内容区移入） | 网格改自适应列 |
| `/projects` | 1280 | 无 | 网格自适应 + 幽灵新建卡 |
| `/tasks` | 1280 | 全部 / 进行中 / 失败 / 完成 | 补筛选（审计 T1） |
| `/usage` | 1280 | 概览 / 明细 | 新增消耗趋势图；表格入卡 |
| `/skills` | 1280 | Packs / Skills（从内容区移入） | 容器从 1024 放到 1280；补底部安全间距 |
| `/team` | 1280 | 无 | **去掉白底通栏 hero**，改用标准页头；`cs-team-hero` 只保留在团队详情页 |
| `/settings` | 1280 | 无 | 改两列：左 184px 分区导航 + `gap 32` + 右列 `max-w-[720px]` |
| `/admin/*` | 1280 | 需要时 | `AdminShell` 直接复用 §1.3 页头，不许再写一套 |
| `/workspace` | 全屏 | — | 唯一例外：画布页不出 PageShell |
| `/`（首页） | 全屏 | — | 品牌页，节奏用 `--gap-section: 80px` |

**`/settings` 两列布局数值**：左侧导航 `184px`，列间距 `32px`，右侧表单 `max-width: 720px`；
分区顺序 `账户 → 密码 → AI 中转站 → 主题 → 危险操作`，最后一个分区标题用 `--color-danger`。

---

## 2. 节区节奏（Section rhythm）

审计里「巨大的空白段落」根因不是间距太大，而是**同一页里两种节奏混用**：
`/projects` 只有一个项目时，内容高度 300px 后接了 400px 空白（无幽灵卡、无引导）。

| token | 值 | 用在哪 |
|---|---|---|
| `--gap-row` | 12px | 工具栏里按钮之间、筛选胶囊之间 |
| `--gap-inline` | 8px | 图标与文字、按钮与按钮 |
| `--gap-dense` | 24px | 驾驶舱式页面：指标卡与指标卡、表格与图 |
| `--gap-normal` | 40px | **默认**：并列 section（图 → 表 → 分页） |
| `--gap-loose` | 64px | 稀疏页：内容少、想让页面透气 |
| `--gap-section` | 80px | 仅首页 |

**硬规则**

1. 一页只选**一种**节奏，并在文件顶部注释写清（`default` 除首页外一律 `--gap-normal`）。
2. 页面内所有区块间距从上面取值；禁止出现 `mt-[38px]`、`gap-[30px]` 这类临时值。
3. 内容高度不足视口 60% 的页面，**必须**补「幽灵新建卡」或「下一步引导」，禁止留白收场。
4. 区块内部（卡片内标题到内容）固定 `16px`；卡片内分节之间 `20px`。

---

## 3. 卡片与网格

### 3.1 Card 规格（现行 `card.tsx` 已基本符合，仅微调）

| 属性 | 值 |
|---|---|
| 圆角 | `16px`（`--card-radius`，也用 `--radius-md`） |
| 边框 | `1px solid color-mix(in srgb, var(--color-border) 70%, transparent)` |
| 阴影 | `var(--shadow-sheet)`，**静止状态只有这一层** |
| 内距 | `20px`（`--card-pad`）；紧凑卡 `16px` |
| hover | `translateY(-2px)` + `border-color: var(--color-border-strong)` + `shadow-lift`，`240ms var(--ease-out)` |
| active | `translateY(0) scale(0.995)`，`80ms` |
| 禁止 | 圆角 >16px；`border-left: 3px` 彩色强调条；静止态同时有 `1px border` + `blur≥16px` 的「幽灵卡」 |

### 3.2 网格列数（修审计 P1「210px 卡片孤零零」）

| 页面 | 类名 | 1184 内容宽下的卡片宽 |
|---|---|---|
| `/assets` | `grid grid-cols-2 gap-4 sm:grid-cols-3 md:gap-5 lg:grid-cols-4 2xl:grid-cols-5` | 4 列 → 281px |
| `/projects` | `grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4` | 4 列 → 281px |
| `/skills` | `grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3` | 3 列 → 384px |

### 3.3 图片托盘（修审计 A1-assets「竖图被裁掉大半」）

现状 `object-cover` 把 351×1238 的竖图裁成正方形。改为**卡纸 + 完整图**：

```
容器：aspect-square，background: var(--card-media-mat)（即 --color-bg-subtle）
图片：object-contain，居中，padding 8px
```

这样竖图缩到容器内、上下留出米色卡纸，是「设计稿摆在桌上」的观感，也避免裁切失真。
缩略图 hover 放大交给 `.cs-zoom`（`scale 1.045 / 420ms`），不额外加滤镜。

### 3.4 卡片底部元信息行（修审计 A1-2「图标基线不齐」）

```
高 32px，padding-inline 16px，border-top 1px border-faint
左：尺寸文字 11px/400/--font-mono/tabular-nums/--color-text-tertiary
右：图标按钮 3 个，gap 4px，每个 28×28（图标 16px/2.0），
    hit area 用 padding 补到 44×44（负 margin 不占布局）
基线：所有图标按钮 flex items-center，禁止 mix-blend 或自行 margin-top
```

---

## 4. 表格（修审计 A4 / D2）

### 4.1 结构（必须逐层照抄）

```
<div class="card">                         radius 16 / border 1px / shadow-sheet / p-0
  <div class="head-clip">                  rounded-t-[16px] overflow-hidden  ← 只为裁表头底色
     <table>                               w-full border-collapse
  </div>
  …tbody…
</div>
<div class="cs-sticky-foot sticky bottom-0">   ← 分页条是「表格卡的兄弟」，不是子元素
  <Pagination/>
</div>
```

> **为什么分页条不能在卡片里**：卡片若 `overflow:hidden`，`position:sticky` 会失效并贴在卡片
> 底部（长表时被挤出视口，正是审计里「分页被挤到视口外」的原因）；卡片若 `overflow:visible`，
> 表头底色又会溢出圆角。所以表头裁切与吸底分页必须拆成两个元素。

### 4.2 数值

| 部位 | 值 |
|---|---|
| 表头 | 高 `44px`；`background: var(--color-bg-subtle)`；文字 `13px / 500 / var(--color-text-tertiary)`；`letter-spacing: 0.02em`；`padding-inline: 16px`（首末列 `20px`）；`border-bottom: 1px solid var(--color-border)` |
| 行 | 高 `56px`（原 52 → 加 4px，为触控与双行单元格留空间）；`border-bottom: 1px solid var(--color-border-faint)` |
| 行 hover | `background: var(--color-surface-hover)`，`120ms`（比卡片 hover 快，表格里鼠标移动频繁） |
| 行选中 | `background: var(--color-accent-soft)` + 左侧 `2px inset` 青柠（只在支持多选的表格出现） |
| 最后一行 | 无下边框 |
| 单元格 | `padding-inline: 16px`；文字 `14px / 1.5 / var(--color-text)` |
| 数字列 | `text-align: right`；`font-family: var(--font-mono)`；`font-size: 13px`；`font-variant-numeric: tabular-nums`（金额/额度/百分比必须） |
| 状态列 | 用 `Badge` 而非纯文本：`success / warning / danger / info` 四色，`subtle` 底 + 主色字 + `radius-full` + `height 22px` + `padding-inline 8px` + `12px` 字 |
| 操作列 | 图标按钮 28×28（图标 16px），`gap 4px`，右对齐，末列 `padding-right: 20px` |
| 空数据 | 表格卡内 `<EmptyState>`，`min-height: 320px` |
| 加载中 | 5 行骨架，每行高 `56px`，`.cs-skeleton`，只脉冲 opacity |
| 横向溢出 | 表格自身 `overflow-x: auto` + `min-width: 720px`，绝不横向撑破页面 |

### 4.3 吸底分页条

| 属性 | 值 |
|---|---|
| 高度 | `56px`（`--table-foot-h`） |
| 定位 | `position: sticky; bottom: 0; z-index: 10` |
| 背景 | `color-mix(in srgb, var(--color-surface) 92%, transparent)` + `backdrop-filter: blur(12px)` |
| 上边 | `border-top: 1px solid var(--color-border-faint)`，并用 `margin-top: -1px` 与卡片下边框重叠 |
| 圆角 | `border-bottom-left/right-radius: 16px` |
| 吸附投影 | `data-stuck="true"` 时加 `--shadow-table-foot`（`cs-sticky-foot`） |
| 内容 | 左：`共 N 条 · 第 p / P 页`（13px，text-tertiary）；右：每页条数 select（高 32）+ 上/下页（32×32） |

### 4.4 表格页的统一骨架

```
页头（h1 + desc + 主按钮）        ← 主按钮放页头 actions，不要和筛选行分开（修 D2-3）
  ↓ 24
工具栏（筛选 + 搜索 + 批量操作）  高 36，gap 12
  ↓ 12
表格卡（吸底分页）
  ↓ 40
（可选）图例/说明
```

---

## 5. 空状态（修审计 A3）

现状：48px 灰圆 + 一行标题，垂直位置在三处不同（180/235/居中）。
统一为**同一个组件 + 同一套尺寸 + 每页只换图标与文案**。

### 5.1 结构（自上而下，垂直居中在一个 `min-height: 320px` 的盒子里）

| 层 | 规格 |
|---|---|
| 图形容器 | `72×72`（`--empty-glyph`），`radius 16px`，`background: var(--color-bg-subtle)`，`border: 1px solid var(--color-border-faint)`；内部图标 `28px`，`stroke-width: 1.5`，`color: var(--color-text-tertiary)` |
| 到标题 | `20px` |
| 标题 | `17px / 1.4 / 600 / -0.01em / var(--color-text)` |
| 到说明 | `8px` |
| 说明 | `14px / 1.6 / var(--color-text-secondary)`；`max-width: 46ch`；居中对齐 |
| 到行动 | `20px` |
| 行动 | 主按钮（`size=md`，高 36）+ 次按钮（`variant=ghost`），`gap 8`，水平居中 |
| 到提示列表 | `28px` |
| 提示列表 | 3 条以内；列表整体 `max-width: 360px`，**左对齐**（居中列表读起来很累）；每条 `14px / text-secondary`，图标 `16px / 2.0`，`gap 10px`，行间 `10px` |
| 容器内距 | `padding: 64px 24px`（纵向 64，横向 24） |
| 入场 | `.cs-glyph-in`（`scale 0.96→1` + 淡入，420ms），文字用 `.cs-enter-item` 错峰 60ms |

### 5.2 图形怎么画（禁 emoji，禁 3D 插画）

- **只用 lucide 单色描边图标**，不允许内联彩色 SVG、不允许 emoji、不允许渐变填充。
- 尺寸三档固定：`16 / 20 / 24`，空状态用 `28px`（唯一例外，因为它在大盒子里，且必须是 `stroke 1.5`）。
- 想增加层次时**只允许**加一层：容器换成 `1px dashed var(--color-border-strong)` + 透明底。
  不要叠第二层装饰、不要加投影、不要加旋转。

### 5.3 每页的图标与文案（禁「No data」「暂无数据」这类空话）

| 页面 | lucide 图标 | 标题 | 说明 | 主行动 | 次行动 |
|---|---|---|---|---|---|
| `/assets` | `Images` | 资产库还是空的 | 生成的图和上传的参考图都会归档在这里，随时可以拖回画布复用。 | 上传第一张图 | 去工作台生成 |
| `/projects` | `FolderPlus` | 还没有项目 | 一个项目就是一个画布集。分好组，找图时不用再翻时间线。 | 新建项目 | 看示例项目 |
| `/tasks` | `ListChecks` | 没有正在跑的任务 | 长图、批量改图会异步执行，进度都能在这一页看到。 | 去生成一张 | 只看失败的任务 |
| `/team` | `UsersRound` | 还没有团队空间 | 建一个空间，把技能包、素材、额度和项目放在一起，同事不用再互相传文件。 | 创建团队 | 了解团队空间 |
| `/skills` | `Sparkles` | 技能库没有匹配项 | 换个关键词，或先在「技能包」里启用一组。 | 清空筛选 | 浏览全部技能包 |
| `/admin/users` | `UsersSearch` | 没有匹配的用户 | 试试改邮箱前缀，或清掉角色筛选。 | 清空筛选 | 新建用户 |
| `/usage` | `ReceiptText` | 这段时间没有消耗 | 生成与编辑的每一笔都会记账，切到「全部时间」看历史。 | 查看全部记录 | 了解计费规则 |

### 5.4 网格页的「幽灵新建卡」（修「整页 80% 空白」）

```
尺寸：与相邻卡片同列宽、同 aspect（用 aspect-square 或与卡片同高，靠 grid 自动对齐）
样式：border: 1px dashed var(--color-border-strong)；
      background: transparent；
      radius 16px；
      display:flex 纵向居中，gap 12
内容：Plus 图标 24px（stroke 1.5，text-tertiary）+ 14px/500 文字（text-secondary）
hover：border-color: var(--color-accent)；
       background: color-mix(in srgb, var(--color-accent-soft) 40%, transparent)
       ——这是青柠在本屏的**唯一**出现处，主按钮已是墨黑，不冲突
触控：整卡可点，`role="button"`，键盘可达，`:focus-visible` 出 2px 焦点环
```

---

## 6. 图表（新增 —— 审计 U1-4「用量页却没有曲线」）

**技术前提**：`package.json` 里没有 recharts / d3 / chart.js，且不为此新增依赖。
图表用手写 `<svg viewBox>` + 直接从数据算路径；折线用 `polyline`，柱用 `rect`。

### 6.1 配色（token 已落地，禁止硬编码）

| token | 亮色 | 暗色 | 用途 |
|---|---|---|---|
| `--chart-1` | `#6b8f1f` | `#c3f04d` | 主指标：消耗积分 / 生成次数 |
| `--chart-2` | `#2f6f6b` | `#6fd3c0` | 副指标：活跃用户 / 编辑次数 |
| `--chart-3` | `#a9761b` | `#f0b752` | 异常类：失败 / 超限 |
| `--chart-4` | `#8a8674` | `#8d8778` | 同环比 / 历史对照（主动退后） |
| `--chart-grid` | `color-mix(text 9%)` ≈ `rgba(20,19,13,.09)` | ≈ `rgba(244,241,231,.09)` | 横向网格线 |
| `--chart-axis` | `color-mix(text 16%)` | 同公式 | 基线 / 坐标轴 |
| `--chart-label` | `var(--color-text-tertiary)` | 同 | 刻度文字 |
| `--chart-fill-1` | `--chart-1` 的 10% | 14% | 折线下方面积 |
| `--chart-dot-ring` | `var(--color-surface)` | 同 | 数据点描边（把点从线上「挖」出来） |

> 禁止：紫→粉渐变、彩虹色系列、半透明堆叠到糊成一片、发光折线。

### 6.2 几何与排版

| 部位 | 值 |
|---|---|
| 主图高度 | `180px`（`--chart-h`）；卡内 mini 趋势 `64px`（`--chart-h-sm`） |
| 内边距 | `top 8 / right 8 / bottom 24 / left 44`（左让 y 轴标签，下让 x 轴标签） |
| 网格线 | 只有**横向**，`1px`，`--chart-grid`，**实线**（虚线在纸感语言里读起来像草稿） |
| 基线 | `1px --chart-axis`，`y = 底部` |
| y 轴刻度 | 3 个（0 / 中 / 最大），右对齐到 `x = plot.left - 8`；文字 `11px`，`--font-mono`，`tabular-nums`，`--chart-label` |
| x 轴标签 | 最多 5 个，均匀取样；文字 `11px`，居中于刻度点 |
| 折线 | `stroke-width: 2px`；`stroke-linecap: round`；`stroke-linejoin: round` |
| 面积 | 单色平铺 `--chart-fill-1`（**不要**垂直渐变，那是 AI 模板的标配） |
| 数据点 | 半径 `3px`（`--chart-dot-r`），填充 `--chart-1`，描边 `2px --chart-dot-ring`；只在 hover 最近点或点数 ≤14 时显示 |
| 柱状 | 宽 `min 6 / max 24`，圆角 `2px`（只圆上两角）；柱间距 ≥ 4px |
| 入场 | 折线用 `.cs-draw`（stroke 自绘 720ms），柱用 `scaleY` 从 0 起，**只在首次拿到数据时播放**；刷新数值不重播 |
| 高度变化 | 图表容器必须给**固定高度**，避免加载完成时 CLS |

### 6.3 tooltip

| 属性 | 值 |
|---|---|
| 容器 | `background: var(--color-surface)`，`radius 10px`，`padding: 8px 12px`，`border: 1px solid var(--color-border)`，`shadow-lift` |
| 文字 | 数值 `13px / 600 / --font-mono`；标签 `11px / --chart-label` |
| 指示线 | `1px` 竖向，`--chart-axis`，实线，从轴线到数据点 |
| 定位 | 跟随指针，距指针 `12px`，靠近边缘时翻转到左侧 |
| 出现 | `120ms` 淡入 + `translateY(2px)`；**不缩放**（缩放会让数字发虚） |

### 6.4 空数据态

```
容器同高（180px），无网格线
居中一条 1px dashed --chart-grid 的横向基线
居中文字 13px --chart-label：「这段时间还没有数据」
可选：文字下方 12px 处一个 ghost 按钮「切到最近 30 天」
```

### 6.5 落点

| 页面 | 图 | 数据 | 位置 |
|---|---|---|---|
| `/usage` | 折线 + 面积，30 天消耗 | 按天聚合 `Edit` + `Image` 消耗 | 价格卡下方、交易表上方，占满内容宽 |
| `/admin`（Overview） | 柱状，14 天新增用户 + 折线，14 天消耗 | 现有接口按天聚合 | 指标卡下方（修 D1-2「8 张卡之后整页空白」） |
| `/admin`（指标卡内） | mini 折线 `64px` | 近 7 天 | 卡片底部，`opacity .9` |

---

## 7. 动效（修审计 A5）

### 7.1 总表（5 条，覆盖「入场 / hover / 页面切换 / 加载」+ 退场）

| 类 | duration | easing | 允许动画的属性 | 典型场景 |
|---|---|---|---|---|
| **hover** | `160ms`（`--motion-hover`） | `--ease-out` | `color, background-color, border-color, box-shadow, transform(≤2px)` | 按钮、卡片、表格行、tabs、输入框聚焦 |
| **enter** | `420ms`（`--motion-enter`） | `--ease-out` | `opacity, transform` | 页面入场、区块出现、列表项错峰、空状态图形 |
| **exit** | `180ms`（`--motion-exit`） | `--ease-out` | `opacity, transform` | 弹层关闭、条目删除、面板收起 |
| **loading** | `1.5s`（`--motion-loading`） | `--ease-inout`（脉冲）/ `linear`（转圈） | `opacity`、`rotate`/`transform` | 骨架脉冲、青柠扫光、spinner 800ms |

**入场位移量**：`--enter-distance: 12px`，只走 Y 轴（不做左右滑，那会让页面像幻灯片）。
**错峰**：`--motion-stagger: 60ms`，`animation-delay: calc(min(var(--i,0),7) * 60ms)`，**第 8 项封顶**。
首屏 12 张卡若逐项累加，最后一张要等 660ms，感知上就是「卡住了」。

### 7.2 页面切换（已有两套实现，统一口径）

现状 `motion.css` 里已有两套路由动效（`.cs-route-enter` 与 View Transition），
数值不一致；v3 统一到下面这张表，二者只保留语义，时长对齐：

| 通道 | duration | easing | 属性 | 位移 |
|---|---|---|---|---|
| 新页进场（`::view-transition-new(root)`） | `320ms` | `--ease-out` | `opacity, transform` | `translateY(8px) → 0` |
| 旧页退场（`::view-transition-old(root)`） | `180ms`（= `--motion-exit`） | `--ease-out` | `opacity, transform` | `0 → translateY(-6px)` |
| 降级路径 `.cs-route-enter`（无 View Transition 的浏览器） | `420ms`（= `--motion-enter`） | `--ease-out` | `opacity, transform` | `translateY(10px) → 0` |

**冲突规则（必须遵守，否则会「页面淡入 + 12 张卡再淡入」，看起来像加载了两次）**

1. 一次导航**只播一种入场**：走了 View Transition 就不再给页内区块加 `.cs-enter-item`。
2. `.cs-enter-item` 只用于「同页内数据到达」「筛选切换」「tab 切换」，不用于首次路由进入。
3. tab 切换只播内容区（`opacity 160ms`），页头与 tabs 不重播。
4. 返回/前进（历史导航）不播位移，只播 `opacity 120ms`——用户是在「回到刚才那」，不该有「新地方」的感觉。

### 7.3 唯一允许的写法

```tsx
// 容器
<div className="cs-enter">
  {items.map((it, i) => (
    <Card className="cs-enter-item" style={{ '--i': i } as CSSProperties} />
  ))}
</div>
```

`useReveal`（GSAP）只保留给首页与工作台画布这类需要复杂编排的场景；
**列表页 / 表格页 / 设置页一律走上面的 CSS 类**，不再每页写一遍 GSAP 参数。

### 7.4 禁止清单（出现即退）

| 禁止 | 原因 |
|---|---|
| 动画 `width / height / top / left / margin / padding` | 每帧重排，长列表直接掉帧 |
| 动画 `background-position` 做扫光 | 用 `.cs-shimmer` 的伪元素 transform 版本（已实现） |
| 对 >200px 的元素动画 `filter: blur()` | 合成层爆炸，移动端必卡 |
| 列表 >6 项同时动画 `box-shadow` | 逐帧重绘阴影，改成 hover 单项 |
| 线性 easing 做结构动画 | 机械感，只有 spinner 允许 linear |
| 页面入场做整屏滑动 / 视差 | 与「纸感工作室」语言冲突 |
| 每个 section 都播同样的淡入 | 重复动效 = AI 脚手架味；改为一页一次总入场 + 局部反馈 |

### 7.5 降级

`prefers-reduced-motion: reduce` 与低性能设备 `html.cs-lite` 已在 `motion.css` 末尾统一处理：
v3 新增的全部类（`.cs-enter / .cs-enter-item / .cs-exit / .cs-glyph-in / .cs-draw`）
在减弱动效下**直接置为终态**（`opacity:1; transform:none; stroke-dashoffset:0`），
不会出现「元素卡在 opacity:0 永不出现」的问题。

---

## 8. 背景与表面（修审计 A1「环境光溢出到所有页面」）

### 8.1 诊断（关键发现）

`body` 上挂了 `--ambient-1/2` 两团径向光，`background-attachment: fixed`，
于是**每个页面**左上角都糊着一层黄绿雾（截图证据：`light-assets.png`、
`light-projects.png`、`light-admin.png` 的左上角）。

而首页其实**并不依赖**这层光：`routes/index.tsx:192-206` 自己有 `auroraRef` 三层
blur 光斑（`bg-accent/30 blur-[120px]` 等）+ `.cs-grain`。登录页是首页上的弹窗
（`routes/login.tsx` 直接 `redirect({to:'/'})`，`AuthDialog` 覆盖）。

结论：**`body` 上那层环境光是纯多余，且是缺陷源。**

### 8.2 已落地的改法（`index.css`，共 3 处）

```css
/* 1. body：去掉环境光，只留纸张噪点 */
body {
  background-color: var(--color-bg);
  background-image: var(--texture-paper);   /* 3.5% 噪点，全站统一质感 */
}

/* 2. 暗色同步（原来又铺了一遍 ambient） */
[data-theme='dark'] body {
  background-image: var(--texture-paper);
}

/* 3. 需要氛围的页面自己挂（首页/营销页/登录弹窗背景） */
.cs-ambient {
  background-image: var(--ambient-1), var(--ambient-2);
  background-repeat: no-repeat;
  background-attachment: fixed;
}
```

结果：

| 位置 | 亮色 | 暗色 |
|---|---|---|
| 内容页（`/assets` `/projects` `/usage` `/settings` `/team` `/skills` `/admin/*`） | `#F4F1E9` + 3.5% 噪点，**纯净纸底** | `#0B0A07` + 噪点 |
| 首页 / 营销页 | 自己的 aurora 光斑（不动） | 同 |
| 工作台画布 | `--color-canvas` 台面 + 内阴影（不动） | 同 |

> 这条改动零 tsx 变更即可生效（因为首页自带光斑），且立刻消除 7 个页面的左上角脏污。

### 8.3 表面层级（暗色靠明度，不靠阴影）

| 层 | 亮色 | 暗色 |
|---|---|---|
| 页面底 | `#F4F1E9` | `#0B0A07` |
| 卡面 | `#FFFFFF` | `#16150F` |
| 卡面（浮起） | `#FFFFFF` | `#1D1B14` |
| hover 面 | `#F3EFE4` | `#262318` |
| 表头 / 图形底 | `#EAE5D8` | `#11100B` |
| 边框 | `#E1DAC9` | `#2C2819` |
| 弱边框 | `#EFE9DB` | `#201D13` |
| 强调边框 | `#CBC2AC` | `#423C27` |

---

## 9. 图标系统（P0 约束）

| 项 | 锁定值 |
|---|---|
| 库 | `lucide-react`（已在依赖里，唯一允许） |
| 尺寸三档 | `16px`（行内/格内）、`20px`（按钮内）、`24px`（独立/导航） |
| 线宽 | 与尺寸反比，光学等重：`16px -> strokeWidth 2`、`20px -> 1.75`、`24px -> 1.5` |
| 唯一例外 | 空状态大图标 `28px / 1.5` |
| 颜色 | 一律 `currentColor`，由父级 `text-*` 决定；禁止给 SVG 写死 fill |
| 图标按钮热区 | 视觉 28 或 32，**热区必须 44×44**（用 padding 补，不用 transform 放大） |
| 禁止 | emoji 作功能图标（任何 `U+1F300-1F9FF` / `2600-26FF` / `2700-27BF` 区间的字符）；混用第二套图标库；同屏出现 16/18/20 三种尺寸（审计 W1-8） |

> 工作台工具条（审计 W1-8「图标大小不一、基线不齐」）：统一 `20px / strokeWidth 1.75`，
> 按钮容器 `32×32`，`flex items-center justify-center`，组内 `gap 2px`，组间 `gap 1px` + 1px 竖分隔线。

---

## 10. 亮 / 暗双主题对照表

| 语义 | token | 亮色 | 暗色 |
|---|---|---|---|
| 页面底 | `--color-bg` | `#F4F1E9` | `#0B0A07` |
| 次级底 | `--color-bg-subtle` | `#EAE5D8` | `#11100B` |
| 卡面 | `--color-surface` | `#FFFFFF` | `#16150F` |
| 主动作/墨 | `--color-brand` | `#1A1810` | `#EFE9D6` |
| 墨 hover | `--color-brand-hover` | `#2C2A1C` | `#FFFDF0` |
| 正文 | `--color-text` | `#14130D` | `#F4F1E7` |
| 次正文 | `--color-text-secondary` | `#4B4739` | `#B9B3A2` |
| 三级文字 | `--color-text-tertiary` | `#7B7566` | `#8D8778` |
| 边框 | `--color-border` | `#E1DAC9` | `#2C2819` |
| 弱边框 | `--color-border-faint` | `#EFE9DB` | `#201D13` |
| 强调边框 | `--color-border-strong` | `#CBC2AC` | `#423C27` |
| 信号色 | `--color-accent` | `#CDF564` | `#D6FF6E` |
| 信号色深 | `--color-accent-strong` | `#B9E63C` | `#C3F04D` |
| 信号色淡底 | `--color-accent-soft` | `#F2FFD2` | `#212A10` |
| 青柠上的字 | `--color-on-accent` | `#1A1F05` | `#1A1F05` |
| 成功 | `--color-success` | `#2C7A4B` | `#4ADE9B` |
| 警告 | `--color-warning` | `#A96B00` | `#F2B544` |
| 危险 | `--color-danger` | `#C0392B` | `#FF8A80` |
| 信息 | `--color-info` | `#2F6FEB` | `#6EA8FF` |
| 焦点环 | `--color-focus-ring` | `#8FB32A` | `#C3F04D` |
| 卡片阴影 | `--shadow-sheet` | `0 1px 2px rgba(45,38,20,.05), 0 4px 12px -4px rgba(45,38,20,.08)` | `0 1px 2px rgba(0,0,0,.45), 0 4px 14px -4px rgba(0,0,0,.4)` |
| 抬起阴影 | `--shadow-lift` | `0 2px 6px -2px rgba(45,38,20,.07), 0 16px 32px -12px rgba(45,38,20,.14)` | `0 2px 6px -2px rgba(0,0,0,.5), 0 16px 38px -12px rgba(0,0,0,.55)` |
| 粘性页头 | `--shadow-sticky` | `0 1px 0 border(70%), 0 8px 16px -16px rgba(45,38,20,.5)` | `0 1px 0 var(--color-border), 0 8px 16px -16px rgba(0,0,0,.9)` |
| 吸底分页 | `--shadow-table-foot` | `0 -1px 0 border(70%), 0 -8px 16px -16px rgba(45,38,20,.4)` | `0 -1px 0 var(--color-border), 0 -8px 16px -16px rgba(0,0,0,.85)` |
| 图表 1 | `--chart-1` | `#6B8F1F` | `#C3F04D` |
| 图表 2 | `--chart-2` | `#2F6F6B` | `#6FD3C0` |
| 图表 3 | `--chart-3` | `#A9761B` | `#F0B752` |
| 图表 4 | `--chart-4` | `#8A8674` | `#8D8778` |
| 网格线 | `--chart-grid` | `rgba(20,19,13,.09)` | `rgba(244,241,231,.09)` |
| 轴线 | `--chart-axis` | `rgba(20,19,13,.16)` | `rgba(244,241,231,.16)` |

> 亮色下**没有** `#000` / `#808080`；暗色下**没有** `#FFF` 直接当正文。
> 所有值都从 token 取——组件里不允许出现裸 hex（`#fff`/`#000` 除外）。

---

## 11. 审计缺陷 → 处方对照（逐条闭环）

| 审计项 | 处方 | 落点 |
|---|---|---|
| A1 环境光溢出 | `body` 去 ambient 改纸噪点；`.cs-ambient` 按需 | 已完成（`index.css` §8.2） |
| A2 容器不统一 | 单档 1280 + 三档 gutter；settings/skills/team/admin 全部并入 | §1 |
| A3 空状态空洞 | 72px 图形 + 标题 + 46ch 说明 + 双行动 + 提示列表，min-h 320 | §5 |
| A4 表格无框无吸底 | 卡片包表 + 表头裁剪层 + 兄弟节点吸底分页 | §4 |
| A5 动效不统一 | 四档时长 + 一条 `.cs-enter-item` 错峰 | §7 |
| W1-1 工具条换行 | 工具栏按钮 `whitespace-nowrap` + 按钮高 32 + 文案改短（`加入画布` / `上传`） | 前端 |
| W1-2 缩放重复 | 只保留右下缩放组，左下改全局缩略图 | 前端 |
| W1-3 左侧悬浮缩略图 | 移入图层面板；画布左边缘 24px 内不放任何浮层 | 前端 |
| W1-4 Toast 遮挡对话 | Toast 改 `position: fixed` 右上（`top: 64px right: 16px`），不覆盖对话中转轴 | 前端 |
| W1-5 工具选中态紫色 | Excalidraw `--color-primary` 已接 `--color-brand`；残留的淡紫是 `--color-primary-light`，接到 `--color-brand-subtle` | 前端（`index.css` 已接大部分） |
| W1-6 对话面板过窄 | 面板 `min-width: 300px`（当前 230），断点 <1280 时改抽屉 | 前端 |
| W1-7 版本 badge 截断 | badge `min-width: 44px` + `whitespace-nowrap` | 前端 |
| P1-1 项目无封面 | 取画布首张图片作封面；无图时用 `--card-media-mat` + `Frame` 图标 | 前端 |
| P1-2 卡片 210px | 自适应 1/2/3/4 列（§3.2） | 前端 |
| P1-3 分页孤悬 | 分页贴内容下 16px，或吸底（长表） | §4.3 |
| P1-4 空白 80% | 幽灵新建卡 | §5.4 |
| T1 任务页无筛选 | 页头 tabs + 时间分组 | §1.4 |
| S1-1 底部裁切 | `padding-bottom: var(--shell-bottom-pad)` | §1.2 |
| S1-2 浮动条压卡 | 浮动条改 `sticky bottom-4` 且页面加 `--shell-bottom-pad-float` | §1.2 |
| S1-3 开关退化 | `Switch` 高 22 宽 40、`aria-label` 必填、状态文字 13px 放左侧 | §12 |
| S1-4 描述 12px | 卡片描述统一 `13px / 1.55`（中文下限） | §12 |
| U1-1 Total granted 0 | 语义修正：`granted = 累计充值`，与余额并列展示 | 后端/前端 |
| U1-2 价格块溢出 | 价格块 `p-3`，容器 `gap 8`，末块 `pr-3` | 前端 |
| U1-3 余额列重复 | 列名改「该笔后余额」并说明 | 前端 |
| U1-4 无趋势图 | 30 天折线 | §6.5 |
| U1-5 时间格式 | 全部走 `useFormatters` | 前端 |
| U1-6 无外框 | §4 | 前端 |
| A1assets-1 竖图裁切 | `object-contain` + 卡纸底 | §3.3 |
| A1assets-2 图标基线 | 底栏 32px 固定 + 28×28 图标按钮 | §3.4 |
| A1assets-3 筛选断裂 | 筛选移入页头 tabs，主按钮留在页头 actions | §1.4 |
| G1 设置无分区 | 左导航 184 + 右列 720 两列 | §1.6 |
| M1 团队页异源 | 去 hero 带，走标准页头 | §1.6 |
| D1-1 指标重复 | 去掉第二行 `Pool normal`，改「今日消耗 / 昨日对比」 | 前端 |
| D1-2 整页空白 | 指标卡下加 14 天柱状 + 最近动态列表 | §6.5 |
| D1-3 消耗无单位对比 | `consumed_today` 补「积分」与 `vs 昨日 ±x%` | 前端 |
| D1-4 侧栏激活对比低 | 激活项改 `bg-brand` + `text-text-inverse`（对比 ≈12:1） | §12 |
| D2-1 表格无框 | §4 | 前端 |
| D2-2 角色纯文本 | Badge 化 | §4.2 |
| D2-3 按钮孤立 | 主按钮进页头 actions | §4.4 |

---

## 12. 组件状态矩阵（v3 收敛）

| 组件 | default | hover | focus-visible | active | disabled | loading | error | empty |
|---|---|---|---|---|---|---|---|---|
| Button | 墨黑渐变 / 白字 | `brightness(1.1)` + `shadow-sm` | `ring-2 ring-focus-ring offset-2` | `brightness(.95)` | `opacity .4 + saturate(.5)` | 16px spinner + 文案不变（宽度锁定） | — | — |
| Card | `1px border70 + shadow-sheet` | `-2px` + `border-strong` + `shadow-lift` | `ring-2 ring-focus-ring`（可点卡必加 `tabIndex=0`） | `scale .995` | — | 骨架块替换内容，高度不变 | 边框换 `--color-danger`，右上角 `AlertCircle` | — |
| Table row | 白底 | `bg-surface-hover` 120ms | 整行焦点环内描边 | 选中 `bg-accent-soft` | — | 5 行骨架 56px | 行内 `Badge danger` | 表格内 EmptyState 320px |
| Input | `bg-surface + border` | `border-strong` | `ring-2` | — | `bg-bg-subtle + text-tertiary` | — | `border-danger` + 下方 12px 具体错误文案 | — |
| Switch | 40×22，off `bg-border-strong` | `+shadow-xs` | `ring-2` | 滑块 `scale .96` | `opacity .4` | 保存中禁用 + 12px spinner | 回退原值 + toast | — |
| Tabs | 见 §1.4 | `text-text` | `ring-2` | 指示条 `scaleX` | — | 内容区骨架 | — | — |
| EmptyState | 见 §5 | 行动按钮 hover | 图形容器不聚焦，按钮聚焦 | — | — | — | — | 自身即空态 |

**文案下限**：卡片描述 `13px`、辅助说明 `12px`、正文 `14–15px`。中文低于 `12px` 会糊
（审计 S1-4 的 12px 硬伤就是这条）。

---

## 13. 给前端的实现清单（按改动收益排序）

1. **`PageShell.tsx`**：加 `tabs?: ReactNode` 插槽 + sticky 包裹层 + `data-stuck` 监听；容器改三档 gutter + `max-w-[var(--shell-max)]`。
2. **`AdminShell.tsx`**：删掉自建 header 与内容容器，直接渲染 `<PageShell>`（保留侧栏）。
3. **`routes/skills.tsx:131`**：`max-w-5xl p-6` 换 `PageShell`，tabs 移到页头，容器加 `pb-[var(--shell-bottom-pad-float)]`。
4. **`routes/team.tsx:89,184`**：删 `cs-team-hero` 通栏带，改 `PageShell`；英雄区只在团队详情页保留。
5. **`routes/settings.tsx`**：改两列（`grid-cols-[184px_1fr] gap-8`），右列 `max-w-[720px]`，补分区标题与危险区。
6. **`components/ui/table.tsx`**：`TableHead` 高 40 → 44、`TableCell` 52 → 56；新增 `TableCard`（外框 + 裁剪层）与 `TablePager`（sticky 吸底）。
7. **`components/ui/empty-state.tsx`**：图形从 56 圆改 72 方（radius 16 / dashed 可选）；加 `hints?: {icon,text}[]` 与 `secondaryAction`；`min-h-[320px]`；加 `.cs-glyph-in`。
8. **`components/ui/card.tsx`**：`rounded-[16px]` 保持，padding 20，加 `media` 变体（`p-0` + 卡纸托盘）。
9. **新增 `components/ui/chart.tsx`**：手写 SVG 折线/柱状/mini 趋势，全部读 `--chart-*`；空数据态按 §6.4。
10. **`/admin` 概览**：删重复指标 + 加 14 天柱状 + 最近动态；侧栏激活项改墨黑底白字。

---

## 14. 验收（自查脚本建议）

> 本机没有 `rg`，下面的命令用 `grep -rEn` 等价执行即可。

```bash
# 1. 无 emoji 作功能图标（应输出 0 行）
grep -rEn '[\x{1F300}-\x{1F9FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}]' frontend/src --include='*.tsx'

# 2. 无第二套图标库 / 无裸 hex（token 文件本身除外）
grep -rEn "react-icons|@heroicons|@tabler" frontend/src
grep -rEn '#[0-9a-fA-F]{3,8}' frontend/src --include='*.tsx' | grep -vE '#fff|#000'

# 3. 无禁用容器宽度（应为 0）
grep -rEn 'max-w-5xl|max-w-6xl|\[1120px\]|\[1240px\]|\[1480px\]' frontend/src

# 4. 无动画布局属性（应为 0）
grep -rEn 'transition-\[(width|height|top|left|margin|padding)' frontend/src

# 5. 非 4px 倍数间距抽查
grep -rEn '\b(p|m|gap|px|py|mt|mb|ml|mr)-\[(?!4|8|12|16|20|24|32|40|48|64|80)\d+px\]' frontend/src
```

第 6 项才是这次改造的**唯一判据**，必须用浏览器实拍：
1440 视口下跑一遍 21 个路由，取每页 `h1` 的 `getBoundingClientRect().x`，
**必须全部等于 128**（`/workspace` 与 `/` 除外）。改前这组值是
140 / 232 / 176 / 296 四种，改后只允许一种。
