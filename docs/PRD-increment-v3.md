# canvas-studio 增量 PRD（v3）

> 本文只描述**第三轮增量**。一期（`docs/01-prd.md`）与二期（`docs/PRD-increment-v2.md`，R01–R21 + D1–D7）已交付内容视为基线，不重述。
> 文档性质：增量需求说明。读者：架构师 / 前后端开发 / 测试。
> **状态：第一步（§1–§3）已定稿；§4 UI 交互规格、§5 企业级能力矩阵、§6 待确认问题在第二步补齐。**

---

## 0. 与前两轮的关系

| 维度 | 基线（不改） | 本轮增量（v3） |
|---|---|---|
| **功能** | 一期 P0-01～P2-06；二期 R01–R21 全部能力（transmission 层重试链、双层 fallback、plan 契约、7 个编辑工具、去框、画布 6 项） | 不新增业务概念，只做**「二期已设计但未真正生效」的收口** + **可达性修复** + **体验补齐** |
| **视觉** | `frontend/src/styles/tokens.css` v3「warm paper + ink + lime」：纸 `#F4F1E9` / 墨 `#14130D` / 青柠 `#CDF564` | 在既有 token 上做**应用层打磨**；不新增色板、不改 token 名 |
| **架构** | L1 传输层（`relay_types` + `relay_service` + `relay_chain`）/ L2 语义层（`compose_service._call_json` + `plan_validator`）两层分工 | 不换分层，只**修正 L1 的控制流**与**补齐 L2 的字段校验覆盖** |

> **口径澄清（重要）**：`docs/09-visual-language-v2.md` 描述的是「陶土橙 + 靛蓝」旧色板，**已废弃**。本文所有色值一律以 `tokens.css` 的纸/墨/青柠为准，不引用 09 号文档任何色值。

**三条硬约束（本轮新增需求不得违反）**

1. **歧义必须停**：`status=clarify` 时不建任务、不扣额度，必须经用户点选方案并 `confirm` 后才建任务。
2. **建任务只用模型产出的 `final_prompt`**：用户原话只作模型输入；模型没给出可用 `final_prompt` 时**如实失败**，不建任务、不扣额度、不用用户原话兜底。
3. **额度唯一真源 `quota_service`**；所有接口统一包裹 `{code,data,message}`；前端只调 `/api/*`；所有图片处理走上游 gpt-image-2 按编辑单价计费，**禁止本地像素处理冒充生成结果**。

---

## 1. 产品目标

### 1.1 本轮要解决（5 条，均可度量）

| # | 目标 | 度量口径 | 对应需求 |
|---|---|---|---|
| **G1** | **「换备用模型」真正生效**：上游返回非 JSON 时，链会继续往下走而不是提前终止 | 注入式故障（HTML 体 / 空体 / 截断 JSON / 顶层非 dict / 502）下，`attempts` 中**出现 ≥ 2 个不同模型名**的用例占比 ≥ 90%；`stopped=True` 只因「fatal 配置错误」或「预算/超时耗尽」触发，grep 断言 ≤ 2 处赋值点 | R1-1 / R1-2 / R1-3 |
| **G2** | **格式类错误前端可读**：`UPSTREAM_FORMAT_ERROR` 不再跌到兜底文案 | 前后端错误码集合**完全相等**（断言用例）；该错误码在 zh-CN / en 两套 i18n 均有专用文案；用户可见文案不含 `json` / `HTML` / 异常类名 / 堆栈 | R1-4 / R1-5 |
| **G3** | **输出契约「有定义即被校验」**：`plan_validator` 覆盖 compose 三阶段全部字段 | 契约字段清单与校验分支数一一对应（缺一个字段 → 一条失败用例）；6 条 golden 需求首次通过率 ≥ 90%、3 次内 100%；模板兜底占比 ≤ 5% | R2-1 / R2-2 / R2-3 |
| **G4** | **编辑功能全部可达**：工具条入口数与 `Tool` 联合类型成员数相等 | `Tool` 联合类型 7 个成员 ↔ 工具条 7 个按钮（脚本断言数量相等）；边框/标记在亮暗双主题下可绘制、可拖动、可删除、可撤销 | R4-1 / R4-2 / R4-3 |
| **G5** | **AI 回答视觉降噪 + 画布质感达标**：回答区静态态描边包裹清零 | `components/chat/**` 中静态态 `ring-1 ring-inset ring-border-faint` 组合命中数 = 0（白名单见 R3-1）；画布 5 项视觉标准逐条签字 + 亮暗双主题截图各 1 张 | R3-1 / R3-2 / R5-1 / R5-2 |

### 1.2 本轮明确不解决（划边界，防止范围膨胀）

| # | 不做 | 原因 |
|---|---|---|
| N1 | 不做多人实时协作（光标 / 评论 / 冲突合并 / 角色权限） | 需要 CRDT 或 OT 与数据模型重构，单独立项；本轮 R6 只做「权限校验缺口」与「操作审计」这类低成本企业级门槛 |
| N2 | 不做多页画布 / 版本树 / 分支对比 | 与「单画布内打磨」目标正交，架构影响大 |
| N3 | 不引入本地像素级图像处理管线（曲线、蒙版、图层混合） | 违反铁律 3（所有图片处理走上游）；编辑层保持「选区 + 指令」模型 |
| N4 | 不改计费与配额规则 | 重试发生在文本编排层，本就不产生配额变动；不动 `quota_service` 口径 |
| N5 | 不做移动端 / 平板专项适配 | 本轮只在 ≥ 1280px 桌面验收；一期响应式断点（1440/1024/768/390）**不得回归**，但不要求新组件四档最佳 |
| N6 | 不做技能库后台可视化编辑器 | 既有产品决策：技能随代码版本走，避免后台一改全站风格漂移；本轮只补只读预览 |
| N7 | 不新增推理/生图 provider，不换上游 | 继续用现有中转站抽象与 gpt-image-2 |

---

## 2. 用户故事

> 每条采用「因为…我希望…以便…」，按角色分组。括号内为本条服务的需求编号。

### 2.1 内容创作者（不懂技术，只想出图）

