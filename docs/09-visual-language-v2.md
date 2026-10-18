# canvas-studio 视觉语言 v2「工作室纸感」

> 设计系统专家：彩格调 · 2026-10-17
> 取代 `01b-ui-design.md` §1–§4 的「专业克制 SaaS 审美（Linear / Vercel / Notion）」
> 本文只交付**规范与令牌**，不改 `frontend/src/styles/tokens.css`（由原型构建师落码）

---

## A. 设计系统选型

### 三套候选

| 方案 | 设计系统 | 匹配度 | 特征 | 风险 |
|------|---------|--------|------|------|
| A | **Framer** | ★★★★★ | 设计师原生的自信：超大 display 字、图像占满版面、表面层级靠明度差而非描边、极简工具条 | 原版纯黑 + Framer Blue 会偏「科技创业公司」，直接照搬会变成另一种 to-B |
| B | **Warm Editorial**（通用起始） | ★★★★☆ | 纸底、大留白、衬线 display、细线分隔，天然「工作室/印刷品」气质 | 只有排版语言，没有工具界面的密度与状态规范，工作台会撑不起来 |
| C | **Clay** | ★★★☆☆ | 手工温度、奶油底、有机形状、手绘插画，最贴「手工感」 | 偏 whimsical/可爱，做电商美工的专业修图工具会显得不严肃；且是 CRM，缺画布型布局范式 |

（另评估未入选：**Miro** — 无限画布范式最贴，但暖黄主色会抢图；**Figma** — 灰阶太中性，正是要推翻的方向；**Airbnb** — 摄影优先很好，但 marketplace 的卡片瀑布流与工作台无关。）

### 推荐：以 **Framer** 为骨架，用 **Warm Editorial** 的材料感重做表面

Framer 是唯一「设计师一眼认得出是给设计师的」的系统，且它的首页就是作品本身——这正是本产品需要的姿态。但必须做 6 处定制，不能原样搬：

1. **换骨不换皮**：保留 Framer 的 display 字号跨度、图像满版、明度分层逻辑；丢掉纯黑 `#000` 与 Framer Blue。
2. **底色从「屏幕白」换成「纸」**：整体色相移到暖区（H 70–85°），明度压到 96–98%，饱和度 C ≤ 0.012。
3. **主色从蓝换成陶土橙** `#B5502C`——手工、温、不属于任何企业安全色系。
4. **新增第二功能色靛蓝** `#3D5A80`，只服务「选区/几何」，永不上按钮——把「人的动作」与「机器的精确」分成两套色。
5. **卡片定义顺序倒转**：明度差 > 阴影 > 描边。Framer 是「面」，我们要「纸片」。
6. **字号整体上抬**：正文 15px 起，display 用衬线（Instrument Serif）——衬线是「非后台」最快的信号。

---

## B. 设计令牌

### B.1 色彩主张

**一句话**：底色是纸，字是墨，人的动作是陶土，机器的边界是靛。

- 为什么是**陶土橙**而不是别的：创作者对「橙」的联想是暖、手、颜料、陶土、日落；对企业软件是警示。陶土橙 `#B5502C` 是烧过的赭石，低明度、中等饱和，做按钮有分量但不刺眼，做链接在纸底上 4.98:1。
- 为什么**必须有第二个色**：产品的核心动作是「框选 + 说话」——框选是几何的、冷的、精确的；说话是人的、暖的、模糊的。一个色表达不了两种语义。所以：**陶土橙 = 人的输入（按钮/链接/选中/当前步骤），靛蓝 = 选区几何（框线/手柄/裁切参考线）**。规则铁律：靛蓝永不出现在按钮上，陶土橙永不做大面积铺底。
- **纸感 vs 屏幕感**的六个技术手段（这是本次最关键的差别）：
  1. 底色用暖色相（H≈82°）而非中性/冷灰；`#F8F5F0` 而不是 `#F7F8FA`（后者偏蓝 = 屏幕）。
  2. **表面比底更亮**：`bg #F8F5F0` → `surface #FFFDFA` → `raised #FFFFFF`。像纸叠纸，不是卡片浮在灰上。
  3. 阴影一律用**暖棕** `rgba(32,26,18,α)`，永不用纯黑。纯黑阴影是屏幕语言。
  4. 描边是**暖发丝线** `#E7E0D4`，1px，只用于密集 UI；卡片不靠它定义。
  5. 图片容器用 **3px 近直角** + 白色衬边（`--color-mat`），像相纸压在卡纸上；UI 容器用 14–20px 软角。这个「硬边图 + 软边界面」的对比是工作室感的来源。
  6. 可选：叠一层 3.5% 不透明度的 SVG 噪点（`--texture-paper`），让纯色块不再是纯数字色。
