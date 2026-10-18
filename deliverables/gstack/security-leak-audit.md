# 用户可见信息泄露审计 · canvas-studio

审计范围：frontend 全部可见面 + backend/gateway 错误透传链 + 部署暴露面。未改任何代码。

## A. 泄露点清单

| # | 等级 | 位置 | 泄露内容 | 用户触发路径 | 修法 |
|---|---|---|---|---|---|
| 1 | P0 | `backend/app/services/gateway_client.py:128` | 上游原始响应体（HTML 错误页 / JSON / 堆栈）整段作为 message | 对话流失败 → `generate_service.py:213` 写入 `task.error_message` → `task_service.py:301` 落库 → `GenerationResultCard.tsx:80` 直接渲染 | 只记 `ErrorCode`，raw body 仅写 logger；对外固定枚举码 |
| 2 | P0 | `backend/app/services/generate_service.py:217` | `str(exc)`——任意 Python 异常串，含 httpx 内网 URL/端口、上游 body | 任意未捕获异常 → 同一渲染链 | 改 `fail_and_refund(..., ErrorCode.INTERNAL_ERROR.value, "")`，详情只进 `logger.exception` |
| 3 | P0 | `gateway/app/services/error_mapper.py:36-42` | "上游鉴权失败，请检查 Key 配置"、"上游返回 500" | gateway 非 2xx → `gateway_client.py:60` 透传 `body.message` → `main.py:84` envelope → `client.ts:90` → toast | gateway 对外只回枚举码，message 置空 |
| 4 | P1 | `frontend/src/components/chat/GenerationResultCard.tsx:81` | 内部错误码：`UPSTREAM_ERROR`、`TASK_TIMEOUT`（`task_service.py:331`，甚至不在枚举内） | 任务失败卡片显示 `生成失败 · UPSTREAM_ERROR` | 删除该渲染，码只用于查文案映射 |
| 5 | **P0**（原判 P1，已上调） | `frontend/src/lib/errors.ts:32,36` + `i18n/index.ts:68` | **`errors.json` 的 14 条文案从未生效过**：`defaultNS: 'common'`，而 `ERROR_I18N_KEY` 的值是 `'errors.xxx'`，`nsSeparator` 默认 `':'` 不触发，于是被当成 **common 下的嵌套路径** → 必然 miss → 每次回落 `defaultValue` = 后端 `envelope.message`。全站 50+ 处错误提示 100% 是后端原文 | 任意一次接口报错 toast | 见下方 F 段修正后的三步修法 |
| 5b | P1 | `frontend/src/components/chat/ActiveTasksPanel.tsx:26` | `toast.fromError(error)` 未传 `t`，即便 ns 修好仍会漏 | 任务中心点暂停/继续/放弃失败 | 补 `t`，或按 F 段改全局实例兜底 |
| 6 | P1 | `frontend/src/i18n/locales/zh-CN/errors.json:6,8,15` | "上游服务繁忙"、"网络代理不可达，请检查服务器 VPN"、"服务器内部错误" | 任一 API 报错 toast | 文案去技术化（见 B 表） |
| 7 | P1 | `frontend/src/i18n/locales/zh-CN/chat.json:119` | "演示模式：上游不可达，已生成占位结果。" | `GenerationResultCard.tsx:105` 渲染 | 改"示例图（试运行）" |
| 8 | P1 | `frontend/src/routes/__root.tsx:10` | `description={error.message}` 整页渲染任意异常串 | 任意渲染期抛错 / ApiError 冒泡到根 | 固定文案 + 错误 ID |
| 9 | P1 | `frontend/src/lib/api/client.ts:86,130` | `请求失败（HTTP 500）`、`下载失败（HTTP 502）` | 后端返回非 envelope 的 5xx | 去掉状态码 |
| 10 | P2 | `backend/app/services/storage_service.py:29-31,34-37` + `.env:8` | 图片 URL = `http://localhost:27181/static/{user_id}/{YYYY}/{MM}/{uuid}.png`——暴露内网端口 + 用户 UUID | 右键复制图片地址 / Network 面板 | `STORAGE_PUBLIC_BASE` 改同域相对路径；目录改哈希桶 |
| 11 | P2 | `backend/app/schemas/task.py:16,21,26,28,33,34` | 响应体下发 `user_id / params / upstream_task_id / idempotency_key / error_code / error_message` | 打开 Network 看 `/api/generate/tasks` | 拆 `GenerationTaskPublicOut` 白名单 |
| 12 | P0 | `backend/app/main.py:68` + `deploy/docker-compose.yml:41` | `/docs`、`/redoc`、`/openapi.json` 全量接口与 schema 线上可达 | 直接访问 `host:8000/docs` | `FastAPI(docs_url=None, redoc_url=None, openapi_url=None)`；compose 去掉 `"8000:8000"` |
| 13 | P0 | `gateway/app/main.py:19` + `deploy/docker-compose.yml:65` | 网关 `/docs` `/openapi.json` 暴露全部 `/gw/*` 契约；若 `CS_GATEWAY_INTERNAL_TOKEN` 未覆盖（compose 默认 `dev-internal-token`，`:50`），可直接调网关绕过 backend 鉴权、触达持密钥的上游通道 | 访问 `host:8100/docs` | 同上；compose 去掉 `"8100:8100"`，token 无默认值 |
| 14 | P3 | `backend/app/services/chat_service.py:198` → `chat.ts:81` | SSE 下发 `error_code`（如 `UPSTREAM_ERROR`） | Network → EventStream | SSE 只回 `{done:true}`，码留服务端 |
| 15 | P3 | `frontend/src/components/canvas/ImageEditLayer.tsx:884` | 原样渲染 LLM `plan.thinking`，内容不可控 | 编辑层"正在分析"步骤 | 白名单固定步骤文案 |
| 16 | P3 | `deploy/docker-compose.yml:22,24` | 默认 `CS_SECRET_KEY=dev-change-me`、`CS_DEFAULT_ADMIN_PASSWORD=Admin@12345` | 未覆盖环境变量即生效 | 无默认值，缺失即启动失败 |
| 17 | P1 | `backend/app/services/task_service.py:43` | `f"任务当前状态为 {current}，不允许变更为 {target}"` —— 内部状态机标识（`paused`/`running`）直接进 message | 对已结束任务点暂停/继续 → `TASK_STATE_CONFLICT` → `ActiveTasksPanel.tsx:26` 未传 `t` → 用户看到「任务当前状态为 paused，不允许变更为 running」 | 改「这一步已经做过了，不用重复点」，状态名只进 logger |