- **US-1** 因为上游中转站时不时抽风、返回一段网页或空白，**我希望**系统自己换一个模型接着做而不是直接告诉我「出错了」，**以便**我不用理解什么是 JSON、也不用去配置页排查。（R1-1 / R1-2）
- **US-2** 因为我不确定是「我的中转站配错了」还是「上游临时故障」，**我希望**错误提示能说清「已经试过哪几个模型、下一步该点哪个按钮」，**以便**我能自己解决或者果断换一家中转站。（R1-4）
- **US-3** 因为我在赶稿、只想快点拿到图，**我希望** AI 的回答像一位设计师在白纸上跟我说话，而没有一堆灰框卡片把内容切碎，**以便**我的注意力落在「它说了什么」而不是「它又被装进哪个盒子」。（R3-1 / R3-2）
- **US-4** 因为我经常要一次说清「这张图三处都要改」，**我希望**能直接在图上画框圈出来、用箭头和序号标出第 1 处第 2 处，**以便**我不用来回描述坐标，也不用反复解释「不是那个位置」。（R4-1 / R4-2）

### 2.2 设计师（重度用户，在意手感与确定性）

- **US-5** 因为我每天要在画布上待几个小时，**我希望**画布像一张摆好的工作台——有留白、有投影、有网格、选中一眼可见，**以便**长时间工作不会觉得这个工具「廉价」。（R5-1 / R5-2）
- **US-6** 因为我已经在对话里确认过「竖版 2:3、低饱和、柔光」，**我希望**建出来的任务与我确认的方案完全一致（提示词、比例、负向词都对得上），**以便**我不用靠运气重抽。（R2-1 / R2-2 / R2-3）
- **US-7** 因为我的提示词会被技能模板撑得很长，**我希望**系统在超长时自己收敛到合法长度、而不是报一个「格式错误」让我重试，**以便**我不必手工删词。（R2-4）

### 2.3 运营（对结果负责，需要过程可追溯）

- **US-8** 因为我要向老板解释「为什么今天出图慢」，**我希望**能查到最近若干次编排试了哪些模型、哪一类失败最多、兜底占多少，**以便**我判断是该换中转站还是该调参数。（R6-1）
- **US-9** 因为一张图生成失败时额度必须原样退回、不能出现「失败还扣钱」，**我希望**失败路径的额度处理有明确的机检用例，**以便**我不用担心客诉。（R6-2）
- **US-10** 因为我要把出好的图交给下游（电商主图、朋友圈、印刷），**我希望**导出规格可选且标注清晰（尺寸、格式、是否含标注层），**以便**我不必再用第三方工具二次转换。（R6-3）

### 2.4 团队负责人 / 管理员

- **US-11** 因为要给团队开通账号并控制「谁能看谁的画布」，**我希望**权限校验覆盖到每个读写接口并有断言用例，**以便**我敢把链接发给外部合作方。（R6-4）
- **US-12** 因为团队里有人误删画布、有人重复触发同一个任务，**我希望**关键操作有审计记录、任务重试有幂等与断点续跑，**以便**出问题能定位、重试不会重复扣费。（R6-5 / R6-6）

---

## 3. 需求池

> **优先级口径**：**P0** = 阻塞主流程或让已交付能力不可用；**P1** = 体验显著受损；**P2** = 增强项。
> **编号规则**：`R{诉求序号}-{序号}`，与用户 6 项原始诉求一一对应（R1 中转站、R2 技能与输出约束、R3 去边框、R4 编辑器工具、R5 画布美化、R6 企业级）。
> **本轮全部为「收敛与补齐」**：不新增业务概念，交付物是可测的行为修正。

### 3.1 R1 — 中转站返回格式异常（重试 + 备用模型）