- **背景不抢图**的量化约束：所有大面积底色 C ≤ 0.012（几乎无彩），canvas 与 surface 明度差只留 3–5%。这样任何照片贴上去，人眼对它的色温判断不被环境带偏。

### B.2 亮色主题

| Token | HEX | OKLCh | 用途 |
|-------|-----|-------|------|
| `--color-bg` | `#F8F5F0` | `oklch(97.1% 0.007 82)` | 页面纸底 |
| `--color-bg-subtle` | `#F1ECE3` | — | 分区、凹陷区 |
| `--color-surface` | `#FFFDFA` | — | 卡片/面板（比纸底亮一档） |
| `--color-surface-raised` | `#FFFFFF` | — | 浮层/弹窗 |
| `--color-surface-hover` | `#F3EEE6` | — | 可交互项 hover |
| `--color-canvas` | `#F0EBE1` | — | 无限画布底（比纸底深一档，让图片浮起） |
| `--color-canvas-dot` | `#D9D1C2` | — | 画布点阵 |
| `--color-mat` | `#FFFFFF` | — | 图片衬边（相纸白） |
| `--color-text` | `#201C17` | `oklch(22.9% 0.011 74)` | 主文本（暖墨，非蓝黑） |
| `--color-text-secondary` | `#5C5449` | — | 次要文本 · 7.33:1 |
| `--color-text-tertiary` | `#766D60` | — | 元数据/占位 · 5.01:1 |
| `--color-text-faint` | `#A2988A` | — | **仅非文字**（图标/分隔） |
| `--color-text-inverse` | `#FFFDFA` | — | 深底反白 |
| `--color-border` | `#E7E0D4` | — | 常规发丝线 |
| `--color-border-faint` | `#EFE9DF` | — | 表格行线 |
| `--color-border-strong` | `#D6CDBD` | — | 输入框描边 |
| `--color-brand` | `#B5502C` | `oklch(55.4% 0.140 40)` | 主按钮/链接/选中 |
| `--color-brand-hover` | `#9C4223` | — | hover |
| `--color-brand-active` | `#853718` | — | active |
| `--color-brand-subtle` | `#F7E9E1` | — | 选中浅底/标签 |
| `--color-brand-text` | `#8F3D1F` | — | 浅底上的品牌字 |
| `--color-select` | `#3D5A80` | `oklch(46.2% 0.072 256)` | 选区语义（框线/标签） |
| `--color-select-soft` | `#E8EDF4` | — | 选区浅底 |
| `--color-select-line` | `#4A7BE0` | — | 画布上选区框线/手柄（照片上也可见） |
| `--color-success` | `#3F7350` | — | 成功 · 5.11:1 |
| `--color-success-subtle` | `#EAF1EA` | — | 成功浅底 |
| `--color-warning` | `#8F6113` | — | 警告/额度低 · 4.97:1 |
| `--color-warning-subtle` | `#F8EEDC` | — | 警告浅底 |
| `--color-danger` | `#A32E38` | — | 错误/删除 · 6.43:1 |
| `--color-danger-subtle` | `#F9E7E4` | — | 危险浅底 |
| `--color-info` | `#3D5A80` | — | 信息 · 6.50:1 |
| `--color-focus-ring` | `#B5502C` | — | 2px 聚焦环 |

**对比度实测（脚本逐对验算，WCAG 2.1 相对亮度公式）**

| 前景 on 背景 | 比值 | 判定 |
|---|---|---|
| `text` on `bg` / `surface` | 15.57 / 16.68 | AA |
| `text-secondary` on `bg` / `surface` | 6.85 / 7.34 | AA |
| `text-tertiary` on `bg` / `surface` | 4.68 / 5.01 | AA |
| `text-tertiary` on `canvas` | 4.28 | **仅大字号/非文字** |
| `text-secondary` on `canvas` | 6.27 | AA |
| `brand` on `bg` / `surface` | 4.65 / 4.99 | AA |
| `text-inverse` on `brand` | 4.99 | AA |
| `brand-text` on `brand-subtle` | 6.20 | AA |
| `select` on `bg` | 6.50 | AA |
| `success` / `warning` / `danger` on `bg` | 5.11 / 4.97 / 6.43 | AA |
| `select-line` on `canvas`（非文字 3:1 线） | 3.40 | 通过 |
| `select-line` on 白色照片（非文字） | 4.04 | 通过 |
| `brand` on `canvas` | 4.26 | **不达 4.5，画布上用 `brand-text`** |
| `text-faint` on `bg` | 2.61 | **仅非文字**（图标/分隔） |
| `border` on `bg` | 1.21 | 装饰线，非信息承载 |

