# 图片涂鸦编辑器（编辑 = 涂鸦）

- **日期**：2026-10-16 19:00–20:05
- **模块**：`frontend/src/components/canvas/CanvasDoodle.tsx`
- **一句话**：点【编辑】→ 直接在这张图上涂鸦 → 写指令 → 提交给上游做定向修改，**编辑就是涂鸦，不区分两个概念**

---

## 一、功能定义

| 能力 | 说明 |
|---|---|
| 画笔 / 橡皮 | 橡皮 = 透明层 `destination-out`，擦除处自然露出底图 |
| 颜色 | 5 色（红/橙/蓝/绿/白） |
| 粗细 | 3 档（4 / 8 / 16 px），橡皮为 2.4 倍 |
| 撤销 / 重做 | 双栈，支持任意来回 |
| 清空 | 一键清笔迹 |
| 尺寸显示 | 底部显示原图分辨率（如 `1024 × 1024`） |
| 提交 | 合成图（原图+笔迹，原分辨率）+ 笔迹包围盒 region + 指令 → `/api/generate/edit` |

笔迹坐标一律存**原图坐标系**，与屏幕缩放解耦，因此在任何缩放级别绘制都能 1:1 还原到原图。

---

## 二、关键交互决策（走过的弯路）

### 决策 1：编辑与涂鸦合并为一个入口 ✅
用户反馈「编辑其实就是涂鸦，不要区分」后统一：
- 浮动工具条删除【涂鸦】按钮，只留 编辑 / 下载 / 删除
- 双击画布图片 = 直接打开涂鸦
- 原「框选编号」模式更名为**【多区域标注】**，入口移到左栏工具区（语义：批量分区域指令）

### 决策 2：编辑过程严格不改页面布局 ✅
用户要求「编辑时页面布局尺寸完全不变，不加涂鸦专属样式/主题/布局变更」。

实现：`CanvasDoodle` 从**全屏遮罩**改为**画布内透明叠加层**
- 根节点：`absolute inset-0 z-30`，无背景色、无 backdrop-blur
- 工具条：`absolute top-3 left-1/2` 轻量浮动胶囊
- 输入框：`absolute bottom-3 left-1/2` 悬浮条
- 组件从工作台根容器**移入画布容器内**渲染 → 左右栏全程可见

### 决策 3：不引入隐式副作用 ✅（用户纠正后的回滚）
曾尝试「点编辑 → 自动把图落到画布 → 涂鸦层贴合其真实位置」，用户明确否决：
> 「不需要这么麻烦，你就把生成的图片下载下来，点击编辑，然后就是涂鸦，涂鸦完提交」

**回退内容**：`edit:open` 恢复极简（探测尺寸 → 直接进涂鸦）；删除 `viewportCenterScene`；`addImageToCanvas` 恢复原签名。

> 该函数后续在"落画布定位"需求中以更正确的理由重新引入，见 `2026-10-16-canvas-autoplace.md`。

---

## 三、跨域图片导出（重要技术点）

结果卡图片来自后端 `http://localhost:27181/static/...`，与页面（27180）**跨域**。直接 `drawImage` 会污染 canvas，导致 `toBlob()` 返回 null —— **提交静默失败**。

解决：提交前把跨域 URL 走 `fetch → blob → URL.createObjectURL` 转成同源 objectURL，canvas 不再被污染。

> 注意：`crossOrigin="anonymous"` 在这里无效（后端未返回 CORS 头），必须用 fetch 方案。

---

## 四、改动文件

| 文件 | 说明 |
|---|---|
| `frontend/src/components/canvas/CanvasDoodle.tsx` | 新增（~500 行），核心实现 |
| `frontend/src/components/canvas/WorkspaceView.tsx` | `handleStartDoodle`、涂鸦层挂载、提交逻辑 |
| `frontend/src/components/chat/ChatPanel.tsx` | `edit:open` 事件发射（结果卡 → 工作台） |
| `frontend/src/components/layout/WorkspaceLeftbar.tsx` | 【多区域标注】入口 |
| `frontend/src/lib/events.ts` | `edit:target` / `edit:open` 事件 |

---

## 五、验证记录

- 浏览器实测：绘制 ✓ 笔数状态联动 ✓ 尺寸显示 ✓ 提交（额度扣减正确）✓ 骨架屏占位 ✓ 结果回画布 ✓
- 撤销(1→0) / 重做(0→1) / 橡皮模式切换 ✓
- 结果卡点【编辑】→ 涂鸦层画布区居中弹出，图片不放大 ✓
- 退出编辑后画布元素数量不变（无副作用）✓