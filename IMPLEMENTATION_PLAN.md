# 图片编辑与AI生成完整功能实现方案

## 问题诊断

### 核心问题
1. **标记图未被上游识别**：后端发送了 guide 图（带红框/涂鸦），但网关转发时可能只读取第一个 `image` 字段
2. **区域定位精度不足**：缺少标准 inpainting mask，上游无法精确约束编辑范围
3. **多区域处理逻辑不清晰**：前端 AI 分析完成后直接自动提交，用户无确认机会

### 根因
- OpenAI `/images/edits` API 标准：第一个 `image` = 原图，`mask` = 透明区域（要编辑的部分）
- 当前实现：发送多个 `image` 字段，但未发送标准 mask，上游可能只读第一张
- 前端已正确生成 guide 图（原图+涂鸦+红框），但后端未确保上游收到并理解它

## 完整解决方案

### 1. 后端：统一 mask 生成与多图转发策略

**文件：`backend/app/services/generate_service.py`**

#### 修改 `_call_edit()` 函数（行 475-518）
- **当前**：发送原图 + guide 图（可选）
- **修复**：
  1. 从 `ops` 计算 mask：所有上游区域的并集透明区域
  2. 明确字段命名：`image` = 原图，`mask` = 合成透明掩码，额外上下文通过 prompt 说明
  3. prompt 增强：显式说明 "透明区域需要修改，不透明区域保持原样；参考用户的标注位置但不要把红框/编号画进结果"

#### 新增：多图说明策略
- 当前 OpenAI edits API 只接受 1 个 image + 1 个 mask
- guide 图的作用（涂鸦+红框）通过详细 prompt 说明，而不是额外图片
- 或者：调研上游中转站是否支持多图输入；若支持，保持当前双图策略

### 2. 网关：多文件字段正确转发

**文件：`gateway/app/routers/images.py` + `gateway/app/services/image_router.py`**

#### 当前问题
- `image: list[UploadFile]` 正确接收多个文件
- 但转发给上游时，httpx 的 `files` 参数可能被某些中转站误读

#### 修复方案
- 保持当前实现：所有 image 文件以 `("image", ...)` 形式追加到 files 列表
- 添加日志：记录实际发送的文件数量和字段名
- 测试验证：确认上游中转站是否正确接收多个 image 字段

### 3. 前端：AI 分析结果需用户确认

**文件：`frontend/src/components/canvas/ImageEditLayer.tsx`**

#### 当前行为（行 442-533）
```typescript
// 提交时自动调用 analyzeRegions()，用户看不到分析结果就提交了
```

#### 修复方案
- **AI 分析按钮**：用户主动点击「AI 分析」，展示分析结果（各区域推荐能力）
- **确认对话框**：分析完成后展示预估产出（"将产出：1张修改图 + 2张透明素材"），用户确认后再提交
- **手动模式**：用户可跳过 AI 分析，手动为每个区域选择能力后直接提交

#### 实施步骤
1. 移除 `handleSubmit` 中的自动分析逻辑
2. 「生成」按钮改为：有未分析区域时显示「确认并生成」，已分析时显示「生成 N 张图片」
3. 添加产出预览：实时计算并显示"将产出：X"

### 4. 完善图片下载与画布集成

**文件：`frontend/src/components/canvas/WorkspaceView.tsx`**

#### 当前实现（行 619-653）
- 生成完成后自动 `placeTaskResults`，结果直接落画布
- 使用 `toast.success` 提示

#### 保持现有实现（已满足需求）
- ✅ 自动下载：`placeTaskResults` 内部通过 dataURL 加载图片
- ✅ 画布编辑：点击图片元素触发 `enterEdit`
- ✅ 多图处理：`task.result_urls.length > 1` 时逐张投放

### 5. 并发与多任务处理

**文件：`backend/app/services/task_service.py`**

#### 当前机制
- 幂等键防重：同一 `idempotency_key` 返回已有任务
- 后台执行：`BackgroundTasks.add_task(generate_service.run_task, task_id)`