| 编号 | 一句话标题 | 现状 | 目标 | 验收标准（可观测、可测） | 优先级 | 影响面 |
|---|---|---|---|---|---|---|
| **R1-1** | 拆开 `stopped` 的三种语义 | `relay_chain.chat_resilient()` 用**一个** `stopped` 布尔同时表达「成功」「fatal 终止」「预算/超时终止」，成功路径也置 `stopped=True`；预算检查在 `while True` 内层触发时 `break` 出内层，外层靠 `stopped` 才停——语义耦合，改动一处容易漏 | 拆成**三个显式信号**：`success` / `abort_chain`（仅 fatal 配置类错误）/ `budget_hit`（`MAX_HTTP_CALLS` 或 `TOTAL_DEADLINE_S`）；成功不再复用终止标志；预算命中后外层必须跳出，且最终 `reason=BUDGET_EXHAUSTED` 与「最后一个真实失败原因」二者语义不混 | ① 单测：`html_body` → `http_5xx` → `ok` 三次调用，返回成功且 `attempts` 含 3 条记录、`models` 含 2 个不同模型名；② 单测：`auth_error`（fatal）后 **不再发起任何调用**（mock 调用计数 = 1）；③ 单测：预算耗尽时 `reason == budget_exhausted`，且**不得**把最后一次的 `html_body` 覆盖成品类之外的语义；④ `grep -n "stopped" relay_chain.py` 命中数 = 0 | **P0** | `backend/app/services/relay_chain.py`；单测 `backend/tests/test_relay_chain_stop_semantics.py`（新增） |
| **R1-2** | 让 `policy.switch_model` 真正驱动「换模型」 | `relay_types.FailurePolicy` 定义了 `switch_model` 字段，`FAILURE_POLICIES` 也按分类给了 `_RETRY_AND_SWITCH` / `_SWITCH_ONLY` / `_FATAL` 三档，但 `relay_chain` **只读 `fatal` 与 `retry_same_model`，`switch_model` 读取后从未使用**——于是「同模型重试用尽后换下一个模型」实际依赖「`while` 循环自然退出再进 for 下一轮」，一旦 `fatal`/预算命中就整链终止，「换备用模型」形同虚设 | 遍历逻辑改为**显式消费策略**：同一模型重试耗尽后，**若 `policy.switch_model` 为真则继续下一个 target（含跨 provider 候选）；若为假则终止整链**；`switch_model=False 且 fatal=False` 的组合必须被显式处理（不得静默落到「继续下一个」） | ① 单测覆盖三档策略：`_RETRY_AND_SWITCH`（同模型重试 1 次→换模型）、`_SWITCH_ONLY`（直接换模型）、`_FATAL`（不换、不回退）；② 单测：`switch_model=False, fatal=False` 的构造策略 → 整链终止且**不发起第二个模型的调用**；③ 断言 `chat_resilient` 内对 `policy.switch_model` 至少有一处**决策点**（AST/grep 双检，防止再次「定义了但不用」）；④ `FailureKind.HTML_BODY` 场景下：`attempts` 的模型数 ≥ 2（前提是链上配了备用模型） | **P0** | `backend/app/services/relay_chain.py` 遍历主循环；`backend/app/services/relay_types.py`（仅补注释与 `policy_for` 契约，不改预算常量）；单测 `backend/tests/test_relay_chain_switch_model.py`（新增） |
| **R1-3** | 网关 `demo:true` 散文不得被当成「模型正常回答」 | `gateway/app/services/demo_service.py` 的 `demo_chat_reply()` 返回中文散文（「【演示模式】已收到你的消息…」）；`gateway/app/services/chat_router.py` 在 `demo_mode=auto` 且上游 `PROXY_UNREACHABLE/UPSTREAM_ERROR/POOL_UNAVAILABLE` 时**静默降级**为这段散文；后端 `relay_service` 的 `_classify_failure()` 对 200 + 合法 JSON 一律判 `FAILURE_KIND.OK` → 散文被当成「模型输出」，一路进到 `_extract_json()` 才失败，错误归因落到「模型输出格式不对」 | 后端能识别「上游明确声明自己是演示态」：响应体含 `demo: true` 且正文非 JSON 对象时，分类为 **`UPSTREAM_REFUSED`**（宁可少试不滥试，语义即「对方明确拒绝了这次真实请求」），走 `switch_model` 换下一个模型；**不得**把演示文案当真实结果透传给用户 | ① 单测：mock 上游返回 `{"demo": true, "choices":[{"message":{"content":"【演示模式】…"}}]}` → `kind == upstream_refused`，且**不**进入 `_extract_json` 的语义纠错；② 端到端：网关 `demo_mode=auto` + 上游断连时，用户看到的是**结构化错误卡**（含 `reason` 与 `next_actions`），而不是一段「【演示模式】」文字；③ 显式降级路径不变：用户点「用本地模板先试一次」（`allow_degraded=true`）时仍可走模板并标注「本地模板」 | **P0** | `backend/app/services/relay_service.py`（`_classify_failure` 增加 demo 判定）；`backend/app/services/relay_types.py`（`ERROR_CODE_FOR` 无需改动，`UPSTREAM_REFUSED` 已存在）；`gateway/app/services/chat_router.py`（**只读**，作为行为依据，本轮不改网关降级策略） |
| **R1-4** | 前端补齐 `UPSTREAM_FORMAT_ERROR` 三处映射 | 后端 `app/utils/errors.py` 已有 `UPSTREAM_FORMAT_ERROR = "UPSTREAM_FORMAT_ERROR"`（HTTP 502）且 `relay_types.ERROR_CODE_FOR` 会把 9 类格式失败映射到它；但前端**三处都没有它**：`frontend/src/types/api.ts` 的 `ErrorCode` 联合类型、`frontend/src/lib/errors.ts` 的 `ERROR_I18N_KEY`（`Record<ErrorCode,string>` 缺键会导致 TS 报错或运行时兜底）、`frontend/src/i18n/locales/{zh-CN,en}/errors.json`。结果是这类错误一律落到 `errors.unknown` 兜底文案 | 三处同步补齐：类型加成员、映射表加键、两套语言各加一条**说清下一步**的文案；用户可见文案**不含** `json` / `JSON` / `HTML` / `HTTP` / 异常类名 / 堆栈 | ① `ErrorCode` 联合类型成员数 == 后端 `ErrorCode` 枚举成员数（断言用例，集合相等）；② `Record<ErrorCode,string>` 编译通过（TS 强约束，缺键即报错）；③ zh-CN / en 两份 `errors.json` 键集合相等且均含 `upstream_format_error`；④ 单测：`errorTextByCode('UPSTREAM_FORMAT_ERROR')` 返回文案 ≠ `FALLBACK_ERROR_TEXT`；⑤ 文案黑名单正则（`/json|html|http|traceback/i`）零命中 | **P0** | `frontend/src/types/api.ts`、`frontend/src/lib/errors.ts`、`frontend/src/i18n/locales/zh-CN/errors.json`、`frontend/src/i18n/locales/en/errors.json` |
| **R1-5** | 格式类错误卡展示「现象 / 已尝试 / 下一步」三要素 | 后端已产出结构化 `data`：`{reason, chain, attempts[], total_calls, elapsed_ms, next_actions[], trace_id}`（`relay_chain._raise_exhausted`），`relay_types.NEXT_ACTIONS` 也给了枚举；但前端**全项目零引用 `next_actions`**（grep 无命中），用户只看到一句兜底文案，看不到「已试过 A → B → C」 | 前端消费 `data.reason` / `data.attempts` / `data.next_actions` 渲染三段式错误卡：**现象**（按 `reason` 一句人话）／**已尝试**（`模型 × 次数 → 失败分类` 的紧凑列表）／**下一步**（`next_actions` 按枚举渲染成按钮，如「换个模型重试」「检查地址」「调大最大输出 tokens」）；`trace_id` 可复制供客服定位 | ① 单测：构造 `data.attempts` 含 3 个模型 → 错误卡渲染出 3 行「模型 / 次数」；② `next_actions` 每项都有对应按钮且可点，未知 action 不渲染空按钮；③ 点击「换个模型重试」用**同一需求**重发，用户无需重填；④ 全链路 `reason` 到 i18n key 的映射表存在且无缺失（遍历 `NEXT_ACTIONS` key 断言） | **P1** | `frontend/src/components/chat/ChatPanel.tsx`（错误渲染分支）、新增 `frontend/src/components/chat/UpstreamErrorCard.tsx`、`frontend/src/i18n/locales/{zh-CN,en}/errors.json` |
| **R1-6** | 中转站配置页展示「实际会遍历的链」 | `relay_chain.ChainPlan` 已能算出完整链（primary → 模型链 ≤2 → 跨 provider ≤1）且带 `backup_provider`（不含 Key），`/api/ai/status` 有 `chain_preview` 能力，但用户配置页看不到「我现在这套配置真出故障时会试哪些模型」 | 配置页展示只读的**链路预览**（最多 4 槽位 + 标注来源：本 provider 备用 / 跨 provider 互备）；结合 `R1-4/R1-5` 让「备用模型」从抽象概念变成可核对的名单 | ① 配置 3 个备用模型 → 预览显示「主模型 + 前 2 个 + 跨 provider 1 个」并按顺序编号；② 预览**不出现** `base_url` 与 Key（只有 provider `name` 与模型名）；③ 未配备用模型时显示「未配备用模型，主模型失败会直接报错」而不是空白 | **P2** | `frontend/src/pages/**`（中转站配置页）、`frontend/src/lib/api/ai.ts`；后端需确认 `/api/ai/status` 暴露 `chain_preview` |

