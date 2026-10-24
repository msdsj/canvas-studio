# 全站视觉 / 动效收口 v3 · 交付说明

> 日期：2026-10-24　范围：MSDSJ AI画布 全站（21 个路由 × 亮/暗 × 桌面/移动）
> 方法：Playwright 实拍审计 → 设计规格 → 逐页改造 → 几何断言回归

---

## 一句话结论

这一轮的核心判断是：**问题不在「某个页面不好看」，而在「20 个页面各写一套壳」**。
所以先立唯一刻度，再逐页填空，最后用几何断言（而不是肉眼）证明它真的统一了。

---

## 1. 统一刻度（唯一来源：`docs/13-design-system-v3.md`）

| 项 | 值 |
|---|---|
| gutter | 20px(<640) / 32px(≥640) / 48px(≥1024) |
| 内容最大宽 | 1280px（默认）/ 1440px（宽表）/ 880px（单列） |
| 页头 | h1 30px/600、desc 14px/≤64ch、操作右对齐 gap 8、可选 tabs 行 |
| 区块节奏 | 密 24 / 常 40 / 疏 64 / 品牌页 80 |
| 卡片 | radius 16 / border 70% / shadow-sheet / padding 20 / hover −2px |
| 表格 | 表头 44px / 行 56px / hover 底色 / **分页条为表格卡的兄弟节点** |
| 空状态 | 图形 72×72 + 标题 + 说明 + 主次行动 + 提示列表 / min-height 320px |
| 动效 | hover 160 / enter 420 / exit 180 / loading 1.5s；错峰第 8 项封顶 |

**可验证结果**：1440 视口下 `/assets`、`/tasks`、`/usage` 三个页面的 h1 左沿
实测 `123 / 123 / 123`（差 0px），页头→内容间距 `16 / 16`（差 0px）。

---

## 2. 改了什么（按影响排序）

### 2.1 跨页面的结构性问题
- **背景污染**：`body` 上写死的两团环境光泄漏到所有内容页，左上角常年糊着一层黄绿雾。
  首页本就有自己的 aurora 层，摘掉 body 的即可（`docs/13` 给了证据链）。
- **六套壳**：`PageShell` 重写为 v3（gutter/宽度/页头/tabs/粘性吸顶/底部安全间距）；
  `AdminShell` 不再自建 header，内部直接复用 `PageShell`；`/team` 去掉白底通栏 hero；
  `/skills` 从自建 `max-w-5xl` 容器切到 `PageShell`。
- **导航不可见**：改造前 8 个页面的主导航全塞在左上角一个 15px 九宫格里。
  现在 ≥1280 显示水平主导航（激活项墨黑下划线），1280 以下收进下拉（触发器放大到 18px）。

### 2.2 真 bug / 真数据缺口
- 后台概览「号池正常」重复展示两次 → 删重复；补 **14 天趋势图 / 待处理 / 最近动态**。
- 用量页「累计获得 0」而余额 11504 → 后端新增 `GET /api/quota/summary`，
  `total_granted` 取真实流水（grant + admin_adjust + 未入账历史余额），现在返回 **12200**。
- `/tasks` 叫「生成记录」却只渲染进行中任务 → 改用 `GET /api/generate/tasks` 真历史，
  带状态筛选与停止/重试。
- 项目卡永远是灰色空网格 → 后端补 `cover_url` + `item_count`（真实返回 73 张），
  前端有图用图、无图用按 id 稳定的抽象纸卡。
- 资产库竖图（351×1238）被 `object-cover` 裁成方块 → CSS `columns` 瀑布流，按真实宽高比排版。
- 技能页最后一行卡片被裁、浮条压住开关 → `bottomPad="float"` + 悬浮胶囊 + 真开关。
- 画布 dock 文字折行、两组缩放控件并存 → `shrink-0 whitespace-nowrap` + 收起原生缩放岛。
- 后台用户表表头渲染出原始键 `AUTH.LOGIN.EMAIL` → 补 `users.email`；
  审计日志的机器码动作（`pool_import` 等）映射成可读文案。

### 2.3 新增能力
| 能力 | 位置 |
|---|---|
| 手写 SVG 折线/柱状图（不引三方库） | `frontend/src/components/ui/chart.tsx` |
| 概览趋势 / 待处理 / 最近动态 | `components/admin/OverviewPanels.tsx` |
| 额度汇总接口 | `GET /api/quota/summary` |
| 概览增强接口 | `GET /api/admin/overview`（新增 `series` / `pending` / `recent`） |
| 项目封面与元素数 | `GET /api/projects`（新增 `cover_url` / `item_count`） |

---

## 3. 怎么复验（工具已提交进仓库）

```bash
# 逐路由截图 + console error + 横向溢出 + 越界元素
node scripts/visual-audit.mjs --theme both --mobile --out /tmp/cs-audit

# 几何断言（不是截图比对）
node scripts/verify-ui.mjs
```

`verify-ui.mjs` 的 8 条断言（当前 **8/8 通过**）：

| ID | 断言 | 实测 |
|---|---|---|
| A1 | 内容页无环境光污染 | body 只有纸纹 |
| A2 | 三页 h1 左沿一致 | 123/123/123 |
| A3 | 页头→内容间距一致 | 16/16 |
| W1 | 画布 dock 无文字换行 | 换行按钮 0 个 |
| W2 | 只有一组缩放控件 | 可见放大按钮 1 个 |
| S1 | 技能页末行不被裁/遮挡 | clipped=false overlap=false |
| M1 | 390 宽顶栏不叠字 | /projects、/assets 均无重叠 |

---

## 4. 回归

- backend：`451 passed / 36 skipped`（含新增 `tests/test_stats_api.py` 7 例）
- frontend：`tsc --noEmit` 0 error；`vite build` 通过（输出到 `/tmp` 避免沙箱拦截）
- 全站巡检：亮/暗/移动共 **46 个页面状态 → 0 console error、0 横向溢出**
- 滚动帧率基线（4 秒脚本化滚动）：median 16.7ms / p95 16.8–30.8ms

---

## 5. 已知遗留（下一轮可做）

1. **首页叙事段仍长**：`cs-story` 钉住滚动本身占 3273px，首页整页约 9400px。
   已把演示动画的空白期从 ~2s 压到 ~0.4s，但长度需要重新编排叙事才能真正变短。
2. **硬编码中文仍有 342 处**（`components/**` 内），切到英文时才会暴露。
   本轮只修了用户直接可见的几处。
3. **审计日志动作码**只映射了已知的 18 个，新动作仍会显示原始码（有 `defaultValue` 兜底）。
4. 素材库里有一张图渲染为纯黑块，疑似透明通道 PNG 在浅色底上的显示问题，未定位。
