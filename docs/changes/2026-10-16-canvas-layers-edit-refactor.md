# 专题：图片编辑链路重构 + 类 Figma 图层面板 + 导出格式扩展

> 日期：2026-10-16 · 范围：frontend / backend / e2e · 状态：已交付并通过全流程验证
> 关联需求：① 修复图片编辑失效 + 上传内置提示词 + AI 出图统一 PNG；② 类 Figma 图层管理；
> ③ 单击进入编辑（框选/标记/修改）+ 标记图与提示词送上游图生图；④ UX 梳理去冗余；
> ⑤ 导出 PNG/JPG；⑥ 全流程测试。

---

## 一、背景与问题

| # | 现象 / 诉求 | 根因 |
|---|---|---|
| 1 | 图片编辑功能"失效" | 编辑入口割裂：① 双击画布图片进涂鸦（`WorkspaceView` 的 `onDoubleClick`）；② 左栏「多区域标注」进框选；③ 结果卡「编辑」通过 `edit:open` 事件直达涂鸦。三条路径各自为政，任一路径出问题都表现为"编辑用不了"；且 `CanvasDoodle` 的图层坐标系与画布图片不一致 |
| 2 | 无图层管理 | 画布元素只存在于 Excalidraw 内部，平台没有任何元素列表视图，元素既看不到也选不中 |
| 3 | 交互反直觉 | 双击编辑与 Excalidraw 原生"双击裁剪"冲突；同一功能多处入口；聊天面板内另有一套 `RegionSelector` 框选，与画布框选重复 |
| 4 | 导出仅 PNG/JSON | `CanvasExport` 走服务端渲染，JPG 缺失且画布渲染不精确 |
| 5 | 上游返回格式不可控 | 上游可能返回 JPEG/WEBP，平台却按 `image/png` 落库 → 后缀与内容不一致 |

---

## 二、方案

### 2.1 统一图片编辑层（新组件 `ImageEditLayer`）

一个组件承担全部图片编辑能力，替换 `CanvasDoodle` + `WorkspaceView` 内联框选叠加层：

- **框选**：在图片上拖拽生成编号红框（最多 8 个，可单独删除）；
- **画笔 / 橡皮**：直接在图上标注（5 色 × 3 档粗细，撤销/重做/清空）；
- **单一提示词**：底部输入框 + 后端下发的一键预设；
- **提交**：客户端合成「带编号红框的标记图（mask）」+「底图」+ 归一化选区 + 用户提示词 → `POST /api/generate/edit` → 上游图生图；
- **定位**：编辑层精确贴合画布上原图位置（`scene → viewport` 换算），画布平移/缩放时实时跟随；根节点 `pointer-events-none`，图片以外区域仍可操作画布。

### 2.2 单击进入编辑（替代双击）

- 画布容器捕获 `pointerdown/pointerup`，位移 < 5px 且 < 700ms 判定为"单击"；
- Excalidraw 完成选中后（`setTimeout 0`）自动进入编辑模式；
- 退出方式：点击画布空白处（选中态清空）/ 顶部【完成】/ `ESC`；
- **从图层面板点击图片同样进入编辑**，保证"任何方式选中图片 → 都是编辑"；
- 用 `onDoubleClickCapture` 拦截并消除 Excalidraw 原生"双击裁剪"，同时 CSS 隐藏其裁剪提示，避免两个互相冲突的图片编辑入口。

### 2.3 类 Figma 图层面板（新组件 `LayerPanel`）

- 按 z-order 倒序列出全部元素（图片/文本/图形/手绘…），带类型图标与名称；
- 支持：单击选中（与画布双向同步）、上移/下移一层、显示/隐藏、锁定/解锁、删除；
- 图片图层名优先取上传文件名或生成提示词前 20 字，避免"图片 1/2/3"无法辨认。

### 2.4 上传流程内置提示词配置

- 上传选图后弹出确认弹窗：图片预览 + 后端下发的常用预设（一键填入）+ 可编辑提示词；
- 提示词随资产落库（`assets.source_prompt`），进入编辑模式自动回填，避免重复输入；
- 后端新增 `GET /api/assets/prompt-presets`（返回 `template` 前缀模板 + `presets` 预设数组，可后台改）。

### 2.5 AI 出图统一 PNG

- `generate_service.to_png()`：上游返回 PNG 直接透传（不重编码），JPEG/WEBP 等统一转 PNG（保留 alpha）；解码失败退回原始字节，不阻断任务；
- `run_task` 中在区域合成/透明化之后、落库之前统一调用，落库文件名固定 `result.png` / `content_type=image/png`。

### 2.6 导出 PNG / JPG

- `CanvasExport` 改为客户端 `exportToBlob` 真实渲染画布：PNG 支持透明；JPG 白底 + quality 0.92，避免透明区域变黑；
- 选中图片在右栏「当前图片」可直接下载 PNG / JPG。

### 2.7 冗余清理

| 移除项 | 原因 |
|---|---|
| `CanvasDoodle.tsx` | 被 `ImageEditLayer` 完全取代 |
| `CanvasMagicGenerator.tsx` | 浮动条功能（编辑/下载/删除）已收敛到编辑层与右栏，避免入口重复 |
| `chat/RegionSelector.tsx` + 聊天面板参考图编辑流 | 与画布框选重复；图片编辑统一由画布承担 |
| `canvas/ImageNode.tsx` | 无引用 |
| 左栏「多区域标注」入口 | 已并入单击编辑 |
| `events` 的 `edit:open` / `edit:target` / `edit:target.clear` | 事件驱动的隐式跳转不符合直觉，改为就地编辑 |
| `window.__canvasApi` 诊断钩子 | 排查完成，按 DEV-LOG 遗留项移除 |
| `types/models.ts` 的 `RegionSelection` | 已无引用 |