### 3.2 R2 — 生图 skills 模板与严格输出约束

| 编号 | 一句话标题 | 现状 | 目标 | 验收标准（可观测、可测） | 优先级 | 影响面 |
|---|---|---|---|---|---|---|
| **R2-1** | 契约字段与校验分支一一对齐 | `plan_validator` 有 `validate_plan()` / `validate_analysis()` / `build_repair_hint()` / `assert_dispatchable()` / `normalize_plan()` 五个入口，但覆盖不全：`analyze` 阶段仅 `validate_analysis()` 做弱校验、`reason` 阶段走的是 `schema=None` 的「能解析成 dict 就算过」路径、`skill_id` 命中与 `final_prompt` 含 style_tag 只在 `validate_plan` 内做跨字段检查 | 三阶段（analyze / reason / prompt）**全部走同一份契约**：`compose_plan.py` 的字段清单 → 每字段至少一条校验分支（必填 / 类型 / 枚举 / 长度 / 跨字段）；`schema=None` 的宽松路径**只允许**在明确标注「非契约输出」的调用点保留 | ① 契约字段清单与校验分支存在映射表，任一字段缺分支 → 对应用例失败（参数化用例，字段数作为用例数）；② 单测：`reason` 阶段返回缺 `negative` 的 plan → 触发纠错重试而不是静默通过；③ 单测：`skill_id` 不存在 → 走纠错提示（含字段路径 `skill_id` 与「必须来自给定技能清单」）；④ `grep "schema=None"` 的调用点每一处都有「非契约输出」注释与测试依据 | **P0** | `backend/app/services/plan_validator.py`、`backend/app/schemas/compose_plan.py`、`backend/app/services/compose_service.py`（`_call_json` 调用点）；单测 `backend/tests/test_plan_validator_coverage.py`（新增） |
| **R2-2** | 纠错提示必须带「字段路径 + 期望」，且只对 5 类问题重试 | `build_repair_hint()` 已能拼「路径 + 人话」，`_call_json` 有 `MAX_SEMANTIC_ATTEMPTS` 上限与 `template_fallback` 兜底；但**哪些问题进纠错、哪些不进**没有集中定义，「超长」「技能召回为空」这类**不该重试**的问题可能与真格式漂移混在一起消耗预算 | 集中定义**可纠错问题白名单**（缺必填 / 类型错 / 枚举越界 / `skill_id` 不存在 / JSON 结构不合规），白名单外的问题**不重试**、直接走本地处理或如实失败；纠错提示必须包含具体字段路径与期望，禁止只发「请输出合法 JSON」 | ① 5 类问题各 1 个用例，均触发 1 次纠错重试且提示文本含对应字段路径；② 负面用例：`final_prompt` 超长 → **不触发纠错重试**（调用计数 = 1）；③ 负面用例：技能召回为空（无 `style_tags` 可比）→ **不判为格式漂移**，走「如实失败 + 明确下一步」；④ 3 次仍不合法 → `source=template_fallback` 且**不阻塞**建任务，非法输出前 200 字符落日志 | **P0** | `backend/app/services/plan_validator.py`、`backend/app/services/compose_service.py`；单测 `backend/tests/test_repair_scope.py`（新增） |
| **R2-3** | 出图前硬约束必须在扣费之前 | `compose_service` 的 `assert_dispatchable()` 与 `pre_deduct()` 的调用顺序是「校验失败但钱已扣」的唯一风险点；二期已要求「校验是纯函数且在 `_dispatch()` 之前」，需**机检固化**而非靠人记 | 拼装 + 硬约束校验保持**纯函数**且在 `_dispatch()` 之前；任何新增校验不得放进 `_dispatch()` 内部 | ① 单测：mock `quota_service.pre_deduct`，校验失败路径下**调用次数 = 0**；② AST/静态检查：`assert_dispatchable` 不在 `_dispatch()` 的调用链内；③ 端到端：构造缺负向段的 plan → 返回明确缺失项 + 额度余额不变（前后读一次余额断言相等） | **P0** | `backend/app/services/compose_service.py`、`backend/app/services/quota_service.py`（只读，不改口径）；单测 `backend/tests/test_dispatch_guard_before_deduct.py`（新增） |
| **R2-4** | 超长提示词本地收敛（不进纠错重试） | `compose_plan.py` 定义了 `MAX_PROMPT_CHARS`，但仓库内**除定义处外零引用**；即「契约上限」写在纸面上、没有本地收敛函数，超长只能靠模型自己变短（概率事件） | 实现本地 `smart_truncate()`：按 `。！？` → `；` → `\n` → `，` 逐级降级切分、硬截断保底；截断事件落日志（原长 / 截断后长度 / 降级到哪一级）；截断**不计入**纠错重试 | ① 单测：1500 字符边界（1499 / 1500 / 1501）行为正确，1501 走截断且结果 ≤ 上限；② 单测：无标点的超长串 → 硬截断保底且不抛异常；③ 日志断言：截断记录含原长与降级级别；④ 调用计数断言：超长场景下模型调用次数 = 1（未触发纠错） | **P1** | `backend/app/services/plan_validator.py`（或新增 `backend/app/utils/text_truncate.py`）、`backend/app/schemas/compose_plan.py`（常量引用打通） |
| **R2-5** | 技能库模板对用户可见（只读） | `design_skills.py` 有 16 类 78 条技能（`prompt_scaffold / negative / aspect / style_tags / slots / pitfalls`），前端 `SkillLibraryPanel` 已能检索，但用户看不到「这条技能到底会给我的提示词加什么」 | 技能可展开查看骨架、负向词、比例、翻车点；「用这个技能」一键填入输入框；**只读**，不提供后台编辑 | ① 任一技能展开可见 5 个字段（无 `slots` 的技能优雅降级）；② 点「用这个技能」后输入框内容变化且可撤销；③ 技能数 78 条与后端 `design_skills` 一致（断言用例，防止前后端清单漂移） | **P2** | `frontend/src/components/chat/SkillLibraryPanel.tsx`；后端 `GET /api/ai/skills`（已存在，只读） |
| **R2-6** | 编排过程可观测（失败分类 / 兜底占比 / 截断率） | 每次 `RelayAttempt` 都有 `model/provider/try_index/reason/http_status/elapsed_ms`，但只在错误卡与日志里用；没有「按时间窗口聚合」的视图，运营无法回答「今天格式失败占多少」 | 管理员可见最近 N 次编排的聚合统计：尝试链分布、失败分类 Top、schema 首次通过率、模板兜底占比、超长截断率 | ① 面板数据与单次运行日志可对账（抽样 3 条记录逐字段核对）；② 指标口径与本 PRD §1.1 的 G1/G3 完全一致（同一份计算代码，不重复实现）；③ 无数据时显示空态而非 0 值假象 | **P2** | `backend/app/routers/admin/**`、新增聚合服务；前端管理页 |

