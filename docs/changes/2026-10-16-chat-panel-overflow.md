# 右栏对话卡片被截断修复

- **日期**：2026-10-16 20:40–20:50
- **现象**：右侧对话栏任务卡被视口裁切——提示词溢出、「再生成」按钮缺一半、图片只显示一部分
- **严重级别**：P1（阻断级 UI 缺陷）

---

## 一、修复过程中的关键教训：修错层级

**第一次修复（不完整）**：只给右栏 `aside` 加 `overflow-hidden`。
→ 结果：溢出确实不跑到屏幕外了，但内容本身**依然超宽**，被 `overflow-hidden` **裁掉**——用户截图里「再生成」按钮仍然缺一半。**这是遮丑，不是修复。**

**第二次修复（找到真根因）**：真正的元凶在 `ScrollArea`。

---

## 二、真正根因

`ChatPanel` 用的是 Radix UI 的 `ScrollArea` 组件：

```tsx
<ScrollAreaPrimitive.Viewport className="h-full w-full">
  {children}
</ScrollAreaPrimitive.Viewport>
```

Radix 的 Viewport 内部会渲染一层 `<div style="display:table; min-width:100%">`。这张 `table` 的 `min-width:100%` 语义是「至少铺满」，但**不会阻止内容把它撑得更宽**。

而结果卡里的生成图原始分辨率是 **1254×1254**（`img` 虽然写了 `w-full`，但 intrinsic width 仍参与 flex 链路的 min-content 计算）→ 图片把整条链路撑宽 → 卡片与按钮行按 min-content 排版 → 远超右栏 380px。

按钮行虽有 `flex-wrap`，但它排版所在的容器已经是超宽的，所以换行也换不出 380px 的空间。

---

## 三、修复（三处协同）

### 1. `frontend/src/components/ui/scroll-area.tsx`（根治点）

```tsx
<ScrollAreaPrimitive.Viewport
  className="h-full w-full min-w-0 rounded-[inherit]
             [&>div]:!block [&>div]:w-full [&>div]:!min-w-0">
```

- `min-w-0`：允许 Viewport 在 flex 布局中收缩
- `[&>div]:!block` + `w-full` + `!min-w-0`：覆盖 Radix 内层 table 的 `display:table` 与 `min-width:100%`，改为块级铺满父宽

### 2. `frontend/src/components/chat/GenerationResultCard.tsx`

卡片根节点加 `w-full min-w-0`，确保卡片自身按栏宽收缩。

### 3. `frontend/src/components/layout/WorkspaceRightPanel.tsx`（兜底）

`aside` 保留 `min-w-0 overflow-hidden`，防止未来任何新内容再次撑爆右栏。

---

## 四、验证

| 指标 | 结果 |
|---|---|
| 右栏 clientWidth / scrollWidth | 379 / 379 ✅ 无溢出 |
| 按钮行 clientWidth / scrollWidth | 321 / 321 ✅ 完整 |
| 视觉 | 提示词自动 truncate；按钮自动换行（已完成/加入画布/编辑 + 再生成），无裁切 ✅ |
| 构建 | `tsc` + `vite build` 均通过 ✅ |

---

## 五、通用经验（写入团队规范）

> **Flex 布局中的 flex item 默认 `min-width: auto`**。这意味着即使写了 `w-full`，内部大图（尤其带 `aspect-ratio` 的大尺寸图）的 intrinsic width 仍会把容器从内部撑宽。
> 凡是「固定宽度侧栏 + 内部可变内容」的场景，**必须**同时具备：
> 1. 父级：`min-w-0`
> 2. 滚动容器 Viewport：覆盖 Radix/自定义组件的内层 table 行为
> 3. 内容卡片：`w-full min-w-0`
> 4. 兜底：`overflow-hidden`
>
> 只加 `overflow-hidden` = 把 bug 藏起来，**不算修复**。