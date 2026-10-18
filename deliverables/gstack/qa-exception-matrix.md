# canvas-studio 异常容错与边界场景 · QA 定稿

> 口径：paused 本期 UI 不可达（运行中只有「停止生成」=cancel）；`task_timeout_seconds ≥ gw_read_timeout + 30`（≥330s）；**自动投放整体砍掉**（结果只进安全区，手动加入）；**不做 `paused→cancelled` 数据迁移**（走前端展示映射）。
> 测试环境前置：测错误/失败态前必须显式 `CS_DEMO_MODE=off`（`.env:15` 默认 auto，demo 走占位图会使失败态不复现、用例假绿）。
> 落地建议：AC-01/02/03/18/19/20 用 Playwright；其余可用 API/DB 断言。

## A. 异常矩阵

| # | 触发 | 现状（证据） | 期望 | 阻塞 | 验证 |
|---|---|---|---|---|---|
|1|3G 慢速提交生图|无 pending 态，按钮仍可点（ChatPanel.tsx:113-139）|disabled+「提交中…」+`aria-busy`|P0|throttle 连点|
|2|断网提交|toast 显示后端原文，含「VPN」（client.ts:70 + errors.ts:33-37）|「网络异常，请检查连接」|P0|offline|
|3|请求挂起|fetch 无超时，永久挂起无提示（client.ts:67）|≥30s 超时失败+可重试|P0|mock 挂起|
|4|上游 502/500|卡片拼 `· ${error_code}`（GenerationResultCard.tsx:78-82）；`error_message`=`str(exc)`（generate_service.py:217）|仅 errors.json 文案|P0|mock 502|
|5|上游 429|网关无重试（config_max_retries=2 vs gateway_client.py:57-80 无 retry）|退避重试 2 次|P1|mock 429|
|6|**【P0 根因】友好文案层从未生效**|`defaultNS:'common'`（i18n/index.ts:68）而 `errors.*` 键只在 errors ns；`nsSeparator` 默认 `:` → `t('errors.x')` 解析为 common 下嵌套路径 → common.json 无 `errors` 节点（仅 app_name/tagline/action/status/pagination/nav/unit/logout/theme/language/error_boundary）→ **100% miss → 100% 走 defaultValue/error.message**；全库 `useTranslation('errors')`/`ns:'errors'` 0 命中（50+ 调用点）。**修法须两步同时做**：① `ERROR_I18N_KEY` 值去掉 `errors.` 前缀改裸 key（`'upstream_error'`）② 调用处 `t(key,{ns:'errors'})`——只改 ns 不改裸 key，`errors.upstream_error` 仍会被当 errors ns 下的嵌套路径而继续 miss|错误文案唯一出口=errors.json，缺 key 回落 `errors.unknown`|P0|见 AC-05 运行期等值断言|
|7|上游返回空图|failed「上游未返回有效图片」+已退款 ✅（generate_service.py:223-227）|同左|—|已有覆盖|
|8|上游返回损坏图|`to_png` 兜底原样落库（generate_service.py:178-180）→ succeeded 但破图|failed+退款|P0|mock 随机字节|
|9|JPEG / 丢 alpha|后端转 PNG ✅、抠图本地兜底 ✅|同左|—|已有覆盖|
|10|结果 URL 404|全前端 0 处 `img onError`（GenerationResultCard.tsx:67-72、ResultDock.tsx:132-137）|三处占位：固定比例+图标+重试|P0|改 storage 文件名|
|11|生成中刷新|轮询恢复、任务重现 ✅|同左|—|已有 P0-30|
|12|生成中关标签页（对话流）|预扣永不退回（chat_service.py:166-219 不捕获 CancelledError；chat.py:96-98 已 commit 预扣）|断开即退款|P0|kill 页后查流水|
|13|生成中切会话|旧会话 in-flight 响应可覆盖新会话（use-polling.ts:39-47）|切换丢弃旧响应|P2|慢网快切|
|14|多标签页同 prompt|共享 localStorage 键→只建 1 任务（副作用见 #32）|同左|—|双标签|
|15|连点发送 10 次（对话）|无幂等键、裸 fetch 无去重（chat.ts:26-99）→10 条消息+10 次扣费|仅 1 条|P0|Playwright|
|16|回车连按|`sending` 时 Enter 仍触发（ChatTextarea.tsx:44-49）|发送中 Enter 无效|P0|按住 Enter|
|17|输入法选词回车|未判 `isComposing`（ChatTextarea.tsx:45）|不发送、不 preventDefault|P0|候选态回车|
|18|空输入框回车|`preventDefault` 在 `trim()` 前（ChatTextarea.tsx:45-47）→不发送也不换行|换行生效|P1|空框回车|
|19|粘贴 5000 字|后端 max_length=4000（schemas/generate.py:12,25）→422 非 envelope→「请求失败（HTTP 422）」（client.ts:85-87）|前端 `maxLength=4000`+计数|P0|粘贴实测|
|20|粘贴带换行|原样提交，卡片摘要单行截断 ✅|同左|—|视觉|
|21|额度不足 / 刚好够|canAfford 拦截 ✅；余额=单价放行 ✅|同左|—|已有|
|22|并发超上限（>2）|toast，无前置提示（task_service.py:98-105）|提交前禁用+剩余槽位|P1|连发 3 次|
|23|慢上游 200s|**被判 timeout 且退款，图已落资产**（task_timeout_seconds=180<读超时 300；generate_service.py:203 只 mark 一次；task_service.py:276-277 早退）|阈值≥330s+判定前确认上游已失联|P0|mock sleep 200s|
|24|慢上游 300s|同上，必失败|succeeded|P0|mock sleep 300s|
|25|进度表达|永停 30%→100%（generate_service.py:203 唯一写入、task_service.py:258 唯一实现）；running 文案无预期管理|结果卡无进度条元素与数字百分比；列表行可用不确定态细条；running 文案分级（见 AC-34）|P1|60s 连拍|
|26|会话删除中正在生成|仅切 sessionId（ChatPanel.tsx:203-212），任务/资产不级联|提示「任务将继续执行」|P2|实测|
|27|清空历史时任务仍在跑|卡片消失但额度照扣|延后清理或提示|P2|实测|
|28|**停止生成后上游迟到成功**|cancel 已退款（task_service.py:232-245），run_task 仍跑，`succeed` 早退→**图已落资产、URL 不写回、用户永不可见**（generate_service.py:235-246 在 succeed 前落库）|cancelled 保持、额度已退、迟到结果丢弃或标记不可见，assets 无新增孤儿|P0|停止后 mock 300s 返回|
|29|**存量 paused 任务**|前端无入口，回收器 330s 后判 timeout；期间卡片无任何按钮（task_service.py:318-337）|**不做数据迁移**：渲染为「已停止 · 额度退回中」+「重新生成」，禁止死卡|P1|造 paused 数据|
|30|queued 态|后端 create 直接写 running（task_service.py:122），queued 不可达；前端「排队中」为死状态且无按钮|只留「放弃」；或后端真正入队|P1|读 DB|
|31|「重试/再生成」|仅 `setInput(task.prompt)`（ChatPanel.tsx:169-175），不建任务|真发（新键+原位替换）|P0|点击后数任务|
|32|**同会话 5 分钟内第二次生图被吞**|键 scope 只有 `image:${sessionId}`，不含 prompt/quality/size/n（ChatPanel.tsx:126）；后端只按 key replay（task_service.py:88-93）→返回旧任务、清空输入（:130）、无提示；键存 localStorage（task-persistence.ts:56-69），刷新仍复现|键=一次用户动作，不落盘、不跨动作复用|P0|发 A 成功后发 B|
|33|重复点击同一结果|自动投放砍掉后 `isTaskPlaced` 判定的镜像缺陷消失，但手动入口仍无幂等|同张重复点击不新增元素|P1|连点两次|
|34|多图任务投放粒度|`markTaskPlaced` 为任务级（task-persistence.ts:97-108）|投放按 `taskId+url` 粒度，任务级标记随自动投放一并删除|P1|1 整图+3 素材|
|35|两个「加入画布」入口|结果卡 `urls.forEach` 全放 N 张（ChatPanel.tsx:185-191）；安全区单张（ResultDock.tsx:120-143）|同一动作产出张数一致|P1|两入口对比|
|36|上游脏数据注入（`error_message` 含 HTML/502/枚举）|卡片直渲染（GenerationResultCard.tsx:78-82），无转义无白名单|页面不含 `<`/`502`/`UPSTREAM`|P0|mock 脏 message|
|37|进行中面板出错|`toast.fromError(error)` 未传 `t`（ActiveTasksPanel.tsx:26→use-toast.ts:12）→必走 raw message（**修好 ns 后仍独立漏**）|同 #6|P0|对已结束任务点暂停|
|38|渲染期异常|根错误边界 `description={error.message}`（__root.tsx:10）|固定文案|P1|构造 throw|
|39|任务接口字段外泄|`GenerationTaskOut` 输出 `user_id`/`idempotency_key`/`upstream_task_id`/`params`（schemas/task.py:12-33），params 含 `base_image_url`/`ops`/`region`|字段白名单|P1|抓包|
|40|**cancelled 终态文案**|`error_message` 为 `str(exc)` 或内部状态串时直接渲染（GenerationResultCard.tsx:78-82）|终态文案走固定映射，不渲染 error_message|P0|造 cancelled 带脏 message|
|41|**砍掉自动投放后无通知**|结果只进安全区；dock 折叠时用户无感知（WorkspaceView.tsx:559-612 自动落图逻辑将删除）|结果到达时 toast 一次 + 折叠态角标|P0|折叠 dock 后生成|