### 3.3 R3 — AI 回答去边框（Lovart 式）

| 编号 | 一句话标题 | 现状 | 目标 | 验收标准（可观测、可测） | 优先级 | 影响面 |
|---|---|---|---|---|---|---|
| **R3-1** | AI 回答区「静态态」描边与阴影清零（按白名单） | AI 纯文本气泡本身已无边框（`ChatMessage.tsx` AI 分支只有 Avatar + Markdown）。真正造成「盒子感」的是 **5 类过程/结果容器**统一使用 `rounded-md bg-surface shadow-sheet ring-1 ring-inset ring-border-faint`：`ThinkingTrace.tsx`（`overflow-hidden` 那条）、`SkillRunCard.tsx`、`ClarifyCard.tsx`、`GenerationResultCard.tsx`，以及时间线里 `ChatPanel.tsx` 约 1261 行附近的 `ml-9` 嵌套容器；`Markdown.tsx` 的 `blockquote` 用左边框、`hr` 用横线 | 按**最小必要层级**去框：① **纯文本回答**：无容器、无边框、无背景、无阴影，直接排版；② **过程块**（思考轨迹 / 技能链）：去 `ring` 与外层 `shadow`，收成一行可展开摘要，展开后靠缩进 + 字色分层；③ **可交互卡片**（方案卡 / 澄清卡 / 结果卡）：静态态去 `ring` 与 `shadow`，仅交互时给反馈；④ **保留**：结果图本身的圆角 + 投影（图即容器）、错误态的左侧 2px 语义色条 + 浅底色（「色条」不是包围框） | ① `grep -rn "ring-1 ring-inset ring-border-faint" frontend/src/components/chat/` 命中数 = 0，**白名单例外**仅限：`ChatTextarea.tsx`（输入区不是回答区）、`SkillLibraryPanel.tsx`（独立面板）、`PolishPopover.tsx`（浮层）、`ActiveTasksPanel.tsx`（任务面板）——白名单在测试里显式列为常量；② 纯文本回答 DOM 上**没有** `bg-*` / `ring-*` / `shadow-*` 祖先容器（单测用 Testing Library 断言层级）；③ 过程块静态态 `box-shadow == none` 且 `outline == none`；④ 亮暗双主题截图各 1 张留档 | **P0** | `frontend/src/components/chat/ThinkingTrace.tsx`、`SkillRunCard.tsx`、`ClarifyCard.tsx`、`GenerationResultCard.tsx`、`ChatPanel.tsx`、`ChatMessage.tsx`（仅结构，不改文案） |
| **R3-2** | Markdown 内元素去框 + 回答节奏 | `Markdown.tsx` 的 `blockquote` 用左边框、`hr` 用横线、`code` 块有描边；长回答靠「框」分段，视觉噪点集中在容器边缘 | `blockquote` → 左侧 16px 留白 + 次级字色；`hr` → 24px 空白；行内 `code` 保留浅底去描边；`pre` 保留底色与横向滚动；分段改用「间距 + 小标题」而不是线 | ① `Markdown.tsx` 中 `border-l`（`blockquote`）与 `border-t`（`hr`）命中数 = 0；② 一段含 `h2 / 列表 / 引用 / 代码 / 表格` 的回答渲染后，相邻块的垂直间距 ≥ 16px（计算样式断言）；③ 表格只保留横向分隔线，无外框；④ 暗色下引用块与正文仍有可辨层级（对比度 ≥ 4.5:1） | **P0** | `frontend/src/components/chat/Markdown.tsx`、`frontend/src/index.css`（如需新增排版工具类） |
| **R3-3** | 操作按钮悬停浮现、不占位 | `ChatMessage.tsx` 的复制按钮已是 `opacity-0 group-hover:opacity-100`（正确），但过程块内部的操作（复制提示词、重试）常驻占位，挤压文字宽度 | 所有回答区次要操作统一为「悬停浮现不占位」：`opacity-0 → group-hover/focus-visible` 显示；触屏（`pointer: coarse`）无 hover，改为**常驻低对比**图标 | ① 桌面端静态截图里次要操作不可见，`Tab` 聚焦时可见（键盘可达）；② 按钮出现/消失不引起文字重排（`Layout` 位移 = 0，用 `getBoundingClientRect` 前后比对）；③ 触屏模拟（`pointer: coarse`）下按钮可见 | **P1** | `frontend/src/components/chat/ChatMessage.tsx`、`ThinkingTrace.tsx`、`SkillRunCard.tsx` |
| **R3-4** | 暗色主题下的层级可辨（去框的兜底） | 去框后若暗色下 `surface` 与 `bg` 明度差不足，过程块会「糊进背景」，等于把信息藏起来 | 暗色下相邻分组靠**底色差 + 间距**仍可辨：过程块与正文底色差在暗色 token 下保持可感知，组间距 ≥ 12px | ① 暗色截图人工核对 6 处（用户消息 / AI 文本 / 过程块 / 方案卡 / 结果卡 / 错误态）逐项签字；② 文字与背景对比度 ≥ 4.5:1（正文）/ ≥ 3:1（大字），逐项核对表随交付提交 | **P1** | `frontend/src/styles/tokens.css`（暗色块，仅调应用不改 token 名）、`frontend/src/components/chat/**` |

### 3.4 R4 — 编辑器核心功能补齐

