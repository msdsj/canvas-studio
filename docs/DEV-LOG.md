# Canvas Studio 开发日志（DEV-LOG）

> 用途：**按时间顺序**记录「什么时候干了什么、完成了什么、改了哪些文件、如何验证」。
> 规则：
> - 每完成一个需求 / 一个大功能，**必须**在本文件追加一条时间线记录，并link到 `docs/changes/` 下的专题文档。
> - 专题文档写「背景 → 根因 → 方案 → 改动文件 → 验证方式 → 遗留问题」。
> - 维护人：交付总监（齐活林）· 记录粒度 = 一个可独立验收的功能块。

**服务地址**：前端 http://localhost:27180 · 后端 27181 · 网关 27182 · 上游 chatgpt2api 3000
**超管账号**：`admin@canvas.studio` / `Admin@12345`

---

## 2026-10-16（项目首日）

### ① 团队协作规范与交付流程（14:00 前后）
- **完成**：SOP 协作规范、PRD、UI 设计稿、系统架构（8 批次 40 任务）、代码摘要、测试报告
- **产出**：`docs/00-team-workflow.md`、`01-prd.md`、`01b-ui-design.md`、`02-architecture.md`、`03-code-summary.md`、`04-test-report.md`
- **验收**：文档齐备，三组件（frontend/backend/gateway）可独立部署

### ② 冒烟测试与问题分级（17:00 前后）
- **完成**：API + UI + 交互全链路冒烟测试，输出分级问题清单
- **产出**：`docs/06-smoke-test-report.md`

### ③ 区域编辑（框选 + 编号红框 + 分点提示词）（17:30–18:50）
- **完成**：画布内框选多区域 → 自动生成带编号的红框 mask → 一次提交分点提示词
- **改动**：
  - `backend/app/services/generate_service.py`：`_composite_edit_result`（框外像素级不变）、`_region_change_checks`（漏改检测）
  - `backend/app/routers/generate.py`：edit 端点支持 region 对象/数组
  - `frontend/src/components/canvas/canvas-helpers.ts`：`buildMultiRegionSelection`（编号红框：双层描边 + 序号字号自适应）
- **专题**：`changes/2026-10-16-region-edit.md`

### ④ 涂鸦编辑器（19:00–19:30）
- **完成**：原生 Canvas 2D 涂鸦层（画笔/橡皮/5 色/3 档粗细/撤销/重做/清空）+ 尺寸显示 + 提交上游
- **改动**：`frontend/src/components/canvas/CanvasDoodle.tsx`（新增）
- **踩坑**：跨域图片污染 canvas → `fetch → blob → objectURL` 同源化解决
- **专题**：`changes/2026-10-16-doodle-editor.md`

### ⑤ 编辑 = 涂鸦统一（19:30–19:40）
- **完成**：取消「编辑/涂鸦」双入口，统一为一个；框选模式更名为「多区域标注」并移入左栏
- **改动**：`WorkspaceView.tsx`（双击画布图 → 涂鸦）、`ChatPanel.tsx`、`WorkspaceLeftbar.tsx`
- **专题**：`changes/2026-10-16-doodle-editor.md`

### ⑥ 编辑态「不改布局」重构 + 落画布方案（19:45–20:05，**已回滚**）
- **做过的**：涂鸦层从全屏遮罩改为画布内透明叠加层；结果卡点编辑时把图落到画布并贴合
- **用户反馈**：「不需要这么麻烦，直接下载图 → 点编辑 → 涂鸦 → 提交」
- **回退**：`edit:open` 恢复极简（probe 尺寸 → 直接进涂鸦），删除 `viewportCenterScene`、恢复 `addImageToCanvas` 原签名
- **保留**：`CanvasDoodle` 的透明叠加层形态（满足"不改布局"要求）
- **教训**：不要给简单交互引入隐式副作用（自动往画布加图）

### ⑦ 上游链路修复：DEMO 占位图（20:10–20:35）★ 重要
- **现象**：所有生图结果都是占位图（红字 CANVAS STUDIO · DEMO），但任务状态显示成功
- **根因 1**：网关 `make_client` 给**本地回环调用**（gateway→localhost:3000）也挂了 7890 VPN 代理 → 请求被劫持失败
- **根因 2**：backend 只在启动时推一次配置，单独重启网关 → 上游 Key 退回默认值 → 上游 401
- **改动**：
  - `gateway/app/upstream.py`：新增 `_is_loopback()`，回环地址永不挂代理
  - `gateway/app/services/image_router.py`：demo 回退前打 warning 日志（保留，便于以后排查）
  - `backend/app/services/scheduler.py`：新增 `_config_sync_job`（60s 周期推送网关配置）
- **验证**：网关直调 `demo=false`；平台端到端出真图（橘猫，1254×1254）
- **专题**：`changes/2026-10-16-upstream-demo-placeholder.md`

