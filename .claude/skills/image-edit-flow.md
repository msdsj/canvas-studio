# 图片编辑 AI 增强流程

这个 skill 定义了图片编辑的完整 AI 驱动流程。

## 核心原则

1. **所有图片处理都由 gpt-image-2 完成**，包括抠图、换背景、改文字等
2. **后端不做任何本地图片处理**，只负责转发和协调
3. **必须先通过对话中转站分析**用户意图和完善提示词
4. **根据分析结果决定生成几张图片**

## 完整流程

### 步骤 1：用户标记

用户在画布上完成标记：
- 涂鸦画出需要处理的具体内容
- 框选标出需要处理的区域
- 填写每个区域的需求描述

### 步骤 2：发送到对话中转站分析

**输入：**
- 用户标注后的完整图片（带涂鸦和红框）
- 用户填写的需求描述

**对话中转站任务：**
1. 分析用户的真实意图
2. 完善和优化提示词
3. 判断需要生成几张图片
4. 返回结构化的执行计划

**返回格式：**
```json
{
  "tasks": [
    {
      "type": "edit",  // 或 "cutout"
      "prompt": "完善后的详细提示词",
      "region_index": 1,  // 对应第几个框选区域
      "description": "换背景 + 改文字为'欢迎光临'"
    },
    {
      "type": "cutout",
      "prompt": "请精确抠出图片中红框标记的人物，保留所有细节，生成透明背景的PNG图片",
      "region_index": 2,
      "description": "抠出人物"
    }
  ],
  "total_images": 2  // 需要生成的总图片数
}
```

### 步骤 3：逐任务调用 gpt-image-2

对于每个 task：

**如果是 edit（换背景、改文字等）：**
```python
files = [
    ("image", ("marked.png", 标注图片, "image/png")),  # 带涂鸦的完整图
    ("mask", ("mask.png", 该区域的mask, "image/png"))  # 只有该区域透明
]
form = {
    "prompt": task["prompt"],  # 完善后的提示词
    "model": "gpt-image-2",
    "size": "1024x1024"
}
# 调用 /gw/images/edits
```

**如果是 cutout（抠图）：**
```python
files = [
    ("image", ("marked.png", 标注图片, "image/png")),  # 带涂鸦的完整图
    ("mask", ("mask.png", 该区域的mask, "image/png"))  # 只有该区域透明
]
form = {
    "prompt": task["prompt"],  # 例如："请精确抠出红框和涂鸦标记的区域，生成透明背景PNG"
    "model": "gpt-image-2",
    "size": "1024x1024"
}
# 同样调用 /gw/images/edits，但提示词指示生成透明背景
```

### 步骤 4：返回结果

- 每个 task 生成一张图片
- 前端在画布上展示所有结果
- 用户可以继续编辑任意一张

## 关键点

### ❌ 错误做法（当前实现）

```python
# 后端自己抠图
sprite = cutout_service.extract_sprite(base_bytes, op.region)

# 后端自己合成
composite = _paste_region(base_bytes, edited_bytes, op.region)

# 后端自己做透明化
composite = _apply_transparent(composite, [op.region])
```

### ✅ 正确做法

```python
# 1. 先调用对话中转站分析
analysis = await gateway_client.llm_completions({
    "messages": [
        {
            "role": "system",
            "content": "你是图片编辑需求分析专家，分析用户意图并生成详细提示词"
        },
        {
            "role": "user",
            "content": f"用户需求：{user_regions_and_prompts}\n请分析需要几张图，每张图的详细提示词是什么"
        }
    ],
    "response_format": {"type": "json_object"}
})

tasks = json.loads(analysis["choices"][0]["message"]["content"])["tasks"]

# 2. 逐任务调用 gpt-image-2
results = []
for task in tasks:
    result = await gateway_client.image_edits(
        files=[
            ("image", ("marked.png", marked_image_bytes, "image/png")),
            ("mask", ("mask.png", generate_mask_for_region(task["region_index"]), "image/png"))
        ],
        form={
            "prompt": task["prompt"],  # 已由对话中转站完善
            "model": "gpt-image-2",
            "size": "1024x1024"
        }
    )
    results.append(result)

# 3. 直接返回所有结果，不做任何后处理
return results
```

## 对话中转站的 prompt 模板

```
你是图片编辑需求分析专家。用户在一张图片上标记了多个区域并描述了需求。

用户的标记：
- 区域1（红框左上角）：换背景，改文字为"欢迎光临"
- 区域2（红框右侧）：把人物抠出来
- 区域3（红框底部）：把文字改成蓝色

你的任务：
1. 分析每个区域的真实需求
2. 为每个需求生成详细的、适合 gpt-image-2 的提示词
3. 判断需要生成几张独立的图片

注意：
- 抠图需求应该生成独立的透明背景PNG
- 修改需求应该保持原图布局，只修改指定区域
- 提示词要包含"只修改标记区域，其他地方保持不变"

返回 JSON 格式：
{
  "tasks": [
    {
      "type": "edit" | "cutout",
      "prompt": "详细提示词",
      "region_index": 区域编号,
      "description": "简短说明"
    }
  ],
  "total_images": 数量
}
```

## 实现位置

需要修改的文件：
1. `backend/app/services/generate_service.py` - 移除所有本地图片处理
2. `backend/app/routers/generate.py` - 添加对话分析步骤
3. `backend/app/services/plan_service.py` - 增强分析能力

## 示例场景

**用户操作：**
- 在一张产品图上框选了 3 个地方
- 区域1：涂鸦标记背景，写"换成白色背景"
- 区域2：涂鸦标记文字，写"改成蓝色"
- 区域3：涂鸦圈出人物，写"抠出来"

**对话中转站分析：**
```json
{
  "tasks": [
    {
      "type": "edit",
      "prompt": "将图片中红色框选标记的背景区域替换为纯白色背景，保持其他内容完全不变，确保过渡自然",
      "region_index": 1,
      "description": "换白色背景"
    },
    {
      "type": "edit", 
      "prompt": "将红色框选和涂鸦标记的文字颜色改为蓝色（#0000FF），字体和大小保持不变，其他区域不动",
      "region_index": 2,
      "description": "文字改蓝色"
    },
    {
      "type": "cutout",
      "prompt": "精确抠出红色框选和涂鸦标记的人物主体，包含所有细节（头发、衣服边缘），生成透明背景的PNG图片，不要包含背景元素",
      "region_index": 3,
      "description": "抠出人物"
    }
  ],
  "total_images": 3
}
```

**最终调用：**
- 调用 3 次 gpt-image-2
- 前两次返回修改后的完整图（1024x1024）
- 第三次返回透明背景人物（自动裁剪到人物边界）
- 所有处理都由 GPT 完成，后端只负责转发