两条落地提醒：**① 画布上的文字一律用 `text-secondary`，不要用 `text-tertiary`（4.28 不达标）；② 画布上的品牌色文字用 `brand-text`（#8F3D1F），不要用 `brand`（4.26 差一点）。**

### B.3 暗色主题（暗房，不是反相）

| Token | HEX | 说明 |
|-------|-----|------|
| `--color-bg` | `#141210` | `oklch(18.4% 0.005 68)` 微暖墨黑 |
| `--color-bg-subtle` | `#1B1815` | 分区 |
| `--color-surface` | `#1B1815` | 面板 |
| `--color-surface-raised` | `#232019` | 浮层 |
| `--color-surface-hover` | `#2A2620` | hover |
| `--color-canvas` | `#0E0C0A` | **画布比面板更暗**（关系反转） |
| `--color-canvas-dot` | `#2A2620` | 点阵 |
| `--color-mat` | `#201C18` | 图片衬边 |
| `--color-text` | `#F2EDE6` | 暖白 16.0:1 |
| `--color-text-secondary` | `#B5ABA0` | 8.27:1 |
| `--color-text-tertiary` | `#8C8378` | 4.74:1 |
| `--color-text-faint` | `#6A6259` | 仅非文字 |
| `--color-text-inverse` | `#141210` | |
| `--color-border` | `#2E2921` | |
| `--color-border-faint` | `#26221B` | |
| `--color-border-strong` | `#423A30` | |
| `--color-brand` | `#E8875C` | 提亮陶土 6.78:1 |
| `--color-brand-hover` | `#F09A72` | |
| `--color-brand-active` | `#F7AC88` | |
| `--color-brand-subtle` | `#3A241A` | |
| `--color-brand-text` | `#F0A07C` | |
| `--color-select` | `#7FA3DC` | 6.88:1 |
| `--color-select-soft` | `#1E2836` | |
| `--color-select-line` | `#8DB2F0` | |
| `--color-success` | `#7FB894` | 7.73:1 |
| `--color-success-subtle` | `#16241A` | |
| `--color-warning` | `#E0B45C` | 9.14:1 |
| `--color-warning-subtle` | `#2B2415` | |
| `--color-danger` | `#EF8A96` | 7.37:1 |
| `--color-danger-subtle` | `#2C1719` | |
| `--color-info` | `#7FA3DC` | |
| `--color-focus-ring` | `#E8875C` | |

**两套主题的关系（5 条规则）**

1. **色相不变，只调明度与饱和**：品牌色 H 40° 在暗色里保持 40°，L 从 55% 提到 72%，C 从 0.14 降到 0.13。不做反相。
2. **明度关系翻转**：亮色里 surface 比 bg 亮（纸叠纸）；暗色里 canvas 比 surface 暗（画布下沉、面板上浮），让图片成为画面里唯一的亮源。
3. **暗色不用描边分层，用「受光边」**：`inset 0 1px 0 rgba(255,240,225,.06)` 模拟纸边受光，比加亮描边更像纸。
4. **暗色阴影靠距离不靠黑度**：扩散半径 ×1.6，不透明度 ×0.7。
5. **暗色主按钮是亮陶土底 + 深墨字**（不是白字）；暗色禁用纯 `#000` 与纯 `#FFF`。

### B.4 字体

```css
--font-display: "Instrument Serif", "Source Serif 4", "Songti SC", "Noto Serif SC",
                Georgia, "Times New Roman", serif;
--font-sans: "Plus Jakarta Sans", "PingFang SC", "Noto Sans SC", "Hiragino Sans GB",
             "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
--font-mono: "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;
```