| 编号 | 一句话标题 | 现状 | 目标 | 验收标准（可观测、可测） | 优先级 | 影响面 |
|---|---|---|---|---|---|---|
| **R4-1** | 工具条补上「边框」入口 | `annotations.ts` 已定义 `BorderAnnotation`（`shape: rect｜ellipse`、`dash: solid｜dashed`、`box`）；`ImageEditLayer.tsx` 已有 `borderTool` 判定、`handleBorderDown/Move/Up` 交互层、`borderShape`/`borderDash` 状态与 `Tool` 联合类型成员，**但工具条按钮渲染里没有它**（现只有框选 / 套索 / 画笔 / 标注 / 橡皮，见 `setTool('...')` 的 5 处调用） | 工具条新增「边框」按钮；点开子面板选矩形/椭圆、实线/虚线；拖拽绘制；松手生成**标注对象**（不产生选区、不弹指令气泡）；可拖动位置、可删除、可撤销重做 | ① 点击「边框」后 `tool === 'border'`（可用 `data-tool` 属性断言）；② 拖拽 120×80 → 生成 1 个 `kind==='border'` 且 `box` 归一化值在 ±0.01 误差内；③ 椭圆与虚线各绘制一次，`shape`/`dash` 字段正确；④ `Ctrl+Z` 撤销后对象数为 0，重做后恢复且**不重复**；⑤ 亮/暗双主题下均可见（描边色与画布对比度 ≥ 3:1） | **P0** | `frontend/src/components/canvas/ImageEditLayer.tsx`（工具条渲染 + 子面板）、`frontend/src/components/canvas/annotations.ts`（已具备，不改）、`frontend/src/components/canvas/AnnotationLayer.tsx`（已具备） |
| **R4-2** | 工具条补上「标记」入口 | `MarkerAnnotation` 已定义（`shape: arrow｜index｜label`、`from/to`、`text ≤ 20`、`index 1..99`）；`handleMarkerDown/Move/Up`、`markerShape` 状态、文字标签就地输入框、`ANNOTATION_LABEL_MAX` 全部已实现，**唯一缺口同样是工具条没有入口** | 工具条新增「标记」按钮；子面板选箭头/序号/文字；箭头拖拽绘制、序号点一下自动递增、文字就地输入 ≤20 字；可拖动、可删除、可撤销 | ① 点击「标记」后 `tool === 'marker'`；② 连续放 3 个序号 → `index` 依次递增且不重号，且**不与选区编号撞号**（从 `regions.length + 1` 起算）；③ 文字标签输入 25 字被截断到 20 字；④ 箭头拖拽方向与 `from→to` 一致（角度误差 ≤ 2°）；⑤ 删除中间序号后剩余序号**不回收重排** | **P0** | `frontend/src/components/canvas/ImageEditLayer.tsx`（工具条渲染 + 子面板）、`annotations.ts`（已具备） |
| **R4-3** | 工具条信息架构与可达性 | 现有 5 个工具平铺、`gap-0.5`、每个只有图标 + 极短 tooltip、`Tool` 有 7 个成员但只有 5 个入口（用户不可达 2 个）；无快捷键提示 | 7 个工具分 3 组：**选区**（框选/套索/画笔）｜**标注**（标注/边框/标记）｜**擦除**（橡皮）；组间细分隔；每个工具有名称 + 快捷键 + 一句说明；当前工具高亮；同一时刻只激活 1 个 | ① 工具条按钮数 == `Tool` 联合类型成员数（脚本断言，防再次漏渲染）；② 3 个分组标签存在且顺序固定；③ 每个按钮 `aria-label` 非空、`title` 含快捷键；④ 快捷键 `R/L/B/P/F/M/E`（以代码 `SHORTCUT` 常量为准）逐个按下后 `tool` 正确切换；⑤ 键盘 `Tab` 可遍历全部 7 个按钮（focus 可见） | **P1** | `frontend/src/components/canvas/ImageEditLayer.tsx`、`frontend/src/i18n/locales/{zh-CN,en}/canvas.json` |
| **R4-4** | 套索可用性复核 | 套索已可用（`handleLassoDown/Move/Up`、多边形闭合、`lassoPoints` 预览），但离屏抽稀、过小选区、快捷键与说明未复核 | 四条：顶点抽稀后仍能闭合；选区面积过小时提示而非生成空选区；`L` 可激活；tooltip 说明「自由圈选不规则区域」 | ① 20 个以上顶点快速圈选 → 闭合成功、`path.length ≥ 3`；② 圈选面积 < 图面积 0.3% → 出现提示且**不生成** region；③ 按 `L` 后 `tool === 'lasso'`；④ tooltip 文案包含「不规则」 | **P2** | `frontend/src/components/canvas/ImageEditLayer.tsx` |
| **R4-5** | 标注图层显隐与「纯标注无选区」的包围盒可见 | `AnnotationLayer.tsx` 已实现 `visible`/`onToggleVisible`/`fallbackBox`，`ImageEditLayer` 也算了 `fallbackBox = regions.length === 0 ? annotationsBBox(annotations) : null`；需确认在**提交前**始终可见（不能黑箱） | 提交前始终显示全部标注的包围盒（虚线框 + 尺寸标签）；标注图层可一键显隐，隐藏时数据保留 | ① 只有 2 个边框标注、0 个选区时，画面上出现虚线包围盒 + 尺寸标签（如 `320 × 180`）；② 点提交后日志 `annotations: {border:n, marker:n, doodle:n}` 计数正确；③ 显隐开关切换后数据不丢（重新显示原位重现） | **P1** | `frontend/src/components/canvas/AnnotationLayer.tsx`、`ImageEditLayer.tsx` |

### 3.5 R5 — 画布区域美化