**补充**：全项目 `console.*` 零命中、`vite.config.ts:34` `sourcemap: false`、`dist` 无 `.map`、`VITE_API_BASE_URL=/api` 为相对路径——这几项是干净的，不用改。

## B. 错误文案映射表

| 内部码 | 用户可见文案 | 可操作建议 |
|---|---|---|
| OK | 完成 | — |
| QUOTA_INSUFFICIENT | 这次需要的额度不够了 | 去「用量」页看看明细，或找管理员加额度 |
| UNAUTHORIZED | 登录状态过期了 | 重新登录就能继续 |
| FORBIDDEN | 这部分内容你没有权限 | 需要开通请找管理员 |
| UPSTREAM_ERROR | 图片没生成出来，额度已经退回给你 | 换个说法再试一次；连着失败就找客服 |
| POOL_UNAVAILABLE | 现在有点忙，暂时排不上 | 等一分钟再试 |
| PROXY_UNREACHABLE | 网络不太稳定 | 检查一下网络，然后重试 |
| TASK_NOT_FOUND | 这条记录已经过期清掉了 | 重新发起一次生成 |
| TASK_STATE_CONFLICT | 这一步已经做过了，不用重复点 | 刷新页面看最新进度 |
| TASK_LIMIT_EXCEEDED | 同时生成的数量有点多 | 等当前几张完成，或先放弃一张 |
| RATE_LIMITED / 429 | 操作有点快，缓一下 | 几秒后再试 |
| VALIDATION_ERROR | 填写的内容需要调整一下 | 按提示检查必填项 |
| NOT_FOUND | 没找到你要的内容 | 返回上一页重新选 |
| INTERNAL_ERROR / 5xx | 服务开了个小差 | 稍等片刻再试，额度会保留 |
| 网络层（fetch 失败） | 网络好像断了 | 确认联网后重试 |
| 超时 / TASK_TIMEOUT | 这次等得有点久，已经帮你停下了 | 重试一次，或把描述写短一点 |
| 未映射兜底 | 出了点小状况 | 重试一次；还不行请联系客服 |

文案约束：不出现「上游 / 中转 / 网关 / 号池 / 接口 / 状态码 / 超时 / 服务器 / 代理」。

## C. 禁止展示清单 + CI 检测规则