---

## 三、改动文件

**后端**
```
backend/app/services/config_service.py    新增 EDIT_PROMPT_TEMPLATE / EDIT_PROMPT_PRESETS 配置 + get_json()
backend/app/services/asset_service.py     upload() 支持 prompt → 落 source_prompt
backend/app/services/generate_service.py  新增 to_png()；run_task 落库前统一 PNG 归一化
backend/app/routers/assets.py             上传支持 prompt 表单字段；新增 GET /api/assets/prompt-presets
backend/tests/test_png_and_prompt.py      新增 10 条回归测试
```

**前端（新增）**
```
frontend/src/components/canvas/ImageEditLayer.tsx    统一图片编辑层（框选/涂鸦/提示词/提交）
frontend/src/components/canvas/LayerPanel.tsx        类 Figma 图层面板
frontend/src/components/canvas/UploadPromptDialog.tsx 上传内置提示词配置弹窗
```

**前端（重写/修改）**
```
frontend/src/components/canvas/WorkspaceView.tsx   单击进入编辑、图层接线、变更守卫、去冗余
frontend/src/components/canvas/canvas-helpers.ts    buildEditPayload / imageToBlob / elementScreenRect 等
frontend/src/components/canvas/CanvasExport.tsx     客户端导出 PNG / JPG
frontend/src/components/canvas/CanvasHeader.tsx     传入 api
frontend/src/components/canvas/ImagePreviewPanel.tsx 编辑 / 下载 PNG·JPG / 删除 + 内置提示词展示
frontend/src/components/layout/WorkspaceLeftbar.tsx 移除「多区域标注」，新增图层插槽
frontend/src/components/chat/ChatPanel.tsx          仅保留「对话 / 文生图」两条主线
frontend/src/components/chat/GenerationResultCard.tsx 移除重复的「编辑」入口
frontend/src/lib/api/assets.ts                      upload(file, prompt) + promptPresets()
frontend/src/lib/events.ts / types/models.ts        清理废弃事件与类型
frontend/src/index.css                              隐藏与单击编辑冲突的原生裁剪提示
frontend/src/i18n/locales/{zh-CN,en}/*.json         补充图层 / 导出文案
```

**测试资产**
```
e2e/mock_upstream.py    模拟上游（故意返回 JPEG，用于验证 PNG 归一化）
e2e/verify_flow.py      API 全流程 19 项断言（含自清理）
e2e/ui_verify.mjs       真实浏览器 UI 全流程 20 项断言（零依赖 CDP 驱动）
```

---

## 四、验证方式

| 验证 | 命令 | 结果 |
|---|---|---|
| 前端类型 | `npm run typecheck` | 0 error |
| 前端 Lint | `npx eslint src` | 0 error（4 条 warning 均为改动外既有文件） |
| 前端构建 | `npm run build` | ✓ built in 7.55s |
| 后端测试 | `.venv/bin/python -m pytest -q` | **89 passed**（含新增 10 条） |
| API 端到端 | `python e2e/verify_flow.py` | **19/19 通过** |
| 真实浏览器 UI | `node e2e/ui_verify.mjs` | **20/20 通过** |

关键证据：
- 上游 mock 返回 **JPEG**，平台落库资源为 `.png` 且字节首 8 位 = `89 50 4E 47 0D 0A 1A 0A`（真 PNG）；
- 导出下载文件：`canvas-*.png` 14219 bytes（PNG 魔数通过）、`canvas-*.jpg` 21895 bytes（JPEG 魔数通过）；
- 编辑任务 `params.edit_region` / `mask_url` 均正确透传。

界面留档：`docs/design/2026-10-16-workspace-layers-edit.png`（编辑层 + 图层面板 + 右栏图片面板实拍）。

---

## 五、过程中修复的真实缺陷

1. **`Maximum update depth exceeded`（致命）**：`handleChange` 中无条件 `setElements`/`setSelectedIds`，Excalidraw 每次 `onChange` 都产生新数组引用 → "onChange → setState → 重渲染 → onChange" 无限循环，工作台直接白屏报错。
   → 引入 `sceneSignature()`（`id:version:opacity:locked`）做内容级比较，仅在真正变化时落 state。
2. **图层选中无法同步**：Excalidraw 的程序化 `updateScene({appState:{selectedElementIds}})` **不会触发 `onChange`**，导致图层面板点了没反应。
   → 图层选中时由面板直接回调同步选中态（`selectionSigRef` + `setSelectedIds`），同时仍调用 `updateScene` 让画布显示选中框。
3. **图层显隐/锁定不生效**：只改 `opacity`/`locked` 而不升版本号时，Excalidraw 判定元素"未变化"而丢弃更新。
   → `LayerPanel.patch()` 统一 bump `version` / `versionNonce` / `updated`。
4. **两条工具栏重叠**：编辑层工具条与 Excalidraw 原生工具条都在顶部居中。
   → 编辑层工具条下移至 `top-[88px]`。

---

## 六、遗留 / 后续建议

| 级别 | 事项 | 说明 |
|---|---|---|
| P1 | 真实上游接入验证 | 当前用 mock 上游（返回 JPEG）验证；换成线上 URL + Key 后需复跑 `verify_flow.py` |
| P2 | 多选批量操作 | 图层面板目前仅单选；框选多个元素后批量移动/删除可后续补 |
| P2 | 图层拖拽排序 | 现为按钮式上移/下移；拖拽排序需引入 dnd 库 |
| P3 | 编辑层支持旋转图 | 当前对旋转元素用外接盒近似（见 `elementScreenRect` 注释） |
