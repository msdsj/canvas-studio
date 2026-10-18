# 纯生图链路与 AI 中转站

> 本文说明「侧边栏一句话 → 出图」这条主链路的实现边界。
> 对应改造：移除对话/生图双模式、用户级中转站配置、全链路思考、设计技能库、三处润色。

## 1. 一条链路，不再分模式

```
用户输入（文字 + 可选参考图 / 画布选区）
        │
        ├─ 有选区 → POST /api/chat/analyze   （按区域拆指令，判定 1/2 张）
        └─ 无选区 → POST /api/chat/compose   （从零生成 / 参考图生成）
                          │
        ┌─────────────────┴──────────────────┐
        │ 1 analyze  读懂需求（主体/风格/约束/缺失） │
        │ 2 ambiguity 歧义检查                     │
        │     └─ 不明确 → clarify（只出方案，不建任务）
        │ 3 reason   推导方案（构图/光线/材质/取舍） │
        │ 4 prompt   生成最终提示词（负向词/画幅）  │
        │ 5 dispatch 建任务（文生图 或 图生图）     │
        └────────────────────────────────────┘
```

三条硬约束：

1. **歧义必须停**：`status=clarify` 时不建任务、不扣生图额度，用户点选方案后才走
   `POST /api/chat/runs/{run_id}/confirm`（用方案自带的提示词建任务）。
2. **建任务用 `final_prompt`**：用户原话只作为模型输入，绝不直接当提示词落库
   （否则「帮我弄好看点」会被原样送去画图）。
3. **不绕过中转站**：未配置时 `status=unconfigured`，前端引导去配置；
   只有用户**显式点击**「用本地模板先试一次」才会带 `allow_degraded=true` 走模板，
   并在思考块上标注「本地模板」。

## 2. 中转站配置（用户级）

- 表：`ai_providers`（`backend/app/models/ai_provider.py`），一个用户可存多条，只有一个 `is_active`。
- 接口：`/api/ai/providers`（CRUD + activate + test）、`/api/ai/status`。
- 解析顺序（`relay_service.resolve`）：
  1. 用户激活的 provider；
  2. 平台全局 `TEXT_*`（**仅当** `AI_RELAY_ALLOW_GLOBAL=true`，默认关闭，避免白嫖平台模型费用）；
  3. 都没有 → `configured=false`。
- 协议：Claude 原生（`/v1/messages` + `x-api-key`）与 OpenAI 兼容（`/chat/completions` + `Bearer`）。
  地址容错：填到裸域名、`/v1`、`/v1/chat/completions` 都能拼对。
- 密钥：只回 `key_hint` 掩码；PATCH 时若传入值含 `*` 视为「不修改」，
  防止前端回填掩码把真实 Key 覆盖成星号。

## 3. 全链路思考怎么来的

`compose_service` 的每一步都是**真实调用结果**，不是模板文案：

| 步骤 | 数据来源 | 展示内容 |
|------|---------|---------|
| analyze | 模型返回的 `summary` / `thinking[]` | 它读出了什么、怎么理解的 |
| ambiguity | `ambiguity.is_ambiguous` / `reason` / `missing[]` | 为什么停下、还缺什么 |
| reason | 模型返回的 `reasoning[]` | 构图/光线/色彩的取舍 |
| prompt | `final_prompt` / `negative` / `skill_id` / `size` | 最终提示词（可复制） |
| dispatch | 建任务结果 | 提交了几个任务 |

前端 `ThinkingTrace`：实时态自动展开，历史消息默认折叠；`prompt_source=template` 会挂「本地模板」标签。

## 4. 设计技能库

`backend/app/services/design_skills.py`：**16 类 78 条**，每条含
`description / when_to_use / prompt_scaffold / negative / aspect / style_tags`，
重点技能另有 `slots`（构图/光线/色彩/材质/文字…）与 `pitfalls`（常见翻车点）。