### ⑧ 右栏对话卡片截断修复（20:40–20:50）
- **现象**：右栏任务卡被裁（按钮行超宽、图片撑爆容器）
- **根因**：ChatPanel 用 Radix ScrollArea，其 Viewport 内层是 `display:table; min-width:100%`，大图自然宽把内容撑开
- **改动**：
  - `frontend/src/components/ui/scroll-area.tsx`：Viewport 加 `min-w-0` + 覆盖内层 table
  - `frontend/src/components/chat/GenerationResultCard.tsx`：卡片根加 `w-full min-w-0`
  - `frontend/src/components/layout/WorkspaceRightPanel.tsx`：aside 加 `min-w-0 overflow-hidden`（兜底）
- **验证**：按钮行 `scrollWidth == clientWidth == 321`，右栏无溢出
- **专题**：`changes/2026-10-16-chat-panel-overflow.md`

### ⑨ 生成结果落画布修复（20:50–21:10）
- **现象**：图生成了（右栏有图），但画布上"看不到"
- **根因 A**：自动落画布只监听 `events.emit('tasks:changed')`，而任务完成时前端并不发这个事件（轮询只更新 UI）→ 图永不落画布
- **根因 B**：新图按网格顺排在画布右侧（x=800/1160），**落在可视区之外**，用户看不到
- **改动**：
  - `WorkspaceView.tsx`：自动落画布加 8s 兜底轮询
  - `canvas-helpers.ts`：恢复 `viewportCenterScene()`，新图直接落在**视口中心**
  - `WorkspaceView.tsx`：手动【加入画布】同样落在视口中心
- **专题**：`changes/2026-10-16-canvas-autoplace.md`

### ⑩ 刷新后画布空白修复（21:00–21:10）
- **现象**：画布内的图在**刷新页面后全部消失**（DB 里 elements/files 都完好）
- **根因**：持久化的元素是平台自造对象，缺 Excalidraw 0.18 必需字段（`index`/`fractionalIndex` 等），restore 阶段被整体丢弃
- **改动**：`frontend/src/components/canvas/CanvasExcali.tsx` —— 初始数据统一走官方 `restoreElements()` 规范化
- **专题**：`changes/2026-10-16-canvas-autoplace.md`

### ⑪ 图片编辑链路重构 + 类 Figma 图层面板 + 导出 PNG/JPG（21:20–22:40）★ 本轮
- **完成**：① 统一图片编辑层（框选编号红框 + 画笔/橡皮 + 单一提示词 → 图生图）；② 单击选中图片即进入编辑（替代双击）；③ 类 Figma 图层面板（查看/选中/层级/显隐/锁定/删除）；④ 上传流程内置提示词配置（预设 + 落库回填）；⑤ AI 出图统一 PNG（含 JPEG→PNG 归一化）；⑥ 导出 PNG/JPG（客户端真实渲染）；⑦ 冗余清理（删 3 个组件 + 3 个废弃事件 + 2 处重复入口）
- **改动**：
  - 新增 `frontend/src/components/canvas/{ImageEditLayer,LayerPanel,UploadPromptDialog}.tsx`
  - 重写 `WorkspaceView.tsx` / `canvas-helpers.ts` / `CanvasExport.tsx` / `ImagePreviewPanel.tsx` / `ChatPanel.tsx`
  - 后端 `generate_service.to_png()`、`assets.py` 提示词入参与 `/assets/prompt-presets`、`config_service` 提示词配置
  - 删除 `CanvasDoodle.tsx` / `CanvasMagicGenerator.tsx` / `chat/RegionSelector.tsx` / `ImageNode.tsx`
- **过程中修复的真实缺陷**：`Maximum update depth exceeded` 白屏（onChange 无限回灌）、图层选中不回灌（程序化 updateScene 不触发 onChange）、图层显隐/锁定不生效（未 bump version）、两条工具栏重叠
- **验证**：`tsc` 0 error · `eslint` 0 error · `vite build` ✓ · 后端 `pytest` **89 passed** · API 端到端 **19/19** · 真实浏览器 UI **20/20**
- **专题**：`changes/2026-10-16-canvas-layers-edit-refactor.md` · **测试报告**：`08-full-flow-test-report.md`

---

## 待办 / 遗留

| 级别 | 事项 | 说明 |
|---|---|---|
| P1 | 前端 UI 自动化测试 | 已补 `e2e/ui_verify.mjs`（真实浏览器 20 项）；可继续扩展主题/i18n/响应式四档 |
| P1 | 真实上游接入验证 | 本轮用 mock 上游（返回 JPEG）验证全链路；替换线上 URL+Key 后需复跑 `e2e/verify_flow.py` |
| P2 | 多选批量操作 | 图层面板当前仅单选，框选多元素后批量操作待补 |
| P2 | 图层拖拽排序 | 现为按钮式上移/下移 |
| P3 | 编辑层支持旋转图 | 旋转元素目前用外接盒近似定位 |
| ~~P2~~ | ~~临时诊断钩子~~ | ✅ 已移除 `window.__canvasApi` |
| ~~P2~~ | ~~清理历史数据~~ | ✅ 已清理画布历史残留元素 |