## B. 状态迁移合法性表

| 迁移 | 用户可触发 | 前端应禁用 | 非法兜底 |
|---|---|---|---|
|queued→running|否（create 直接 running，task_service.py:122）|—|—|
|queued→cancelled|是（只留「放弃」）|—|—|
|running→cancelled|是（**停止生成**，二次确认）|in-flight 时禁用|幂等 ✅、余额回滚 ✅|
|running→succeeded/failed/timeout|否（仅后端）|—|收到即刷新卡片|
|paused↔running|**本期 UI 不可达**，不得暴露任何入口|—|存量任务渲染「已停止 · 额度退回中」+「重新生成」|
|终态→任意|否|全部禁用，只留「重新生成」|文案走固定映射（#40）|

## C. 验收标准

- **AC-01** Given 有内容，When 500ms 内连点 5 次，Then 只建 1 任务、只扣 1 次额度。
- **AC-02** Given 对话流式中，When 按 Enter，Then 消息数不变。
- **AC-03** Given 输入法候选态，When 按 Enter，Then 上屏且不发送（未 preventDefault）。
- **AC-04** Given 生图提交中，Then 发送按钮 disabled+「提交中…」+`aria-busy="true"`+输入框 `readOnly` 且保留焦点。
- **AC-05** Given 任一用户可见错误文案，Then ① 正则 `/(http|HTTP|Error|Traceback|5\d\d|upstream|UPSTREAM|code)/` 无命中；② **运行期等值断言：mock 一次 `UPSTREAM_ERROR`，toast 文本必须 `===` `errors.json` 中 `upstream_error` 的值**（静态正则查不到"文案根本没被取到"，此条是唯一能证明闸门通了的手段）；③ 直接断言 `t('upstream_error',{ns:'errors'})` 返回中文而非 key 本身；④ 切 en 后同一文案随之变化。四条全过才算修好——只改 ns 不改裸 key 仍会 miss。
- **AC-06** Given 上游 502，Then 文案 ∈ errors.json 固定集，不含 `error_code` 字面、不含后端 envelope.message。
- **AC-07** Given 损坏图片字节，Then failed 且余额回滚。
- **AC-08** Given URL 失效，Then 三处（结果卡/安全区/画布）固定比例占位+「图片加载失败」+「重试」，无破图图标、无抖动。
- **AC-09** Given 轮询连续失败 ≥3 次，Then 「网络已断开，正在重连」；恢复后 ≤5s 刷新。
- **AC-10** Given 请求 30s 无响应，Then 超时失败+可重试。
- **AC-11** Given mock sleep **200s** 与 **300s**，Then 均 succeeded（任一 timeout 即失败）。
- **AC-12** Given 对话流中关闭页面，Then 该 ref 流水 status ≠ processing。
- **AC-13** Given 5000 字，Then `maxLength=4000` 拦截、>3600 出计数、发送 disabled，不发请求。
- **AC-14** Given 向上滚动，When 追加内容，Then 不强制拉底（距底 <80px 才跟随）。
- **AC-15** Given 已有 2 个活跃任务，Then 发送 disabled + 剩余槽位 0。
- **AC-16** Given 任一控制按钮，When 请求未返回，Then disabled（无重复 409 toast）。
- **AC-17** Given running，Then 只有「停止生成」、无「暂停/继续」；二次确认含「本次不扣额度」；确认后 cancelled 且余额回滚。
- **AC-18** Given 发 A 成功后 5 分钟内发 B，Then 任务数 +1 且新任务 prompt===B；键不得来自 localStorage 跨动作复用。
- **AC-19** Given 任务成功，When 等待结果出现，Then 画布元素数不变（**不自动落图**）；点击安全区后 +1；再次点击同一张不变。
- **AC-20** Given 空输入框，When 按 Enter，Then 换行生效且不发送。
- **AC-21** Given 任一卡片，When 点「重新生成」，Then 3s 内出现新任务 id（≠原 id）且旧卡原位替换。
- **AC-22** Given 已 cancelled，When 上游 300s 后返回成功，Then 仍 cancelled、额度已退、assets 无该 task 新增行。
- **AC-23** Given 1 整图+3 素材，When 从安全区逐张点，Then 每张独立投放、重复点同一张不新增（投放标记按 `taskId+url`，任务级标记已删除）。
- **AC-24** Given 同一任务，When 分别从结果卡与安全区点「加入画布」，Then 两入口产出张数一致。
- **AC-25** Given 任务运行中，Then **结果卡内不得出现任何数字百分比与进度条元素**（仅骨架+计时器；不确定态细条只允许出现在任务中心列表行）。
- **AC-26** Given `error_message="<html><body>502 Bad Gateway</body></html>"` 且 `error_code="UPSTREAM_ERROR"`，Then 页面文本不含 `<`、`502`、`UPSTREAM` 任一子串。
- **AC-27** Given 在进行中面板对已结束任务点暂停，Then toast 同样通过 AC-05 全部三条。
- **AC-28** Given 渲染期异常，Then 只显示固定文案，不含 `error.message`。
- **AC-29** Given 主流程抓包，Then 图片 URL 不含 `user_id` 目录或可枚举 UUID；`/api/generate/tasks` 不含 `upstream_task_id`/`idempotency_key`/`params`。
- **AC-30**（部署门禁）`:8000/docs`、`:8100/docs` 均返回 404。
- **AC-31** Given 任务 cancelled，Then 文案为固定映射（如「已停止 · 额度已退回」），不渲染 `error_message` 原文。
- **AC-32** Given 结果到达且 dock 处于折叠态，Then 出现一次 toast 提示 + 折叠态角标（数字=未查看结果数），角标在打开 dock 后清零。
- **AC-33** Given 存量 paused 任务，Then 渲染「已停止 · 额度退回中」+「重新生成」，无「继续」，不得出现无按钮死卡。
- **AC-34** Given 任务 running，Then 文案分级：<90s「通常 30–90 秒」；>90s 追加「还在画，可以先去别处看看」；>180s 追加「比平时久，可以继续等或停止生成」；禁止百分比与「马上就好」类措辞。

