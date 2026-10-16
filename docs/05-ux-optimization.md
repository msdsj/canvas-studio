# canvas-studio UX 优化方案与实施标准（v2.0）

> 日期：2026-10-16 · 状态：核心项已落地实施
> 目标：在**视觉一致性、操作流畅度、功能实用性**三个维度达到行业领先水准

---

## 一、设计语言统一：现代圆角 / 胶囊体系

### 1.1 圆角规范（Radius Scale，全站强制统一）

| 层级 | 规范 | Tailwind | 应用范围 |
|------|------|----------|---------|
| 胶囊 | `rounded-full` | 9999px | 徽章、状态标签、模式切换 Chip、浮动工具条、头像、进度条、开关 |
| 浮层 | `rounded-xl` | 12px | 对话框、模态框 |
| 控件 | `rounded-lg` | 8px | **按钮、输入框、文本域、下拉、气泡弹层、分页、骨架屏、提示气泡** |
| 微元素 | `rounded-md`/`rounded-sm` | 4-6px | 菜单项、tab 内部、checkbox 等内部微元素 |

### 1.2 已实施变更（代码级）

| 文件 | 变更 |
|------|------|
| `ui/button.tsx` | 按钮统一 `rounded-md → rounded-lg`（更柔和） |
| `ui/input.tsx` / `ui/textarea.tsx` | 输入控件统一 `rounded-lg` |
| `ui/badge.tsx` | 徽章**胶囊化** `rounded-sm → rounded-full` |
| `ui/dropdown-menu.tsx` / `ui/popover.tsx` / `ui/pagination.tsx` / `ui/skeleton.tsx` / `ui/tooltip.tsx` | 统一 `rounded-lg` |
| `ui/dialog.tsx` | 关闭按钮 `rounded-lg`（主体保持 `rounded-xl`） |
| `canvas/CanvasMagicGenerator.tsx` | 浮动操作条**胶囊化**（`rounded-full` 容器 + 胶囊按钮） |

### 1.3 视觉一致性标准（验收）

- [x] 同层级组件圆角值一致（grep 可验证）
- [x] 按钮/输入框/徽章不再混用 rounded-md/sm
- [x] 新组件必须从本表取值，禁止自造圆角

---

## 二、交互逻辑重构（贴合直觉）

### 2.1 画布编辑流程重构（已实施）

| 优化点 | 变更前 | 变更后 |
|--------|--------|--------|
| 发送模型 | 每个标签各自发送（多次点击、多次扣费） | **全局唯一【⚡ 发送 (N)】按钮**，一次提交全部标记（单次扣费） |
| 气泡职责 | 气泡内混排"输入+发送+透明化" | 气泡只负责"写指令"（编号 + 输入框 + 强度切换 + 删除） |
| 多区域提交 | 多请求 | 分点提示词 + 编号红框参考图，**一次请求**送达上游 |
| 编辑强度 | 无 | 每标记可切换【精细修改】（保结构）/【重新生成】（换主体） |

### 2.2 主流设计工具操作习惯对齐（已实施）

| 优化点 | 说明 |
|--------|------|
| **双击进入编辑** | 双击画布上的图片 = 直接进入框选编辑模式（Figma 式习惯） |
| **选中浮动工具条** | 选中图片后浮现胶囊工具条：【✨ 编辑】【下载】【删除】——所有高频操作就在眼前 |
| **一键下载原图** | 浮动工具条直接下载选中图片原图（无需去资产库找） |
| 快捷键（Excalidraw 原生） | `Delete` 删除、`Cmd+Z/Y` 撤销重做、`Cmd+D` 复制、`空格/中键` 平移、`Ctrl+滚轮` 缩放、`Cmd+A` 全选等 |

### 2.3 后续建议（未实施，供迭代）

- 画布元素右键菜单（复制/层级/导出）
- 快捷键帮助面板（`?` 唤起）
- 任务卡片 hover 显示"重试/再生成"快捷操作

---

## 三、冗余清理（已实施）

| 清理项 | 原因 |
|--------|------|
| 左栏"删除选中"按钮（`canvas.toolbar.delete_selected`） | 冗余入口：删除应发生在**选中元素处**（浮动工具条 + Delete 键），左栏工具区放置会造成误触且不符合设计工具习惯；同时修复了该按钮的 i18n key 前缀 bug（显示原始 key） |
| 编辑模式下浮动工具条自动隐藏 | 避免与框选提示条重叠（z-index/位置冲突） |

**清理原则（标准）**：
1. 同一功能仅保留**一处主入口** + 键盘快捷方式
2. 入口贴近操作对象（就地操作优先于全局面板）
3. 界面文案不允许出现原始 i18n key（缺翻译即视为缺陷）

---

## 四、画布专项（类 Figma 改造）

### 4.1 已实施

| 能力 | 实现 |
|------|------|
| 拖拽 / 缩放 / 平移 / 框选 / 对齐 | Excalidraw 原生（工业级交互） |
| 双击图片进入编辑 | `WorkspaceView` 容器 `onDoubleClick`（精确命中 CANVAS 层） |
| 浮动操作条 | 编辑 / 下载 / 删除（胶囊风格，选中即现、编辑模式自动隐藏） |
| 缩放控制 | 工具栏缩放按钮 + 适应屏幕 + Ctrl+滚轮 |
| 自动保存 | 2s 防抖 + 状态指示（已保存/未保存的更改） |

### 4.2 交互验收标准

- 任意图片：选中 → 悬浮工具条出现（≤100ms）
- 双击图片 → 框选模式开启，提示条明确告知下一步
- 删除：Delete 键与工具条按钮均可，且只删除选中元素
- 所有操作有即时反馈（hover 态/选中态/toast）

---

## 五、实施记录（本轮代码变更清单）

```
frontend/src/components/ui/button.tsx           圆角统一 rounded-lg
frontend/src/components/ui/input.tsx            圆角统一 rounded-lg
frontend/src/components/ui/textarea.tsx         圆角统一 rounded-lg
frontend/src/components/ui/badge.tsx            徽章胶囊化 rounded-full
frontend/src/components/ui/dropdown-menu.tsx    圆角统一
frontend/src/components/ui/popover.tsx          圆角统一
frontend/src/components/ui/pagination.tsx       圆角统一
frontend/src/components/ui/skeleton.tsx         圆角统一
frontend/src/components/ui/tooltip.tsx          圆角统一
frontend/src/components/ui/dialog.tsx           关闭按钮圆角
frontend/src/components/canvas/CanvasMagicGenerator.tsx   重写为胶囊浮动工具条（编辑/下载/删除）
frontend/src/components/canvas/WorkspaceView.tsx          双击编辑 + 下载函数 + 工具条接线 + 编辑模式隐藏工具条
frontend/src/components/layout/WorkspaceLeftbar.tsx       移除冗余删除入口（修复 i18n key bug）
frontend/src/i18n/locales/{zh-CN,en}/canvas.json          补充 toolbar.download / delete_short
```

验证：`npm run typecheck` 通过（0 error）。

---

## 六、后续迭代 backlog（优先级排序）

| # | 项 | 价值 |
|---|----|------|
| 1 | 浮动工具条扩展：置顶/置底、复制、导出选区 | 对齐 Figma 高频操作 |
| 2 | 快捷键帮助面板（`?`） | 降低学习成本 |
| 3 | 任务卡快捷重试/版本对比 | 编辑迭代效率 |
| 4 | 管理后台表格密度优化 + 空状态插图 | 后台体验专业度 |
| 5 | 移动端手势专项（双指缩放、长按菜单） | 全端体验 |