- **display 用衬线**：Instrument Serif（单字重 400，高对比，编辑感强）。中文由 Songti SC / Noto Serif SC 承接。**只在 H1/display 用**，不用于 UI——这样中文只多加载几十个字形，成本可控。
- **正文不用 Inter**：Inter 是最强的 to-B 信号。换 Plus Jakarta Sans（人文几何，a/g 有手工细节），中文走 PingFang SC / Noto Sans SC。
- **中文行高比英文多 0.1**：中文正文行高 1.72（英文 1.6 即可），因为汉字是满格方块，视觉密度更高。

| 级别 | Token | 字号 / 行高 | 字重 | 字距 | 用途 |
|------|-------|------------|------|------|------|
| Display | `--text-display` | 56 / 1.06（clamp 40→72） | 400 衬线 | -0.02em | Hero 主标题 |
| H1 | `--text-h1` | 40 / 1.14（clamp 32→48） | 400 衬线 | -0.018em | 页面主标题 |
| H2 | `--text-h2` | 28 / 1.24 | 500 sans | -0.012em | 章节标题 |
| H3 | `--text-h3` | 22 / 1.36 | 600 sans | -0.006em | 小节标题 |
| Lead | `--text-lg` | 17 / 1.68 | 400 | 0 | 导语段落 |
| **Body** | `--text-body` | **15 / 1.72** | 400 | 0 | **正文下限** |
| UI | `--text-ui` | 14 / 1.5 | 500 | -0.005em | 按钮/标签/表单 |
| Caption | `--text-caption` | 13 / 1.45 | 400 | 0 | 仅元数据（时间/计数） |
| Micro | `--text-micro` | 12 / 1.35 | 500 | 0.02em | 徽章/角标 |
| Caps | — | 12 / 1.3 | 600 | 0.08em | 全大写小标签 |

> 13px 及以下**不得用于段落**，只能用于元数据与徽章。

### B.5 间距

4 的倍数序列：`4 8 12 16 20 24 28 32 40 48 64 80 96 120 160`

三个大留白档位（这是「呼吸」的刻度）：

| Token | 值 | 用途 |
|-------|-----|------|
| `--space-block` | 64px | 标题与其内容之间（块内节奏） |
| `--space-section` | 112px | 章节之间（桌面默认），移动 64px |
| `--space-breath` | 168px | Hero 上下 / 关键转折，一屏一口气 |

### B.6 圆角 / 阴影 / 描边

```css
--radius-sheet: 3px;   /* 图片、画布素材、缩略图 —— 相纸直角 */
--radius-xs: 6px;      /* 徽章 */
--radius-sm: 10px;     /* 小控件 */
--radius-md: 14px;     /* 按钮 / 输入框 */
--radius-lg: 20px;     /* 卡片 / 面板 */
--radius-xl: 28px;     /* 模态 / Hero 卡 */
--radius-full: 9999px;
```

**「浮起的纸片」阴影**（一律暖棕，绝不用纯黑）：

```css
--shadow-sheet:  0 1px 1px rgba(32,26,18,.04), 0 2px 6px -1px rgba(32,26,18,.05);
--shadow-lift:   0 2px 4px -1px rgba(32,26,18,.05), 0 10px 24px -6px rgba(32,26,18,.10);
--shadow-float:  0 4px 8px -2px rgba(32,26,18,.06), 0 18px 40px -10px rgba(32,26,18,.14);
--shadow-drag:   0 8px 16px -4px rgba(32,26,18,.10), 0 32px 64px -16px rgba(32,26,18,.22);
--shadow-paper-edge: inset 0 1px 0 rgba(255,255,255,.7);   /* 亮色：纸边上受光 */
```

层级定义顺序（**必须遵守**）：① 明度差（surface 比 bg 亮）→ ② 阴影 → ③ 描边。描边永远不作为卡片的唯一边界。

聚焦环（双环，任何底色都成立）：

```css
--ring-focus: 0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-focus-ring);
```

### B.7 动效

```css
--ease-out: cubic-bezier(.22,1,.36,1);        /* 纸片落下：快起慢收 */
--ease-in-out: cubic-bezier(.65,0,.35,1);     /* 位移/展开 */
--ease-soft-spring: cubic-bezier(.34,1.4,.64,1); /* 仅 chip/开关轻微回弹 */
--dur-1: 120ms;  /* 颜色/hover */
--dur-2: 200ms;  /* 位移/透明度 */
--dur-3: 320ms;  /* 面板/浮层入场 */
--dur-4: 480ms;  /* 首页 section 进场 */
```

禁止：>600ms 的过渡、无限循环发光、loading 之外的持续动画、`prefers-reduced-motion` 下不降级。