## D. 回归清单

1. 对话流式增量渲染与 `onDone` 清流（use-chat-stream.ts:28-53）。
2. 画布双击进入编辑层（ImageEditLayer 入口）。
3. 安全区投放与多图批量加入（ChatPanel.tsx:185-191）。
4. **自动投放删除的连带清理**：`WorkspaceView.tsx:559-612` 的 effect/8s 轮询/`autoPlaceLockRef` 一并移除；`isTaskPlaced/markTaskPlaced` 若不删须改 url 粒度，否则 #33/#34 会以另一形态复现；同时必须补 AC-32 的通知，否则"图好了但没人知道"。
5. 额度预扣→确认/退回三态（quota_service.py:49-122）。
6. **幂等键生命周期重构**（task_service.py:88-96 + task-persistence.ts:45-72）：改一次性键后 `client.ts:99-108` in-flight 去重成为唯一防手抖手段，须同验：连点只 1 个、网络重试复用同键、跨动作必换键、墓碑分支不再触发。
7. 刷新续接：activeTasks/未读（use-active-tasks.ts）。
8. 并发槽口径：删除 paused 后复核 `count_active`（task_service.py:32/57-65）。

## E. P0 门禁（必修，按严重度）

1. **一会话 5 分钟只能生成一张图**：ChatPanel.tsx:126 + task_service.py:88-93（#32）
2. **结果重复落画布**：WorkspaceView.tsx:536-554 vs 580（#33；自动投放砍掉后收敛为手动入口幂等）
3. **慢任务误杀**：task_timeout_seconds=180 与读超时 300 倒挂 + generate_service.py:203 + task_service.py:276-277/318-337（#23/#24）
4. **停止生成后迟到结果成孤儿**：generate_service.py:235-246 在 succeed 前落库（#28）
5. **对话断线额度黑洞**：chat_service.py:166-219（#12）
6. **【P0 根因】友好文案层从未生效**：`defaultNS:'common'` vs `errors.*` 键（i18n/index.ts:68、errors.ts:5-37）→ 50+ 处回落 error.message；叠加 #4 拼接 error_code、#36 脏数据直渲染、#37 未传 `t`、#40 cancelled 终态原文。四条一起过才算闭环。
7. **无请求超时**：client.ts:67（#3）
8. **图片无失败占位**：全前端 0 处 img onError（#10）
9. **连点/回车/输入法误发**：ChatPanel.tsx:113-139、ChatTextarea.tsx:44-49（#15/#16/#17）
10. **损坏图当成功**：generate_service.py:178-180（#8）

**批次 1 但不卡门禁**：进度条去百分比与 running 文案分级（#25 / AC-25 / AC-34，是 P0-1 的触发因，成本近零）。
**CI 卡口**：黑名单正则（`http|Error|Traceback|5\d\d|upstream|UPSTREAM|code|html`）扫 `frontend/src/i18n/locales/{zh-CN,en}/` 与 `backend/app/utils/errors.py` 的 `ERROR_MESSAGES`；局限：扫不到运行时拼接，那部分靠 AC-06 运行时断言。
**可灰度**：429 重试、并发槽前置提示、多图粒度、两入口一致、queued 收敛、切会话竞态、空回车换行、存量 paused 映射、根错误边界、接口字段收敛。