| 编号 | 一句话标题 | 现状 | 目标 | 验收标准（可观测、可测） | 优先级 | 影响面 |
|---|---|---|---|---|---|---|
| **R5-1** | 画布容器分层：点阵网格 + 内容夹（mat）+ 安全边 | `tokens.css` 已有 `--color-canvas`（`#ece6d9`）/ `--color-canvas-dot`（`#d4cab5`）/ `--color-gutter`（`#e2dbca`）/ `--color-mat`（`#ffffff`）/ `--shadow-lift` / `--shadow-glow` 一整套；`WorkspaceView.tsx` 画布卡用的是 `rounded-[16px] bg-canvas shadow-sheet`，但**没有点阵、没有内容夹、内容贴边**，`--color-canvas-dot` 与 `--color-mat` 在画布内基本未被消费 | ① 画布底铺点阵网格（`--color-canvas-dot`，24px 间距），缩放 < 40% 时淡出；② 图片落位带「相纸衬边」（`--color-mat`，`--radius-sheet` 近直角）+ 默认 `--shadow-lift`；③ 画布内容四周安全边 ≥ 64px，新图片落位**自动居中**而不是贴左上 | ① 网格间距 24px（截图 + 计算样式双验），缩放 30% 时网格 `opacity < 0.15`；② 新插入图片的包围盒中心与视口中心偏差 ≤ 8px；③ 图片默认投影非 `none`，衬边可见（放大截图核对）；④ 内容贴边检测：视口内任一边距 < 64px 时判定失败（脚本读 element rect） | **P1** | `frontend/src/components/canvas/CanvasExcali.tsx`、`WorkspaceView.tsx`、`frontend/src/index.css`（网格背景工具类） |
| **R5-2** | 画布空态与工具岛层次 | 画布空白时无引导（`WorkspaceView` 只有生成占位骨架与左下角预览），用户第一眼判断不了「这产品会不会用」；底部工具岛 `CanvasToolbar.tsx` 已有胶囊 + `backdrop-blur` + `ring-1 ring-border-faint` + `shadow-lift`，`bottom-3`（12px），但图标与投影强度未统一 | ① 空画布居中一行引导（≤ 14 字）+ 一个主操作（上传/新建），不放大插画；② 工具岛图标统一 16px、hover 上浮 1px、距底边 12px、投影用 `--shadow-lift` | ① 空态在 1280 / 1440 两档下均垂直居中（偏差 ≤ 16px）；② 空态只有 1 个主按钮（次级入口放次级样式）；③ 工具岛所有图标 `width/height == 16`；④ hover 位移 `translateY(-1px)` 且过渡 ≤ 200ms（`--dur-2` / `--ease-out`）；⑤ 亮暗双主题截图各 1 张 | **P1** | `frontend/src/components/canvas/WorkspaceView.tsx`、`CanvasToolbar.tsx`、`frontend/src/components/ui/empty-state.tsx` |
| **R5-3** | 三栏分区用色差替代描边 | 去框后三栏需要补回分区信息，否则会糊成一片；`--color-gutter` 的语义就是「工作台分栏缝隙：比画布再深一档」，但目前除 `@theme inline` 桥接外**零消费** | 三栏容器使用 `bg-gutter` 色差分区，**不加 1px 分隔线**；与 R3 的去框配套 | ① 三栏之间存在可见色差且无 `border-l/r`（grep 断言）；② `--color-gutter` 被至少 1 处组件消费（grep 断言）；③ **不得删除** `index.css` 里的 `@theme inline` 桥接声明（删除后 `bg-gutter` 会失效，属已知陷阱） | **P1** | `frontend/src/components/canvas/WorkspaceView.tsx`、`frontend/src/index.css` |
| **R5-4** | 图片选中态与 hover 反馈统一 | 选中态沿用 Excalidraw 默认蓝框，与纸/墨/青柠语言冲突；hover 无抬升 | 选中态：青柠描边 + `--shadow-glow` + 角点手柄；hover：`translateY(-1px)` + `--shadow-float`；多选显示外接框；隐藏 Excalidraw 默认选中样式 | ① 选中单图后描边色为青柠系（`--color-accent-strong` 或 `--color-select-line`），无默认蓝框；② hover 位移 1px、过渡 200ms；③ 多选 2 张出现外接框；④ 亮暗双主题下选中态均「一眼可见」 | **P1** | `frontend/src/components/canvas/CanvasExcali.tsx`、`frontend/src/index.css`（覆盖 Excalidraw 选中样式） |
| **R5-5** | 画布验收方式（本项目约定） | — | 交付时按 R5-1～R5-4 文字标准人工核对 + 亮/暗双主题截图各 1 张留档 | **不做像素 diff**（无设计基准图，先做基准图会多一轮返工）；核对表逐条签字 | **P2** | `docs/changes/**`（截图与核对表） |

### 3.6 R6 — 企业级能力梳理