---

## C. Logo 方案

通用约束：`viewBox="0 0 48 48"`、只用 `currentColor`、无渐变、无内联固定色、stroke 4 / round cap。

### 概念 1 ·「入框一笔」The Line That Enters（**推荐**）

框的左边整条敞着，一句话从外面进来，停在框内。

```svg
<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
     role="img" aria-label="canvas-studio">
  <g stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 18 A6 6 0 0 1 18 12 H30 A6 6 0 0 1 36 18 V30
             A6 6 0 0 1 30 36 H18 A6 6 0 0 1 12 30"/>
    <path d="M5 24 H17"/>
  </g>
</svg>
```

- 构造：24×24 圆角框（rx 6），左侧整条边省略（开口 y=18→30），形成「C」形；一条 4px 圆头横线从框外 x=5 水平进入，穿过开口，笔尖停在框内 x=17。
- 32px 下：开口高度 ≈8px、线宽 ≈2.7px、线上下各留 ≈4px 空隙、线头伸入 ≈3.3px —— 全部可辨。缩到 24px 仍读得出「线进了框」，缩到 16px 时开口收窄但轮廓不糊（这是三个方案里 16px 表现第二好的）。
- 视觉居中：整体墨迹实际偏左约 3px，落地时按**光学居中**把整体右移 2–3px，不要几何居中。
- 推荐理由：**它把「框选」和「说话」写进了同一个图形**——框是选区，进去的那条线就是那句人话。更关键的是它画的是一个**动作**而不是一个**物件**，现成图标库里没有这个形状，所以它不会像「四角星」「相机」「画笔」那样一眼被认出是通用符号。

### 概念 2 ·「引号框」Quote Frame

```svg
<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
     role="img" aria-label="canvas-studio">
  <g stroke="currentColor" stroke-width="4" stroke-linecap="round">
    <rect x="9" y="13" width="30" height="22" rx="6"/>
    <path d="M20 28.5 L23.5 19.5"/>
    <path d="M28 28.5 L31.5 19.5"/>
  </g>
</svg>
```

- 构造：横向 30×22 的框（接近 4:3，暗示「一张照片」），内部两道 45° 斜引号，斜线本身带手写笔势。
- 32px 下：两道斜线间距 ≈5.3px、线宽 ≈2.7px，可辨；但缩小到 20px 以下会糊成一块。
- 风险：两道平行斜线在极小尺寸下可能被读成「//」或阴影。

### 概念 3 ·「对位」Registration

```svg
<svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
     role="img" aria-label="canvas-studio">
  <g stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 18 V11 A3 3 0 0 1 11 8 H18"/>
    <path d="M40 30 V37 A3 3 0 0 1 37 40 H30"/>
  </g>
  <circle cx="24" cy="24" r="4.5" fill="currentColor"/>
</svg>
```

- 构造：左上与右下两个 L 形角标（印刷对位标记语言），中心一个实心圆点。
- 32px 下最稳：圆点 3px 半径、角标臂长 6.7px，是三个方案里最抗缩放的。
- 含义：精确对位、印刷厂、手工校准。缺点是与产品「框选+说话」的关联较弱，更像「取景/裁切」。

---

## D. 插画与插图艺术指导

### D.1 插画语言：**铅笔线稿 + 单色平涂**

- **形态**：2px 墨色线稿（`--color-text`），圆头圆角、允许 ±1px 的手绘抖动；填色只允许**一个**平涂色块，无边线渐变、无高光、无投影。
- **为什么**：① 线稿 + 平涂是「工作笔记/草稿本」的语言，直接对应「手工感」；② 它没有照片级细节，绝不会和用户作品抢注意力（这是本产品最重要的一条）；③ 它比矢量几何插画便宜，比 3D 渲染诚实——一个说「我就是个工具」的插画语言，比假装自己是 AI 未来更可信。
- **底材**：纸底 `--color-bg` 上叠 `--texture-paper`（3.5% 噪点），不要纯色块。
- **线宽规范**：主结构 2px、细节 1.5px、不出现 1px 以下；圆头，`stroke-linejoin: round`。
- **填充**：只允许 `--color-brand-subtle` / `--color-select-soft` / `--color-canvas` 三种之一，每张图最多用一个。

### D.2 三个具体主题

