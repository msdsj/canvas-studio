# 生成结果落画布修复 + 刷新后画布空白修复

- **日期**：2026-10-16 20:50–21:10
- **两个相关缺陷**：① 图生成了但画布上"看不到" ② 刷新页面后画布内所有图消失
- **严重级别**：P1 / P0（数据看似丢失）

---

## 缺陷一：图生成了，画布上却看不到

### 现象
右栏卡片已显示真实生成的图片，画布上却什么都没出现。

### 排查结论
1. 查 `localStorage` 发现任务已被标记 `placed` → **图其实落进画布了**
2. 查后端画布数据：`elements: 4`（x = 80 / 440 / 800 / 1160），files 完好
3. 视口宽度只够显示到 x≈680 → **新图排在 x=800、1160，全在可视区右侧之外**

### 根因 A：落画布没有完成时机保障

`WorkspaceView` 的自动落画布 effect 只做两件事：挂载时跑一次 + 监听 `events.emit('tasks:changed')`。

但 `ChatPanel` 轮询任务状态时**只更新 UI，不发事件**——`tasks:changed` 仅在「提交 / 暂停 / 取消 / 重试」这些操作时发出。任务异步完成的那一刻，没有任何东西触发落图。

### 根因 B：网格顺排在图变多后必然落到可视区外

`nextPosition()` 按网格向右顺排，画布上每多一张图，新图就离视口更远。

### 修复

**1. 兜底轮询**（`WorkspaceView.tsx`）

```tsx
// 兜底轮询：任务完成时前端并不一定会 emit('tasks:changed')（轮询只更新 UI），
// 没有这个兜底会导致"生成成功但图没落到画布"。配合上方 3s 节流实际约 8s 检查一次。
const timer = window.setInterval(() => void placeResults(), 8000)
```

**2. 新图落在视口中心**（`canvas-helpers.ts` + `WorkspaceView.tsx`）

恢复 `viewportCenterScene()`，用确定性数学计算视口中心的 scene 坐标：

```ts
// scene = screen / zoom - scroll
x = vw / 2 / zoom - scrollX - elementWidth / 2
y = vh / 2 / zoom - scrollY - elementHeight / 2
```

自动落画布与手动【加入画布】都改用它。

> 曾经尝试过 `api.scrollToContent(elements)` 方案，**实测不可靠**（Excalidraw 内部时序问题会把视口滚飞到空白区域），已放弃。

---

## 缺陷二：刷新页面后画布全空

### 现象
画布里 4 张图在**刷新页面后全部消失**。但后端数据完好（`elements: 4`、`files: 14`、files 结构正确含 `id/dataURL/mimeType/created`）。

### 根因
持久化到后端的元素是平台**自造对象**（`buildImageElement` 手工拼字段），缺少 Excalidraw 0.18 restore 阶段的必需字段（`index` / `fractionalIndex` 等）。同一会话内因为元素是 Excalidraw 内存里新建的，所以看得到；**一旦从后端重新装载，restore 会把整批元素丢弃** → 画布空白。

### 修复

`frontend/src/components/canvas/CanvasExcali.tsx` —— 初始数据统一走**官方 `restoreElements()`** 规范化：

```tsx
import { Excalidraw, restoreElements } from '@excalidraw/excalidraw'

const data = useMemo(() => {
  const src = initialRef.current
  if (!src) return null
  try {
    return {
      elements: Array.isArray(src.elements) ? restoreElements(src.elements as never[], null) : [],
      appState: src.appState ?? {},
      files: src.files ?? {},
    }
  } catch {
    return { elements: [], appState: {}, files: {} }
  }
}, [])
```

---

## 改动文件清单

| 文件 | 改动 |
|---|---|
| `frontend/src/components/canvas/WorkspaceView.tsx` | 落画布加 8s 兜底轮询；自动/手动落图都定位到视口中心 |
| `frontend/src/components/canvas/canvas-helpers.ts` | 新增 `viewportCenterScene()`；`addImageToCanvas` 返回新建元素 |
| `frontend/src/components/canvas/CanvasExcali.tsx` | 初始数据走官方 `restoreElements()` 规范化 |
| `frontend/src/lib/task-persistence.ts` | （未改）`localStorage` 幂等标记 `cs.autoPlacedTasks`，保证不重复落图 |

---

## 遗留

- `WorkspaceView.tsx` 里有临时诊断钩子 `window.__canvasApi`（排查时加的），**需在发布前移除**
- 存量画布中那 2 张修复前的 DEMO 占位图属垃圾数据，可在画布上直接删除