- 检索：`GET /api/ai/skills?category=&q=`，前端 `SkillLibraryPanel`。
- 注入：`compose_service.shortlist_skills()` 先做**确定性初筛**（关键词 + 用途词 + 中文二元组重合度，
  同一分类最多 2 条），只把命中的 5 条完整骨架 + 20 条目录喂给模型；模型返回的 `skill_id`
  必须存在于库中，否则丢弃（不允许编造技能）。
- 结构化注入：`render_detail()` 优先输出 `slots`（没有显式 slots 的技能，从骨架里按
  「构图：…；光线：…」自动抽取），再拼负面词与翻车点。比一整段散文更容易被模型稳定执行。
- 选中的骨架会参与提示词工程，`negative` 折进提示词尾部（上游 gpt-image 无独立负向参数）。

## 5. 润色

`POST /api/ai/polish`：**6 种模式 × 1–3 个变体**，`scene ∈ composer | region | sidebar`。

| 模式 | 做什么 |
|------|--------|
| auto 智能 | 按场景判断最缺什么，补 1–2 项 |
| specific 更具体 | 补主体/场景/构图/光线/材质/色彩 |
| professional 更专业 | 口语换成设计术语（网格、留白、低饱和、柔光箱…） |
| concise 更简洁 | 压成一句，删掉形容词堆砌 |
| english 英文 | 输出英文提示词（本地模式做不了，会如实说明） |
| fix 修歧义 | 找出「极简但元素丰富」这类矛盾并消解 |

- 有中转站：模型返回 `{variants:[{label,text,notes}]}`，解析失败退回本地规则；
- 无中转站：本地规则（去口语、评价词换视觉描述、区域补「仅修改该区域」），返回 `engine=local`；
- 前端 `PolishPopover`：入口在**侧边栏右上角**，点开即出结果，可切换模式重跑、选版本、
  替换输入框、一键撤销；框选区域气泡里用同一浮层的图标形态。

## 6. 常见配置问题（都是真实踩过的）

| 现象 | 真正原因 | 现在怎么处理 |
|------|---------|-------------|
| 测试连接提示「返回内容为空 / 模型名是否被支持」 | **思考型模型**（deepseek-v4.x、o 系列）会先把 token 花在 `reasoning_content` 上；测试请求 `max_tokens` 太小，正文就是空的 | 测试固定用 256 tokens；`content` 为空时退回读 `reasoning_content`；按 `finish_reason=length` 提示「输出被截断，把最大 tokens 调大」 |
| 正式生成报「只输出了思考过程、没有正文」 | 同上，用户把「最大输出 tokens」设得太小 | 提示里带上当前 max_tokens 值，直接改配置即可 |
| HTTP 400，报错里提到 `response_format` | 部分中转站不支持 JSON 模式 | 自动去掉 `response_format` 重试一次，用户无感 |
| 填了裸域名（`https://api.xxx.com`）报 404 | 少了 `/v1` | 自动补成 `/v1/chat/completions` |
| 「域名解析不了」 | 地址写错，或运行环境没有外网 DNS | 检查地址；本地中转站建议直接用 `http://127.0.0.1:端口/v1` |

> 一句话：**思考型模型的 max_tokens 要留够**。正式生成建议 ≥ 1024，测试已用 256。

## 7. 已知边界

- `api_key` 目前明文存 SQLite（与既有 `system_configs` 一致），仅靠掩码与日志脱敏；
  需要更强隔离时应加应用层加密（不引入新依赖可用 HMAC 派生密钥 + AES-GCM 自实现，或引入 `cryptography`）。
- `base_url` 只校验 http(s)，不封内网地址：自托管场景下「接本地中转站」是合法用法，
  部署到公网时应在外层网络策略上限制出站。
- 全局兜底默认关闭：管理员需要在后台把 `AI_RELAY_ALLOW_GLOBAL` 打开，才允许未配置用户使用公共中转。