**① 首页工作流演示配图 ——「三步手势」**
- 构图：横向三联，等宽三格，格间留 48px 空白（不画分隔线）。每格：左上角一个 mono 编号（01/02/03，12px，`--color-text-tertiary`），中间是手绘线稿动作，下方一行 14px 说明。三格的动作是：① 一只手在照片上拉出一个框（框用 `--color-select` 虚线 2px）→ ② 一个空的口语气泡从框的右上角冒出（气泡内不写字，只画三条长短不一的短横线代表「一句话」）→ ③ 框内图像变成线稿的「已改」状态（框变成实线，外面加一圈 `--color-brand-subtle` 的浅色晕）。
- 颜色：`--color-text`（线）、`--color-bg`（底）、`--color-select`（选区）、`--color-brand-subtle`（完成晕）。4 色。
- 比例：整幅 1200×750（16:10），单格 336×560。

**② 结果安全区机制示意**
- 构图：一个 4:3 的相纸矩形居中（3px 直角 + `--color-mat` 衬边 + `--shadow-sheet`），从它的右侧引出两条手绘曲线：上面一条通往一个**虚线方框**（标 `--color-select`，代表「结果安全区，可回退」），下面一条通往一个**开放画布区域**（无边框，只有点阵）。两条线用箭头收尾，线宽 2px。虚线框内画一个小小的「时钟倒退」符号（一笔圆弧 + 一个箭头），不用图标库。
- 颜色：`--color-text`、`--color-bg`、`--color-select`、`--color-canvas`。4 色。
- 比例：800×600（4:3）。

**③ 空态插画**
- 构图：一张空白相纸（3px 直角，微微歪 2°），纸面上一段没画完的虚线轨迹（3 段，逐渐变淡），轨迹尽头停着一支极简的笔（只画笔杆和笔尖两条线，不画阴影），笔悬空、不接触纸面。整幅偏向画布右下，左上留大片空白放文案。
- 颜色：`--color-text`（线，主结构用 60% 不透明度的 `--color-text`）、`--color-bg`、`--color-mat`。3 色。
- 比例：1:1，400×400（移动端 240×240）。

### D.3 禁止项

- ❌ 3D 玻璃拟态小人 / 磨砂玻璃球 / 果冻质感
- ❌ 等距（isometric）科技插画、悬浮服务器、网格地面
- ❌ 渐变光球、霓虹发光线条、粒子网络、神经元/大脑
- ❌ 扁平「企业小人」（flat corporate people）、大头娃娃比例
- ❌ AI 生成的六指人手、光影不一致的伪写实
- ❌ 用品牌橙做大面积填色（单图橙色面积 ≤ 15%）
- ❌ 插画里出现可识别的第三方品牌 UI（模仿微信/PS 界面）

---

## E. 交接给原型构建师的 5 条硬约束

1. **正文段落一律 ≥15px、行高 ≥1.7**；13px 只允许出现在元数据（时间/计数/标签/徽章）上，且必须用 `--color-text-tertiary` 或更深的颜色。全站不得出现 13px 及以下的段落文本。
2. **图片容器圆角一律 3px（`--radius-sheet`），UI 容器圆角一律 ≥14px**；两者不得混用，也不得给图片加 14px 以上圆角。
3. **卡片层级用「纸面明度差 + 暖棕阴影」表达，禁止把 1px 描边当作卡片的唯一边界**；任何卡片必须至少满足 `--shadow-sheet` 或与背景明度差 ≥3% 其中之一。阴影色必须是 `rgba(32,26,18,α)`，禁止纯黑阴影。
4. **陶土橙只做交互色**：只允许出现在主按钮、文字链接、选中态、当前步骤指示四处；禁止用于大面积背景、装饰图形、插画主色。
5. **首页每个 section 上下留白 ≥112px（桌面）/ 64px（移动），Hero 上下 ≥168px**；section 之间不得用分隔线收边，只能靠留白分隔。

---

## 附：可直接落进 `tokens.css` 的完整令牌

> 现有 token 名全部保留（`--color-brand-subtle` / `--color-text-tertiary` / `--text-base` 等），只改值，避免大面积改组件。新增 token 见注释 `[NEW]`。

