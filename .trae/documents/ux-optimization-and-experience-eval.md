# v2 · 全产品升级至可上线标准（对标 lovart.ai）· 实施计划

> 本文件为 **v2 版**，取代此前「核心逻辑零改动」的 v1。
> 用户本轮明确口径：**允许改逻辑与后端**；权限用**激活码**方案；提示词链**整体重做**；去边框**按视觉需要去**。

---

## 1. 目标与验收总纲

把 `canvas-studio`（React+TS+Vite 前端 `:27180` / FastAPI 后端 `:27181` / gateway `:27182`）整体提升到**可上线**水准，交互与视觉对标 lovart.ai。

四项总验收：
1. **视觉统一**：全站（含 `components/chat/` 与分享页）收敛到 `src/styles/tokens.css` 的语义令牌，聊天界面**移除装饰性边框线**（暗色下保留必要受光边），选项控件重建。
2. **流程无断点**：所有「需用户决策」的节点显式呈现并暂停（@引用、提示词歧义澄清、张数确认），等待动画清晰，不自动跳过。
3. **权限分级可用**：普通用户仅文生图；Pro（激活码激活）解锁画布/抠图/AI对话/润色/图生图；左下角身份条显示 `free`（带「升级 Pro」动效）或 `PRO` 徽标。
4. **回归全绿**：类型/构建/后端单测不低于基线，Chrome 自动化 E2E + Safari 关键页核验通过，无已知阻断级 bug。

---

## 2. 分阶段计划（每阶段独立回归）

### 阶段 A · 聊天 / AI 视觉重构 + 选项控件 + 分享页
- **A1 去边框极简化**：`components/chat/*` 卡片外框改「无边框 + 纸面浮起（`--shadow-sheet`）/ 必要的受光边」，与 `ui/card.tsx` 同源；暗色用 `--shadow-paper-edge` 保留一张纸的边界。
- **A2 令牌收敛**：清掉 `chat/` 下的任意值/旧尺度（`text-[9px]`、`bg-[rgba]`、`rounded-lg` 等），统一到 `text-micro/caption/ui/body` 与 `rounded-xs/sm/md`。
- **A3 选项控件重建**：废弃圆点 radio 样式，改为「可选中卡片 + 序号/推荐徽标 + 选中态青柠描边」；默认第一项标注「最推荐」。
- **A4 分享页美化**：`routes/share.$token.tsx` / `share.chat.$token.tsx` 图片网格、信息层级、页头、CTA 重做。
- **A5 右侧模块布局**：聊天记录（会话列表）/ 图片生成（结果卡）/ AI 对话（消息）/ AI 分析（步骤流）四块的间距、层次、滚动与固定区重排。

### 阶段 B · 图片 @引用机制
- 画布/结果卡/聊天结果图**点击即 @引用**：以 `@[图n]` 形式插入输入框；多选累积；引用项带小 `×` 可移除；引用后可继续输入指令。
- 提交时把引用图作为 `image_refs` 或选区上下文随请求发出；引用区与文本区视觉分离。

### 阶段 C · 用户权限体系（后端角色 + 门禁 + 激活码 + 徽标）
- **C1 后端**：`users.role` 增 `pro`；新增激活码模型/服务/路由（生成、校验、兑换→置 `role=pro`）；对受限能力（画布/抠图/AI对话/润色/图生图）加 `require_pro` 门禁，返回明确错误码。
- **C2 前端**：`useAuth` 暴露 `isPro`；受限入口对 `free` 用户置灰并给升级引导；左下角身份条 `free` → 带动效的「升级 Pro」入口；激活码弹窗（输入→激活→实时刷新徽标）；`pro` 显示 `PRO` 徽标。
- **C3 管理端**：Pro 激活码的生成/列表/禁用（对齐既有邀请码范式）。

### 阶段 D · 提示词链重做 + 生图中断等待
- **D1 原始提示词默认不改**：用户原话直发；仅当用户**主动**点「润色」才调用润色。
- **D2 不明确必弹选项**：判定不明确时**立即停**、展示等待动画、给出多个优化方向（默认第一项=最推荐）+「直接使用当前提示词不做修改」；**禁止未经确认自动替换**。
- **D3 中断/等待机制**：所有需决策节点（澄清、张数、缺少底图）显式呈现并暂停后续流程，用户选择后才继续；`compose_service` 的 `ambiguity` 步不得静默降级。

### 阶段 E · 画布体验修复 + 生成结果直加画布
- 排查并修复画布已知体验问题（拖拽/缩放/框选/图层/落点）；生成结果**一键/自动加入画布**并聚焦，去重与空位策略清晰。

### 阶段 F · 全链路回归 + 多浏览器 + 上线验收
- 静态：`tsc` 不新增错误（基线 10）；`vite build` 成功；`pytest` ≥ `111 passed, 36 skipped`。
- E2E：Chrome（`--no-sandbox --enable-unsafe-swiftshader`）跑通门禁→生成→结果落画布→@引用→澄清→Pro 解锁；Safari 核验关键页亮/暗与核心交互。
- 产出上线验收记录。

---

## 3. 关键文件

- 令牌层：`frontend/src/styles/tokens.css`（仅有必要的新增）
- 聊天模块：`frontend/src/components/chat/{ChatPanel,ChatMessage,ChatTextarea,ClarifyCard,ConfirmCountCard,GenerationResultCard,GenerationSkeleton,LatestResultDock,AnalysisSteps,ThinkingTrace,StepStream,SkillChain,SkillRunCard,EditCompareCard,PolishPopover,SkillLibraryPanel,Markdown,TaskControls}.tsx`
- 画布：`frontend/src/components/canvas/{WorkspaceView,ImageEditLayer}.tsx`
- 身份/权限：`frontend/src/components/layout/UserMenu.tsx`、`frontend/src/hooks/use-auth.ts`、`frontend/src/stores/auth.ts`、`backend/app/deps.py`、`backend/app/models/user.py`、`backend/app/routers/admin/invites.py`（激活码范式参考）
- 提示词链：`backend/app/services/compose_service.py`、`backend/app/services/polish_service.py`、`backend/app/routers/chat.py`
- 分享页：`frontend/src/routes/share.$token.tsx`、`share.chat.$token.tsx`

## 4. 风险与缓解

- **样式面广**：改动后用 1440/1024/768/390 亮+暗截图核验溢出与对比度。
- **去边框过狠**：暗色先验证，卡片与背景融合时补 `--shadow-paper-edge`。
- **权限门禁误伤**：门禁仅拦受限能力，文生图与既有免费链路必须照旧可用；错误码要可被前端识别并引导升级。
- **提示词链回归**：`compose_service` 五步契约与 `skill_runs` 落库保留，只改「改写时机」与「中断语义」。
- **基线不可退**：每阶段结束跑 `tsc`/`build`/`pytest` 并记录。
