# canvas-studio 项目长期笔记

## 服务结构与端口
| 组件 | 目录 | 端口 | 说明 |
|---|---|---|---|
| 前端 | `frontend/` | 27180 | Vite + React 19 + Excalidraw，`/api` `/static` 代理到 27181 |
| 后端 | `backend/` | 27181 | FastAPI，业务主服务 |
| 网关 | `gateway/` | 27182 | 上游代理，回环调用不挂 VPN 代理 |

- 健康检查：后端 `GET /api/health`，网关 `GET /gw/health`（需 `X-Internal-Token: dev-internal-token`）
- 管理��：`admin@canvas.studio` / `Admin@12345`

## 本地启动要点
- 各组件读各自的 `.env`（pydantic-settings，`CS_` 前缀；上游变量无前缀）。
- **首次必须先 `mkdir -p backend/data/storage`**，否则迁移报 `unable to open database file`。
- 初始化：`cd backend && .venv/bin/python -m app.migrations.run`
- 后台启动服务时不要用 `nohup &`（沙箱会回收进程），用受管后台任务方式。

## 环境约定
- 统一使用 managed Python 3.13.12：`/Users/meishiduoshuijiao/.workbuddy/binaries/python/versions/3.13.12/bin/python3`
- Node：系统 nvm 的 v26.10.0（npm 全局安装需避免，项目内 `npm install` 正常）
- 上游 `chatgpt2api`(3000) / `sub2api`(8080) 本地默认不跑，`CS_DEMO_MODE=auto` 时自动回退 DEMO 占位图。

## 品牌与关键新增（2026-10-23）
- 项目对外名称统一为 **MSDSJ AI画布**；LOGO 位图 `frontend/public/brand/msdsj-mark.png`，
  导航统一用 `components/brand/BrandMark.tsx`，favicon 在 `frontend/public/favicon.svg`。
  后端 `settings.app_name` / 邮件标题 / 提示词里的旧名都已替换；默认管理员邮箱保留 `admin@canvas.studio`（历史账号）。
- **配色（2026-10-24 换）**：蓝绿冷调 `#598BFD` / `#9AD4CB` / `#35B3C9`。
  纸面（暖砂）与墨色不变，只换有彩色的部分。关键映射：
  `--color-brand` = `#2452c0`（**不能用 `#598BFD`**：白字只有 3.2:1），
  `--color-accent` = `#35b3c9`（实底压深墨字），新增 `--gradient-diffuse` 弥散渐变。
  改色只动 `tokens.css` 的 token 值 + 少量硬编码处；**别再引入新色**。
- 画幅自适应：`backend/app/services/param_service.py`。**上游只支持 1024²、1536×1024、1024×1536**，
  所以 16:9/9:16/3:4 只作为 `aspect` 意图，`size` 会映射到最近档位；通用兜底 4:3，禁止默认正方形。
- 生图队列：`backend/app/services/queue_service.py`，`CS_IMAGE_CONCURRENCY`（默认 4）+
  `CS_IMAGE_QUEUE_MAX`（默认 200）。**必须在开 DB 会话之前排队**，否则排队任务占满连接池会死锁。
- 协作新增两张表：`canvas_comments`（打点评论/@/已解决）与 `canvas_versions`（最多 30 份快照，
  恢复前自动存档）；路由在 `backend/app/routers/canvas_collab.py`，迁移无需手工（`init_models` 建表）。
- 消息懒加载：`GET /api/chat/sessions/{id}/messages?size=20&latest=true` 首屏最新 20 条，
  `before=<message_id>` 向上翻页，返回体多一个 `has_more`。
- 协作 presence 现在真的会发送（此前 `sendPresence` 从未被调用），payload 带 `viewport` 供「跟随视角」。
- 前端构建注意：沙箱 safe-delete 会拦截 vite 清空 `dist/assets`，验证构建请加
  `--outDir /tmp/xxx-build`，不要直接 `npm run build`。

## 文本 LLM 只有一条规则（重要）
- 统一入口：`backend/app/services/text_llm.py` 的 `complete(db, user_id, messages, ...)`。
  **用户中转站优先 → 网关内置 LLM 兜底**，返回 `content/model/source/demo`。
- 所有需要「读懂用户」的服务都必须走它（plan / edit_prompt / 后续新增）。
  不要再直接调 `gateway_client.llm_completions`——那会绕开用户配置，
  出现「设置里连接正常、功能却报不可用」的经典故障。
- 用户的中转站配置在 `ai_providers`（`scope=personal`，当前管理员已配
  `fast.msdsj.site/v1` + `deepseek-v4.1-flash`）；网关内置 LLM 无需配置也能兜底。