| 类别 | 禁止出现 | 检测正则 |
|---|---|---|
| 架构词 | 上游/中转/网关/号池/VPN/代理/密钥 | `上游\|中转\|网关\|号池\|VPN\|代理服务器\|密钥\|api[_-]?key\|access_token` |
| 错误码枚举 | `UPSTREAM_ERROR` 等 | `\b(UPSTREAM_ERROR\|POOL_UNAVAILABLE\|PROXY_UNREACHABLE\|TASK_STATE_CONFLICT\|TASK_LIMIT_EXCEEDED\|RATE_LIMITED\|VALIDATION_ERROR\|INTERNAL_ERROR\|TASK_TIMEOUT)\b` |
| HTTP/技术词 | 状态码、JSON、堆栈、超时 | `HTTP\s*\d{3}\|状态码\|status code\|\b[45]\d{2}\b\|JSON\|traceback\|Exception\|Timeout\|null\|undefined` |
| 主机端口 | localhost、内网 IP、裸端口 | `localhost\|127\.0\.0\.1\|0\.0\.0\.0\|:\d{4,5}\b` |
| 密钥形态 | OpenAI 风格 key、Bearer | `sk-[A-Za-z0-9]{16,}\|Bearer\s+[A-Za-z0-9._-]{20,}` |
| 内部 ID | UUID / task_ 前缀 | `[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|task_[A-Za-z0-9]{10,}` |
| 文件路径 | 服务端路径 | `/(app\|data\|storage\|home)/` |
| 模型名 | 上游模型标识 | `gpt-image\|gpt-4o\|dall-e\|sora\|flux\|stable-diffusion` |
| 控制台残留 | console.* | `console\.(log\|debug\|info\|warn\|error)` |

CI 卡口扫描范围（仅用户可见文件）：`frontend/src/i18n/locales/zh-CN/`、`frontend/src/i18n/locales/en/`、`backend/app/utils/errors.py` 的 `ERROR_MESSAGES` 表。建议同时加一条运行期快照测试：mock 后端返回 `{"code":"UPSTREAM_ERROR","message":"<html>502 Bad Gateway</html>"}`，断言 toast 与任务卡文本不含任何黑名单词。

**扫描必须只扫 JSON 的 value，不扫 key。** 实测会撞的合法 key：
`zh-CN/chat.json:91` 与 `en/chat.json:91` 的 `"timeout"` key、`errors.json:6` 的 `"upstream_error"` key、`errors.json:8` 的 `"proxy_unreachable"` key。

这些 key 是 `errors.ts:5-20` `ERROR_I18N_KEY` 映射的目标，**不能改名**（改了映射就断），且永远不上屏。所以 CI 实现要先用 `jq -r '.. | strings'` 或等价的 value 抽取再跑正则，直接 `grep -ri timeout locales/` 会误报。tsx 里的 `task.timeout` 这类 key 同理，不在扫描范围。


## D. 生产环境可见性收敛

| 入口 | 判定条件 | 收敛动作 | 验证 |
|---|---|---|---|
| `/docs` `/redoc` `/openapi.json` | `settings.app_env != "dev"` | FastAPI 三参数置 None | `curl -o /dev/null -w "%{http_code}" host/docs` 应 404 |
| backend :8000 / gateway :8100 | compose 网络 | 删 `ports`，仅留 `expose` | 外网 `nc -z host 8000` 应失败 |
| 任务卡错误详情 | `import.meta.env.PROD` | 生产只显示映射文案；开发可显示 `error.message` | 生产构建后手工复现一次失败任务 |
| 管理后台 | `AdminRoute.tsx:18` 已有角色守卫 | 保持；后端必须二次鉴权 | 普通用户 token 直打 `/api/admin/*` 应 403 |
| 调试信息 | 全局 | 当前**无任何** `import.meta.env.DEV/PROD` 分支（全项目零命中），需先补这套开关 | grep 构建产物 |

后端同样需要一个 `app_env` 开关：prod 下 `error_message` 一律置空，仅保留 `error_code` 供前端映射。

## E. 三条最紧急修复

1. **`frontend/src/components/chat/GenerationResultCard.tsx:78-83`** —— 删掉 `· ${task.error_code}`；`error_message` 不再直出，改为 `errorMessage({ code: task.error_code }, te)`，未命中走兜底"出了点小状况"。这一处是用户唯一能稳定看到上游原文的常驻位置。
2. **`backend/app/services/gateway_client.py:128` 与 `generate_service.py:213,217`** —— 三处都不得把 raw body / `str(exc)` 传给 `fail_and_refund`，改传固定枚举码 + 空 message；详情全部走 `logger`。这是 P0 的根因，堵住后 #1 的输入自然干净。
3. **`backend/app/main.py:68` 与 `deploy/docker-compose.yml:41,65`** —— 关闭 docs/openapi，取消 8000/8100 对外发布。当前任何人扫到端口就能拿到完整接口清单和网关直连通道，是攻击面而非仅是"信息展示"问题。