```css
/* canvas-studio · 视觉语言 v2「工作室纸感」 */

:root {
  /* 字体 */
  --font-display: "Instrument Serif", "Source Serif 4", "Songti SC", "Noto Serif SC",
    Georgia, "Times New Roman", serif;
  --font-sans: "Plus Jakarta Sans", "PingFang SC", "Noto Sans SC", "Hiragino Sans GB",
    "Microsoft YaHei", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --font-mono: "JetBrains Mono", "SFMono-Regular", ui-monospace, Menlo, Consolas, monospace;

  /* 字号 / 行高 */
  --text-display: 56px;   --lh-display: 1.06;
  --text-h1: 40px;        --lh-h1: 1.14;
  --text-h2: 28px;        --lh-h2: 1.24;
  --text-h3: 22px;        --lh-h3: 1.36;
  --text-lg: 17px;        --lh-lg: 1.68;
  --text-body: 15px;      --lh-body: 1.72;
  --text-base: 15px;      /* 兼容 index.css body */
  --text-ui: 14px;        --lh-ui: 1.5;
  --text-caption: 13px;   --lh-caption: 1.45;
  --text-micro: 12px;     --lh-micro: 1.35;
  --text-xs: 12px; --text-sm: 14px; --text-md: 17px; --text-xl: 28px; --text-2xl: 40px;

  /* 字重 / 字距 */
  --fw-regular: 400; --fw-medium: 500; --fw-semibold: 600; --fw-bold: 700;
  --ls-display: -0.02em; --ls-h1: -0.018em; --ls-h2: -0.012em;
  --ls-body: 0; --ls-ui: -0.005em; --ls-caps: 0.08em;

  /* 间距 */
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px;
  --space-5: 20px; --space-6: 24px; --space-7: 28px; --space-8: 32px;
  --space-10: 40px; --space-12: 48px; --space-16: 64px; --space-20: 80px;
  --space-24: 96px; --space-30: 120px; --space-40: 160px;
  --space-block: 64px; --space-section: 112px; --space-breath: 168px;

  /* 圆角 */
  --radius-sheet: 3px; --radius-xs: 6px; --radius-sm: 10px;
  --radius-md: 14px; --radius-lg: 20px; --radius-xl: 28px; --radius-full: 9999px;

  /* 纸面 */
  --color-bg: #f8f5f0;
  --color-bg-subtle: #f1ece3;
  --color-surface: #fffdfa;
  --color-surface-raised: #ffffff;
  --color-surface-hover: #f3eee6;
  --color-canvas: #f0ebe1;
  --color-canvas-dot: #d9d1c2;
  --color-mat: #ffffff;

  /* 墨 */
  --color-text: #201c17;
  --color-text-secondary: #5c5449;
  --color-text-tertiary: #766d60;
  --color-text-faint: #a2988a;      /* 仅非文字 */
  --color-text-inverse: #fffdfa;

  /* 线 */
  --color-border: #e7e0d4;
  --color-border-faint: #efe9df;
  --color-border-strong: #d6cdbd;

  /* 陶土：人的动作 */
  --color-brand: #b5502c;
  --color-brand-hover: #9c4223;
  --color-brand-active: #853718;
  --color-brand-subtle: #f7e9e1;
  --color-brand-text: #8f3d1f;

  /* 靛：选区几何（永不上按钮） */
  --color-select: #3d5a80;
  --color-select-soft: #e8edf4;
  --color-select-line: #4a7be0;

  /* 语义 */
  --color-success: #3f7350; --color-success-subtle: #eaf1ea;
  --color-warning: #8f6113; --color-warning-subtle: #f8eedc;
  --color-danger: #a32e38;  --color-danger-subtle: #f9e7e4;
  --color-info: #3d5a80;
  --color-focus-ring: #b5502c;

  /* 阴影（暖棕，禁纯黑） */
  --shadow-xs: 0 1px 1px rgba(32,26,18,.04);
  --shadow-sheet: 0 1px 1px rgba(32,26,18,.04), 0 2px 6px -1px rgba(32,26,18,.05);
  --shadow-sm: var(--shadow-sheet);
  --shadow-lift: 0 2px 4px -1px rgba(32,26,18,.05), 0 10px 24px -6px rgba(32,26,18,.10);
  --shadow-md: var(--shadow-lift);
  --shadow-float: 0 4px 8px -2px rgba(32,26,18,.06), 0 18px 40px -10px rgba(32,26,18,.14);
  --shadow-lg: var(--shadow-float);
  --shadow-drag: 0 8px 16px -4px rgba(32,26,18,.10), 0 32px 64px -16px rgba(32,26,18,.22);
  --shadow-paper-edge: inset 0 1px 0 rgba(255,255,255,.7);

  --ring-focus: 0 0 0 2px var(--color-bg), 0 0 0 4px var(--color-focus-ring);

  /* 动效 */
  --ease-out: cubic-bezier(.22,1,.36,1);
  --ease-in-out: cubic-bezier(.65,0,.35,1);
  --ease-soft-spring: cubic-bezier(.34,1.4,.64,1);
  --dur-1: 120ms; --dur-2: 200ms; --dur-3: 320ms; --dur-4: 480ms;

  --overlay: rgba(32,26,18,.42);

  /* 纸纹（可选，叠在 bg 上，3.5% 噪点） */
  --texture-paper: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='0.035'/%3E%3C/svg%3E");
}

[data-theme='dark'] {
  --color-bg: #141210;
  --color-bg-subtle: #1b1815;
  --color-surface: #1b1815;
  --color-surface-raised: #232019;
  --color-surface-hover: #2a2620;
  --color-canvas: #0e0c0a;
  --color-canvas-dot: #2a2620;
  --color-mat: #201c18;

  --color-text: #f2ede6;
  --color-text-secondary: #b5aba0;
  --color-text-tertiary: #8c8378;
  --color-text-faint: #6a6259;
  --color-text-inverse: #141210;

  --color-border: #2e2921;
  --color-border-faint: #26221b;
  --color-border-strong: #423a30;

  --color-brand: #e8875c;
  --color-brand-hover: #f09a72;
  --color-brand-active: #f7ac88;
  --color-brand-subtle: #3a241a;
  --color-brand-text: #f0a07c;

  --color-select: #7fa3dc;
  --color-select-soft: #1e2836;
  --color-select-line: #8db2f0;

  --color-success: #7fb894; --color-success-subtle: #16241a;
  --color-warning: #e0b45c; --color-warning-subtle: #2b2415;
  --color-danger: #ef8a96;  --color-danger-subtle: #2c1719;
  --color-info: #7fa3dc;
  --color-focus-ring: #e8875c;

  --shadow-xs: 0 1px 1px rgba(0,0,0,.30);
  --shadow-sheet: 0 1px 2px rgba(0,0,0,.35), 0 4px 10px -2px rgba(0,0,0,.28);
  --shadow-lift: 0 2px 6px -1px rgba(0,0,0,.40), 0 16px 38px -10px rgba(0,0,0,.45);
  --shadow-float: 0 4px 12px -2px rgba(0,0,0,.45), 0 28px 64px -16px rgba(0,0,0,.55);
  --shadow-drag: 0 10px 24px -6px rgba(0,0,0,.55), 0 48px 96px -24px rgba(0,0,0,.70);
  --shadow-paper-edge: inset 0 1px 0 rgba(255,240,225,.06);

  --overlay: rgba(0,0,0,.62);
}
```