## 出图与号池（两种容量，别混）
- **文本**走个人中转站；**图片**走网关 → 上游 `127.0.0.1:3000`（chatgpt2api，Docker）。
- **上游项目在 `~/Desktop/2API/chatgpt2api-main`**（曾被移动过，容器挂载要跟着改）。
  镜像数据目录是 `/app/data`（**不是** `/app/backend/data`）；compose 里的
  `./backend/data:/app/data`、`./backend/config.json:/app/config.json`。
  挂载写错 → 上游写日志崩 → 对外只有 500，真实错误被吞。
- 号池有两层：网关本地池（`POOL_FILE`，只放 `sk-` Key）与上游号池（`eyJ` ChatGPT 凭据）。
  `/gw/pool/capacity` 现返回 `routing_mode=local|upstream|none` 与 `effective_*`；
  `batch_service.preflight` 按模式判断，**upstream 模式放行多图**（否则「导了号却出不了 2 张」）。
- 单张实测：`/api/generate/image` → 真实 PNG（1254×1254，demo=false）。
- 号池管理页导入的 ChatGPT 凭据不会进本地池，这是设计如此，不是导入失败。
- **账号只存在上游 `accounts.json`**：上游目录移动/重建 → 账号全丢，
  平台「号池正常」只是代理读上游列表。上游报 429 no available image quota = 没账号了，要重新导入。
- 容量口径：`routing_mode=local`（sk- Key，可保证每任务不同账号）/
  `upstream`（ChatGPT 凭据在上游，由它排队）/ `none`（没账号）。
  **upstream 模式必须放行多图**——早期只认 local，导致「导了号却出不了 2 张」。
- 澄清策略：只有**主体级**缺口（主体/主题/对象/用途）才追问；文案、标识、活动信息等
  交给 AI 补齐（`_core_gaps`）。否则用户写清楚了还要回答「标识用什么」。

## 沙箱里怎么起服务
- `deploy/scripts/start-local-daemon.sh` 起的进程**会被沙箱回收**（连 vite 一起）。
- 正确做法：分别用**受管后台任务**（run_in_background）跑
  `backend/.venv/bin/python -m uvicorn app.main:app --port 27181`、
  `gateway/.venv/bin/python -m uvicorn app.main:app --port 27182`、
  `frontend: npm run dev -- --port 27180`。

## 测试与验证纪律（踩过的坑）
- `tests/conftest.py` 会话开始前删旧测试库（含 -wal/-shm）；**跑测试期间不要改源码**，
  非原子写入会让在跑的用例读到半个文件（出现过 NameError/500）。
- **绝不要并发跑两个 pytest**：它们会互相 drop_all 同一个测试库，
  症状是满屏 `StaleDataError: 0 rows matched` + `no such table`，看着像代码炸了，其实只是撞库。
  遇到这种成片报错，先确认没有别的 pytest 在跑，再回退改动复跑一次拿基线。
- 后端 pytest 与生产服务**共用 data/canvas_studio.db**，测试期间不要打真实接口（会锁库）。
- 改完必须走一次**真实请求**冒烟：typecheck/pytest 绿 ≠ 运行时不炸（compose 漏 import 就是这么抓到的）。

## 页面壳只有一套刻度（2026-10-24 v3 收口后）
- 规格全文：`docs/13-design-system-v3.md`；审计：`docs/12-visual-audit-2026-10-23.md`。
- **唯一刻度**：gutter `20/32/48px`（<640/≥640/≥1024）、`max-width 1280px`（默认）/1440/880。
  1440 视口下内容左沿恒为 **128px**。所有页面走 `PageShell`，**不许再自建 header / gutter / max-width**。
- `PageShell` 新增 `tabs` / `sticky` / `bottomPad` 三个插槽；`AdminShell` 内部直接复用它（不再自建壳）。
- 表格必须包在 `TableCard` 里，**分页条是表格卡的兄弟节点**（`sticky bottom-0`）——
  放进卡里会被 `overflow-hidden` 吃掉，长表时用户看不见分页。
- 环境光（`--ambient-1/2`）只在首页（自带 aurora 层）与登录页；**body 上不许挂**。
- 动效四档只有 `--motion-hover 160ms / --motion-enter 420ms / --motion-exit 180ms / --motion-loading 1.5s`；
  只动 `transform/opacity`；错峰第 8 项封顶。
- 图表手写 SVG（`components/ui/chart.tsx`），**不引 recharts/d3**；配色只走 `--chart-*`。

## 视觉回归工具（提交在 scripts/）
- `node scripts/visual-audit.mjs --theme both --mobile --out <dir>`
  → 逐路由截图 + console error + 横向溢出 + 越界元素 + 无限动画清单（`report.json`），有问题则退出码非 0。
- `node scripts/verify-ui.mjs` → **几何断言**（比截图比对可靠）：页面左沿一致 / 页头间距一致 /
  dock 不折行 / 只有一组缩放 / 末行不被裁 / 移动端顶栏不叠字。当前 8/8 通过。
- playwright 不在项目 node_modules 里，用绝对路径 import：
  `/Users/meishiduoshuijiao/.workbuddy/binaries/node/workspace/node_modules/playwright/index.mjs`。