#### 验证要点
- ✅ 多图并发：前端为每个生成请求分配独立 `idempotencyKey`
- ✅ 任务隔离：每个任务独立 DB 会话（`AsyncSessionLocal()`）
- ✅ 失败隔离：单个任务失败不影响其他任务

### 6. 第三方库集成确认

**前端已集成：**
- ✅ `perfect-freehand`：画笔平滑（`canvas-helpers.ts`）
- ✅ `@excalidraw/excalidraw`：画布核心

**无需额外库**，当前技术栈完整。

### 7. 中转站集成验证

**文件：`backend/app/services/gateway_client.py` + `gateway/app/services/image_router.py`**

#### 当前架构
- ✅ 统一网关：所有上游请求经过 `/gw/*`
- ✅ 错误映射：上游错误码转换为业务错误码
- ✅ Demo 降级：连接失败时返回占位图

#### 需验证
- 上游中转站是否支持标准 OpenAI `/images/edits` API
- 是否正确处理 mask 字段（透明 PNG）
- 是否支持多个 image 字段（当前实现需要）

## 实施优先级

### P0（立即修复）
1. **后端 mask 生成**：`_call_edit()` 添加区域并集 mask 发送
2. **prompt 增强**：明确说明 "mask 透明区域需要修改，不透明区域严格保持原样"
3. **前端确认流程**：AI 分析后展示产出预估，用户确认再提交

### P1（重要优化）
4. **网关日志增强**：记录转发给上游的实际文件数
5. **测试用例**：`test_edit_orchestration.py` 添加 mask 生成测试

### P2（后续完善）
6. **性能优化**：大图 mask 生成使用 PIL 加速
7. **用户引导**：首次使用时提示"框选区域 → 描述需求 → AI 分析 → 确认生成"

## 技术细节

### Mask 生成算法（PIL）
```python
def _render_union_mask(base_bytes: bytes, regions: list[dict]) -> bytes:
    """生成所有区域的并集 mask：透明=要编辑，不透明=保留"""
    image = Image.open(io.BytesIO(base_bytes)).convert("RGBA")
    width, height = image.size
    alpha = Image.new("L", (width, height), 255)  # 255=不透明=保留
    draw = ImageDraw.Draw(alpha)
    for region in regions:
        x, y, w, h = region_to_pixels(region, width, height)
        draw.rectangle([x, y, x+w-1, y+h-1], fill=0)  # 0=透明=编辑
    image.putalpha(alpha)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()
```

### 前端产出预估（已实现）
```typescript
const outputHint = useMemo(() => {
  const composites = regions.filter(r => 
    handlerById[r.handler]?.output === 'composite'
  ).length
  const sprites = regions.filter(r => 
    handlerById[r.handler]?.output === 'sprite'
  ).length
  const parts: string[] = []
  if (composites > 0) parts.push('1 张修改图')
  if (sprites > 0) parts.push(`${sprites} 张透明素材`)
  return parts.join(' + ')
}, [regions, handlerById])
```

## 验收标准

- [ ] 用户框选区域 + 涂鸦后，生成的图片**只修改标记区域**，框外像素完全不变
- [ ] AI 分析后显示「将产出：1张修改图」或「1张修改图 + 2张素材」，用户确认后才提交
- [ ] 多个区域可分别设置不同能力（改样式/抠图/去物/增强）
- [ ] 生成完成后，结果自动出现在画布上，可继续编辑
- [ ] 多张图片并发生成时，任务互不干扰
- [ ] 纯本地能力（抠图/挖空）不消耗配额，用户可放心使用

## 注意事项

1. **上游 API 兼容性**：OpenAI 标准是 1 image + 1 mask，部分中转站可能不支持多图
2. **跨域问题**：画布导出需要 same-origin 或 CORS，当前已通过 objectURL 解决
3. **性能考虑**：大图（>2048px）mask 生成可能耗时，需在后台线程处理
4. **用户体验**：AI 分析失败时不应阻断提交，应降级为用户手动选择能力

---

**实施时间估算**：
- P0 修复：4-6 小时
- P1 优化：2-3 小时
- P2 完善：按需排期

**下一步**：开始实施 P0 修复，从后端 mask 生成开始。
