# 区域编辑：框选多区域 + 编号红框 + 分点提示词

- **日期**：2026-10-16 17:30–18:50
- **一句话**：在画布上框选多个要改的区域 → 自动生成带编号的红框标记图 → 写多条分点提示词 → **一次提交**，上游一次改完

---

## 一、交互设计（对齐 Lovart 的多标签模式）

1. 点击【多区域标注】进入框选模式
2. 在画布上**连续框选多个区域**
3. 每个选区生成一个**编号角标**气泡（气泡之间互斥展开，避免遮挡）
4. 气泡内独立输入该区域的修改指令
5. 点【发送修改】**统一提交**（不是每个气泡一个发送按钮 —— 用户明确要求）
6. 点击画布其他区域时，气泡自动收起

### 标记样式要求（用户逐条提出）
| 要求 | 实现 |
|---|---|
| 清晰不遮挡 | 纯边框、无填充 |
| 序号在框内 | 框内顶部居中；扁框时骑在框边 |
| 双层对比 | 外层白描边 + 内层红线，保证任何底图上都可见 |
| 字号自适应 | `max(14, min(rh*0.26, rw*0.14, min(cw,ch)/40))` |
| 数字别太大 | 经多轮调整后的上限值 |

---

## 二、核心机制：合成保真

上游 AI 编辑图像时**无法保证只改选区**，可能顺手改动其它区域。因此平台侧做兜底合成：

```
最终结果 = 选区内(上游结果) ⊕ 选区外(原图)
```

- 选区内：采用上游 AI 输出
- 选区外：**像素级 100% 保留原图**
- 选区边缘做羽化过渡（GaussianBlur），避免硬接缝

### 实现要点
- 多区域掩码用 `ImageChops.lighter` 取并集
- 验证方式：`ImageChops.difference` × 区域掩码 → 断言**选区外极值为 (0,0)**

---

## 三、多区域漏改检测

上游 AI 对多区域任务的执行力不稳定（常见现象：只改了按钮、人物没变）。为此服务端做**逐区域变更检测**：

- `_region_change_checks`：对每个区域计算灰度均差
- 均差 > 阈值(5.0) 判定该区域 `changed`
- 未改动的区域 → 前端打**警告标记**，支持**单区域重试**

---

## 四、纯透传链路（用户明确要求）

早期版本后端会在用户提示词后拼接约束语句（"仅修改红框区域…"）。用户要求**去掉一切额外加工**：

```python
form = {"prompt": task.prompt, "model": ..., "size": ..., "response_format": "b64_json"}
```

约束改为**双保险**：
1. 前端：`mask` 图上直接画红框编号（模型看得懂图）
2. 提示词模板：默认文案引导用户自己写分点描述

> 注意：`chatgpt2api` 的 `_composite_mask` 期望 RGBA alpha 语义（透明=编辑区），传 RGB 红框图会被转灰度当 alpha，导致掩码错乱。**平台侧保持自己的合成保真逻辑**，不依赖上游 mask 处理。

---

## 五、改动文件

| 文件 | 说明 |
|---|---|
| `backend/app/routers/generate.py` | edit 端点接收 `file/mask/edit_mode/edit_intensity/region`，region 支持对象或数组 |
| `backend/app/services/generate_service.py` | `_call_edit` 纯透传；`_composite_edit_result` 合成保真；`_region_change_checks` 漏改检测；`_call_transparent` 透明化（Pillow alpha，cost=0） |
| `backend/app/services/task_service.py` | `cost == 0` 跳过额度预扣（透明化免费） |
| `frontend/src/components/canvas/canvas-helpers.ts` | `buildRegionSelection` / `buildMultiRegionSelection`（编号红框生成） |
| `frontend/src/components/canvas/WorkspaceView.tsx` | 框选模式状态机、多标签气泡、警告标记、单区域重试 |

---

## 六、验证

- 像素级断言：选区外 `ImageChops.difference` 极值 = (0,0) ✅
- 多区域一次提交生效 ✅
- 漏改场景：黄标警告 + 单区域重试 ✅
- 透明化任务：额度不扣减 ✅