## F. 复核结论（回应 designer 的三个冲突点）

1. **「超时」撞黑名单 → 扫描只扫 value，不扫 key**（已写入 C 段）。`chat.json:91` 的 `"timeout"` key 与 `errors.json` 的 `"upstream_error"` / `"proxy_unreachable"` key 全部豁免——它们是 `errors.ts:5-20` 的映射目标，改名即断。UI 上不出现「超时」二字，结论一致。

2. **`paused` 态：可以保留「已暂停」，但不是因为"不可达"，而是后端仍合法。** `task_service.py:24` `_TRANSITIONS["paused"] = {"running", "cancelled", "timeout"}`，resume 是通的，不会 409。**但发现一个真问题**：`reclaim_orphans`（`task_service.py:322`）只回收 `CONCURRENCY_STATUSES`（queued/running），`paused` 被排除，而 `paused` 又在 `ACTIVE_STATUSES`（`:31`）里。结论：历史 paused 任务永不超时、永不被清理、永远出现在「进行中任务」轮询里。建议要么把 paused 纳入回收，要么前端按 `paused_at` 超 N 天归入 cancelled 展示。请产品侧裁定。

3. **错误 ID 建议这版直接不做。** 前端生成的 `E-7F3A2C` 客服拿不到、后端日志里没有，用户报出来查不到任何东西——是假承诺，反而浪费支持时间。要么后端在异常处理器里生成并落 logger 的真实 correlation id（`main.py:79-85` 是唯一出口，改一处即可），要么就不显示 ID、只留固定文案。**不要**用 `task_id`/`user_id` 片段派生，那是拿内部 ID 做截断，仍属内部标识外泄。

**关于 `ActiveTasksPanel.tsx:26` 未传 `t`**：根因不该靠每个调用点记得传参解决。建议在 `errors.ts` 里直接 import 全局 i18n 实例（`i18n/index.ts:90` 已有 default export，无循环依赖），`t` 降级为可选覆盖。该类 bug 一次性消灭，调用点不用改。

**新增发现 #17**：`task_service.py:43` `_check_transition` 把内部状态名写进 message —— `f"任务当前状态为 {current}，不允许变更为 {target}"`，用户会看到「任务当前状态为 paused，不允许变更为 running」。这条正好落在 #5 那条无 `t` 的路径上，是"后端把内部标识当文案"的实证。

## G. 重大修正（qa-lead 复核，经代码确认，A 表 #5 上调为 P0）

**我原先的判断"errors.json 的 key 存在所以翻译文案会赢"是错的。** 实际是全部 miss：

- `i18n/index.ts:68` `defaultNS: 'common'`
- `errors.ts:5-20` `ERROR_I18N_KEY` 的值是 `'errors.upstream_error'` 这种带命名空间前缀的形式
- i18next `nsSeparator` 默认是 `':'`，**不是 `.`**，所以不会把 `errors` 识别为命名空间
- 结果：`t('errors.upstream_error')` 被解析成 **common 命名空间下的嵌套 key** `errors → upstream_error`
- 实测 `common.json`（中英两版）顶层只有 `app_name/tagline/action/status/pagination/nav/unit/logout/theme/language/error_boundary`，**没有 `errors` 节点** → 必然 miss → 回落 `defaultValue: error.message`

**结论：`errors.json` 那 14 条中文文案从来没被显示过一次。全站错误提示一直是后端 `envelope.message` 原文。** 这直接解释了为什么 A 表 #1/#2/#3 的脏数据能一路到用户眼前——最后一道翻译闸门是空的。

### 修法必须两步，只做第一步仍然 miss

1. `ERROR_I18N_KEY` 的值去掉 `errors.` 前缀，改成裸 key（`'upstream_error'`）
2. 调用处显式带命名空间：`t(key, { ns: 'errors', defaultValue: FALLBACK })`

**注意**：仅把调用点改成 `useTranslation('errors')` 是不够的——此时 `t('errors.upstream_error')` 依然会在 `errors` 命名空间里找 `errors → upstream_error` 嵌套路径，照样 miss。前缀必须去掉。

3. 再单独修 `ActiveTasksPanel.tsx:26` 的 `t`（独立缺陷，不随 1、2 自动好）

### 对 CI 卡口的连带影响

C 段的静态扫描扫不到这个问题（正则只能查文案字面量，查不到"文案根本没被取到"）。必须补一条运行期断言：mock 一次 `UPSTREAM_ERROR`，断言 toast 文本 **等于** `errors.json` 里的 `upstream_error` 值。这条不做，修完也没人知道好没好。