### 需要同步补进 `frontend/src/index.css` 的 `@theme inline`（新增）

```css
  --font-display: var(--font-display);
  --color-canvas: var(--color-canvas);
  --color-canvas-dot: var(--color-canvas-dot);
  --color-mat: var(--color-mat);
  --color-select: var(--color-select);
  --color-select-soft: var(--color-select-soft);
  --color-select-line: var(--color-select-line);
  --color-text-faint: var(--color-text-faint);
  --color-border-faint: var(--color-border-faint);
  --radius-sheet: var(--radius-sheet);
  --shadow-sheet: var(--shadow-sheet);
  --shadow-lift: var(--shadow-lift);
  --shadow-float: var(--shadow-float);
  --shadow-drag: var(--shadow-drag);

  /* 字号配对写法（Tailwind 4），让 text-body 自带行高 */
  --text-display: var(--text-display); --text-display--line-height: 1.06;
  --text-h1: var(--text-h1);           --text-h1--line-height: 1.14;
  --text-h2: var(--text-h2);           --text-h2--line-height: 1.24;
  --text-h3: var(--text-h3);           --text-h3--line-height: 1.36;
  --text-body: var(--text-body);       --text-body--line-height: 1.72;
  --text-ui: var(--text-ui);           --text-ui--line-height: 1.5;
  --text-caption: var(--text-caption); --text-caption--line-height: 1.45;
```

> 注意：Tailwind 4 的 `--text-sm` 默认 14px、`--text-base` 默认 16px。若要强制正文 15px，请把 `--text-base: 15px` 一并写进 `@theme inline`，或在组件里统一改用 `text-body`。

---

*彩格调 · 2026-10-17*