| 编号 | 一句话标题 | 现状 | 目标 | 验收标准（可观测、可测） | 优先级 | 影响面 |
|---|---|---|---|---|---|---|
| **R6-1** | 错误可观测性与 trace 贯穿 | 后端错误 `data.trace_id` 已生成（`relay_chain._raise_exhausted`），前端零引用；日志有一行 `relay 链终止 … trace_id=…`，但用户看不到、客服拿不到 | 错误卡显示可复制的 `trace_id`；前端所有请求带 `X-Request-Id` 且后端日志可关联；错误分类可按窗口聚合（与 R2-6 共用同一聚合代码） | ① 错误卡上 `trace_id` 可一键复制；② 同一次失败的前端日志与后端日志能通过 `trace_id` 对齐（抽样 3 次）；③ 聚合指标与单次日志可对账 | **P1** | `backend/app/middleware/**`（或 `main.py`）、`frontend/src/lib/api/client.ts`、`frontend/src/components/chat/ChatPanel.tsx` |
| **R6-2** | 失败路径额度退回的机检用例 | `quota_service` 是唯一真源（`pre_deduct` 条件 UPDATE 原子扣减）；生图失败有退款逻辑，但**缺少「失败必退」的断言用例**，回归时容易破 | 建立三条额度不变式并固化为测试：① 校验失败（未建任务）→ 余额不变；② 建任务失败（上游报错）→ 余额退回；③ 重试（文本层）→ 不产生任何配额变动 | ① 三条不变式各 1 个单测，前后读余额断言相等/回到原值；② 单测覆盖 `pre_deduct` 的 `QUOTA_INSUFFICIENT` 分支（余额不足不产生扣款记录）；③ 用例在 CI 中常驻（不依赖人工） | **P0** | `backend/tests/test_quota_invariants.py`（新增）、`backend/app/services/quota_service.py`（只读） |
| **R6-3** | 导出规格明确化 | `CanvasExport.tsx` + `handleDownloadSelected(format)` 已有导出能力，但规格（格式、最大边长、是否含标注层、透明背景支持）未成文，用户不知道能导出什么 | 导出面板写明：可选格式（按实际支持列出，不虚构）、当前图尺寸、是否包含标注层（开关）、体积估算；导出文件名含尺寸与格式 | ① 导出面板字段与实际产物一致（抽样 3 次导出，格式/尺寸/文件名逐项核对）；② 「包含标注层」开关关闭时导出的图无标注（像素抽样比对）；③ 不支持的能力**不显示**为可选项 | **P1** | `frontend/src/components/canvas/CanvasExport.tsx`、`CanvasHeader.tsx`、`frontend/src/lib/api/assets.ts` |
| **R6-4** | 权限校验覆盖到每个读写接口 | 已有 `auth` / `me` / `projects` / `canvases` 等路由，但「他人项目不可读写」这类越权断言未成体系 | 建立**越权矩阵**测试：对每个含 `{id}` 的读写接口，用「非属主」身份调用必须 403/404，且**不泄漏**资源是否存在 | ① 越权矩阵用例覆盖所有含 `{id}` 的路由（路由清单作为参数化数据源，新增路由漏测时用例失败）；② 403 与 404 的返回不区分「不存在」与「无权限」以外信息；③ 矩阵报告可重复执行 | **P1** | `backend/tests/test_authz_matrix.py`（新增）、`backend/app/routers/**`（只读） |
| **R6-5** | 关键操作审计留痕 | `audit_service.py` 已存在，但覆盖范围（删除画布 / 改配额 / 改中转站配置 / 导出）未成文 | 明确 4 类关键操作写入审计（谁 / 何时 / 做了什么 / 对象 id），并提供只读查询 | ① 4 类操作各触发 1 次，审计表各增 1 条且字段完整；② 审计记录**不含** Key 与 prompt 全文（脱敏断言）；③ 普通操作（打开页面）不写审计，避免噪声 | **P2** | `backend/app/services/audit_service.py`、相关 routers |
| **R6-6** | 任务重试幂等与断点续跑边界 | 一期 §11 已定义「暂停 / 继续 / 放弃 / 刷新续接 / 幂等 / 不重复扣费」，本轮需确认**在新增的重试链下仍然成立**（文本层重试不产生配额变动，与生图任务重试是两件事，不能混） | 明确两条口径并测试：① 文本编排重试 = 同一次用户请求（不产生配额变动）；② 生图任务重试 = 同一次扣费（不重复扣款），刷新后任务可续接查询 | ① 单测：文本层 3 次调用后余额与配额流水条数均不变；② 单测：生图任务重试 2 次，`quota_transactions` 同 `ref_id` 仅 1 条扣款；③ 刷新页面后任务状态与进度可从后端恢复（手动 + 自动化各 1 次） | **P1** | `backend/app/services/task_service.py`、`quota_service.py`（只读）、`frontend/src/components/chat/ActiveTasksPanel.tsx` |
| **R6-7** | 无障碍与性能预算（最低门槛） | `prefers-reduced-motion` 已在 `index.css` / `motion.css` 做了降级（既有资产）；但编辑层工具按钮缺 `aria-label`（grep 命中 0），画布与对话区无性能预算 | ① 所有工具/图标按钮有 `aria-label`，键盘可完整操作编辑层；② 性能预算：对话流式渲染 60fps 无明显掉帧、首屏可交互 ≤ 2s（本地基线）、画布 200 个元素滚动/缩放可操作 | ① 编辑层全部按钮 `aria-label` 非空（脚本断言）；② `prefers-reduced-motion` 下无无限动画（人工核对）；③ 性能基线记录成文（本地跑分 + 设备信息），超预算 20% 需说明原因 | **P2** | `frontend/src/components/canvas/ImageEditLayer.tsx`、`frontend/src/index.css`、`docs/changes/**` |
| **R6-8** | 埋点（最小事件集） | 全项目无埋点（`track(` / `analytics` / `posthog` 均无命中），无法判断「哪个功能被用了、在哪一步流失」 | 仅埋 6 个关键事件：`compose_submitted` / `clarify_shown` / `clarify_confirmed` / `task_created` / `edit_annotation_used`（含 border/marker 子类型）/ `export_done`；**不采集** prompt 全文与图片内容 | ① 6 个事件在对应动作后各触发 1 次（可用 console/mock 断言）；② payload 无 prompt 全文、无 `api_key`、无图片二进制（字段白名单断言）；③ 关闭埋点开关后零请求 | **P2** | `frontend/src/lib/telemetry.ts`（新增）、各触发点组件 |

### 3.7 分布与依赖

| 优先级 | 数量 | 条目 |
|---|---|---|
| **P0** | **12** | R1-1、R1-2、R1-3、R1-4、R2-1、R2-2、R2-3、R3-1、R3-2、R4-1、R4-2、R6-2 |
| **P1** | **14** | R1-5、R2-4、R3-3、R3-4、R4-3、R4-5、R5-1、R5-2、R5-3、R5-4、R6-1、R6-3、R6-4、R6-6 |
| **P2** | **8** | R1-6、R2-5、R2-6、R4-4、R5-5、R6-5、R6-7、R6-8 |
| **合计** | **34** | 按诉求分：R1 = 6、R2 = 6、R3 = 4、R4 = 5、R5 = 5、R6 = 8 |

**依赖关系（影响施工顺序，供架构师排期）**

| 依赖 | 说明 |
|---|---|
| R1-1 → R1-2 | 先把 `stopped` 三语义拆开，`switch_model` 的决策点才有确定的位置可插；两件一起改容易互相掩盖 bug，建议同一 PR 但**两个 commit**、两套单测 |
| R1-2 → R1-3 | `upstream_refused` 只在「会换模型」时才有意义（否则识别出来也无处可去） |
| R1-4 → R1-5 | 没有错误码映射就没有正确文案；错误卡的三要素依赖 `UPSTREAM_FORMAT_ERROR` 先落地 |
| R2-1 → R2-2 | 对象字段校验覆盖到位后，才好判定「哪些问题该纠错」 |
| R2-4 独立 | 超长截断是纯函数，可与 R2-1/R2-2 并行 |
| R3-1 → R3-2 / R3-3 / R3-4 | 容器去框是主线，Markdown 内元素、按钮浮现、暗色兜底都是它的配套；R3-4 是 R3-1 的**验收前置**（暗色不可辨等于去框失败） |
| R4-1 / R4-2 并行 | 两者共用工具条改造，建议同时做；R4-3 是它们的收口（分组 + 快捷键） |
| R5-3 与 R3-1 联动 | 去框后必须补分区信息，两者验收应同批做 |
| R6-2 独立且**建议最先做** | 额度不变式是回归安全网，先有它，后面改 `_dispatch()` 才有底气 |

---

<!-- 第二步待补：§4 UI / 交互规格、§5 企业级能力矩阵（维度 × 现状 × 缺口 × 优先级）、§6 待确认问题 -->
