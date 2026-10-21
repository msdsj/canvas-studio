# canvas-studio 项目长期记忆

## 项目性质与服务
AI 生图 + 画布协作平台。`frontend`（React 19 + Vite 6 + Tailwind 4 + Zustand + TanStack + Excalidraw 0.18）、
`backend`（FastAPI + SQLAlchemy 2.0 async + SQLite + APScheduler + Pillow）、`gateway`（FastAPI + httpx，上游转发与 Demo 降级）。
前端 `:27180` · 后端 `:27181` · 网关 `:27182` · 上游 chatgpt2api `:3000`；超管 `admin@canvas.studio` / `Admin@12345`；
一键启动 `deploy/scripts/start-local.sh`。

## 核心架构约定
- 统一响应包裹 `{code,data,message}`；错误码集中在 `backend/app/utils/errors.py`。
- 额度唯一真源 = `quota_service`（条件 UPDATE 原子预扣 + `(ref_id,type)` 幂等回滚）。
- 配置真源 `system_configs` > env；改完 `POST /gw/config` 推网关内存，后端 60s 同步兜底。
- 前端只调 `/api/*`（vite/nginx 反代），无直连 gateway；`/static/*` 一律同源相对路径。
- 提示词模板 `backend/app/prompts/*.md`，占位符 `{{name}}`（刻意避开 JSON 花括号），`PROMPT_<NAME>` 可覆盖。

## 生图主链路（唯一入口）
- 无「对话/生图」双模式。有画布选区 → `POST /api/chat/analyze`（按区域拆指令）；其余 → `POST /api/chat/compose`
  （`compose_service.STEPS`：analyze → ambiguity → [clarify] → reason → prompt → dispatch）。
- **建任务必须用模型产出的 `final_prompt`**；模型没给出可用提示词（<10 字）时如实失败、不建任务、不扣额度。
- **歧义必须停**：`status=clarify` → `POST /api/chat/runs/{id}/confirm`；新提交把旧 clarify 置 `voided`。
- 幂等键 = `sha1(session|content|refs)[:16] + 60s 时间桶`，**不能含 run.id**。
- SSE `AbortError` 必须也回调 `onClose`，否则 `composing` 永真、发送键永久禁用。

## 用户级 AI 中转站
- 表 `ai_providers`；解析顺序：用户激活 provider → 全局 `TEXT_*`（仅 `AI_RELAY_ALLOW_GLOBAL=true`）→ 未配置。
- `relay_service` 双协议：Claude 原生（`/v1/messages` + `x-api-key`）与 OpenAI 兼容（`/chat/completions`）；
  裸域名自动补 `/v1/chat/completions`。
- `guard_url()` SSRF 守卫：仅 http(s)、禁账号密码、封云元数据与平台自身端口（27180-27182），**放行回环/内网**。
- `extra` 只放行白名单键；响应体 2MB 上限；不跟随重定向；测试接口 10 次/分钟。
- `api_key` 明文存 SQLite，接口只回 `key_hint`；PATCH 含 `*` 视为不改，清空用 `clear_api_key=true`。
- `TEXT_API_BASE_URL` 必须带 `/v1`；模型名要匹配中转站支持列表（`fast.msdsj.site` 支持 gpt-5.x/6.x、gpt-image-1/2/2.5）。
- **后端改代码必须重启**（uvicorn 无 `--reload`）；本机无法长期保活后台进程，排查「改了不生效」先查
  `openapi.json` 新路由 + `lsof` 实际 PID。

## 设计技能库 + 润色
- `services/design_skills.py`：16 类 78 条；字段 prompt_scaffold / negative / aspect / style_tags / `slots` / `pitfalls`。
- 注入 `shortlist_skills()`：关键词 + 用途词 + 中文二元组初筛，同分类最多 2 条、上限 5 条；模型返回的 `skill_id`
  必须真实存在，否则丢弃。
- `render_detail()` 先输出结构化参数再拼负面词；`negative` 折进提示词尾部（上游无独立负向参数）。
- 润色 `POST /api/ai/polish`：6 模式（auto/specific/professional/concise/english/fix）× 1–3 变体 + notes；
  有中转站走模型，无则分模式本地兜底 `engine=local`。
- 前端唯一入口 `PolishPopover`：位于输入框内部右上角（`ChatTextarea.topRightSlot`），点开即出结果、切模式重跑、
  选版本、替换、撤销；区域气泡用 icon 形态。**不要**放面板顶部或底部工具栏。
- 信息密度铁律：同一件事只留一处说明；快捷键、扣费规则、调试信息不进界面正文。

## 图片编辑（能力注册表驱动）- `edit_handlers.py` 声明能力（id/label/engine/output/per_region/billable/executor/prompt_prefix），
  内置 restyle/cutout/transparent/remove/enhance；**扩展新能力 = 配 `EDIT_HANDLERS` 加一条声明，执行代码零改动**。
- `plan_service.py` 从注册表生成能力清单喂 LLM → Intent DSL；容错：JSON 围栏抽取、解析失败兜底、臆造区域编号丢弃。
- **所有图片操作一律走上游 gpt-image-2 并按编辑单价扣费**；禁止本地像素处理冒充结果。
  `cutout` 已改 `engine=upstream / billable=True / per_region=False`；`CUTOUT_LOCAL_FALLBACK` 仅补 alpha 丢失场景。
- 计费 `cost = edit 单价 × 上游区域数`；`create_edit_task` 只要有 ops 就按 `QUOTA_PRICE_EDIT`（当前 8）计。
- **选区保真三层防护**：① 标准 inpainting 掩码（透明=要改、不透明=保留，传不透明红框图是「框选不精确」根因）；
  ② 单区域引导图（只标本次这一个框）；③ `_paste_region` 合成还原，区域外逐像素保留。
- **每区域并发单独调用上游**（`asyncio.Semaphore`，`EDIT_CONCURRENCY` 默认 3，夹 1~6），不合并成一条指令。
- **编辑草稿按图隔离**（`edit-draft.ts`）：键 = `元素 id + 图片指纹`，存选区/每区提示词/标注，FIFO 12 张、只存内存。
  退出编辑或切图后再进来按它恢复；提交成功与删图必须清（否则「已提交的选区回魂」）。
  写回要守卫 `regionsRef.current !== regions`，否则切图那一帧会把 A 的选区灌进 B 的草稿。
- **拖拽期隐藏气泡必须 `transition-none`**：base 层给 button 加了 opacity 过渡，不关掉会淡出 160ms，
  那 160ms 正好盖住正在画的框。保留 DOM 不卸载，是为了不丢光标与输入法组词。
- **`pointercancel` 四工具统一走 `abortDrafting()`**（只撤销当前这一笔，不落库不污染撤销栈）；
  Esc 中止与 cancel 必须同一实现。改这类规则先数入口再逐个看接线，别让四个 handler 各写一套。
- **点图收气泡的容差**用 `e.pointerType === 'touch' ? 12 : 6`，不要用 `pointer: coarse` 媒体查询
  （触屏笔记本上它返回 fine，手指反而按 6px 判，反向失效）。
- 产出规则：整图类合并 1 张；素材类每区域 1 张；混合 = 1 整图 + N 素材（先整图后素材）。
- **素材类必须先把底图裁到该区域再送上游**（`_crop_region_input`，外扩 6%、长边 ≤1024），
  且**不传 mask、不传引导图**（`_call_region_cutout`）。整图 + 全图引导图送上去时，
  上游把红框当"参考位置"自己挑主体重画 → 框哪两处都返回同一个居中主体，两张素材一模一样。
  这是输入侧的语义问题，后处理修不了。
- 素材后处理 `_sprite_from_provider` 三级降级：真有 alpha → alpha bbox 裁；
  上游把透明**画成棋盘格像素**（实测 mode=RGB）→ 本机 `chroma` 抠图；再不行原样返回 + warning。
- **上游不稳定行为备忘**：edits 可能重画居中单主体并换尺寸（1536×1024 → 1254×1254）；
  也可能返回 RGB 且棋盘格是画死的像素。任何"按原坐标对齐 alpha"的假设都会崩。
- `_compose_prompt(sprite=True)` 不能要求"与原图同尺寸同坐标"（输入已是裁块），
  必须显式禁止"用棋盘格表示透明"。
- `run_task` 公共落库段期望 `{images:[bytes], demo}`，所有分支入口必须转换到该契约。
- 接口：`POST /api/generate/plan`、`GET /api/generate/capabilities`、`POST /api/generate/edit`（`ops` 表单字段，兼容旧 `region`）。
- 并发：上游单账号 `image_account_concurrency` 默认 3，平台 `EDIT_CONCURRENCY` 默认 3 夹 1~6，**实测可并发**。
  看着像串行多半是上游内部任务队列的 10s 首轮询等待，不是平台串行。
  ⚠️ 网关 `/gw/pool/capacity` 的 `total` 只数网关本地 `data/pool.json`，账号实际在上游时会显示 0，别被它误导。

## Excalidraw 集成（易踩坑）
1. **禁止在 `onChange` 里无条件 setState**（新数组引用 → `Maximum update depth exceeded`）：
   必须用内容签名 `id:version:opacity:locked` 比较后落 state。
2. 程序化 `updateScene({appState:{selectedElementIds}})` **不触发 onChange**，需平台侧同步维护选中态。
3. 改元素属性必须 bump `version`/`versionNonce`/`updated`，否则被判定未变化而丢弃。
4. 持久化元素必须经 `restoreElements()` 规范化，缺 `index`/`fractionalIndex` 会被整体丢弃（刷新后空白）。
5. 原生「双击裁剪」提示与自定义编辑入口冲突：`onDoubleClickCapture` 拦截 + 隐藏 `.HintViewer`。
6. 画布底色：`viewBackgroundColor` 为出厂白时置 `transparent`，由 `.cs-canvas-shell` 的 `--color-canvas` 透出。

## 视觉语言（warm paper + ink + lime，**当前唯一口径**）
- 默认亮色。纸 `--color-bg:#F4F1E9`（卡面纯白）/ 墨 `--color-text:#14130D`（主按钮也是墨黑）/
  青柠 `--color-accent:#CDF564`。已废弃：`#b5502c` / `#f8f5f0` / `#5B5BD6` / `#6d5efc` / 靛紫渐变。
- 青柠是唯一信号色：只用于「AI 动作中 / 当前选中 / 关键强调」，绝不做正文或大面积底色；
  青柠上文字必须 `--color-accent-ink`。主按钮 `.cs-gradient-brand`，AI 动作钮 `.cs-gradient-accent`。
- 暗色是同色板暗房版：品牌色反转奶油白，青柠更亮。默认主题 light（`stores/theme.ts` 兜底 +
  `index.html` 防闪脚本**两处必须同步**）。
- 用背景色分层而非边框线分割；页面根节点必须 `bg-transparent`；分栏缝隙用 `--color-gutter`。
- ⚠️ `truncate` 必须配 `min-w-0 flex-1`；`Badge` 已加 `whitespace-nowrap`。
- 头像调色板 = 墨黑-橄榄六阶（`lib/utils.colorFromString`）。

## 页面结构
- **没有登录页**：`/login` 只是重定向；唯一入口 = 全局 `AuthDialog`（挂 `__root`）。未登录可浏览，提交时才拦（内容暂存后自动续）。
- **首页（唯一初始入口）**：中央大输入框 + 右上角登录；`stores/composer.ts`（内存态）暂存 `{text, files}`，
  `WorkspaceView` 消费后交给 `ChatPanel` 的 `initialPrompt/initialFiles` 自动提交。
- **创作页三栏**：`StudioSidebar`(268) + 画布(flex-1) + `ChatPanel`(400)；工作区内 `TopBar` 返回 null，
  身份区（品牌行 + 消息 + 额度 + 头像/主题）由 `StudioSidebar` / `WorkspaceIdentityBar` 承担。
- `CanvasHeader`：「项目 · 画布」+ 保存态 + 分享（整段对话）+ 导出（仅选中图片时可用）。
- 分享 = 对话只读视图；「继续创作」= `fork` 复制，绝不动原件；关闭分享清空 token。
- 死代码（不要再接）：`MaterialPanel` / `ResultDock` / `WorkspaceLeftbar` / `AppSidebar` / `TopBar`(工作区内)。
- **图片编辑唯一入口 = 单击画布/图层面板里的图片** → 编辑层（编号红框 + 画笔/橡皮 + 提示词）→ 图生图；
  编辑层工具条避开 Excalidraw 原生条，位于 `top-[88px]`。
- 平台所有生成图统一 PNG（`generate_service.to_png()` 落库前归一化）。

## 动效系统
- `gsap@3.15` + `ScrollTrigger/SplitText/Flip/CustomEase`，**只能在 `lib/gsap.ts` 集中注册**。
- 三档节奏 `--motion-fast 160 / base 240 / slow 420`；曲线 `csPaper`/`csSnap`/`csDrop`（`styles/motion.css`）。
- 分工：GSAP 管结构动效，CSS 管微交互；**只动 transform/opacity**。
- 路由转场在 `__root.tsx`（key=pathname）+ `RouteProgress`；Radix 弹层动效统一用 `data-state` 选择器写。
- ⚠️ dialog keyframes **绝不能写 `transform`**（与 Tailwind `translate` 居中叠加会飞出屏幕）。
- ⚠️ `SplitText` 带 `mask` 时动画结束必须 `revert()`。
- 降级链：`prefers-reduced-motion`（`.cs-reduced`）→ 低性能设备（`.cs-lite`，`installMotionProfile()`）。

## Toast / 「已完成」提示（2026-10-18）
- **唯一去重真源 = `cs.notifiedResults`**：`{ 任务id: 已提示过的结果张数 }`，在 `lib/task-persistence.ts`。
  存张数不存布尔（重试后 1→2 张属于真·新结果）。**任何新入口都必须用它，不许再造第二套记录**
  （历史教训：`ResumeGuard` 的 `cs.notifiedTasks` 与 ChatPanel 的 useRef 各弹各的）。
- **去重集合绝不能放 useRef**：切会话/路由进出都会重新挂载，集合清空 → 历史任务被当成"新到达"。
- 「刚跑完」vs「历史结果」用 `watchersRef` 区分：本次停留期间见过 running 的才算刚跑完。
- 视觉在 `styles/toast.css`；⚠️ 必须用 `[data-sonner-toast][data-styled='true']` 前缀 + `!important`，
  否则被 sonner 后加载的内置样式压回去（表现为"改了 CSS 但界面没变"）。
- 宽度走 sonner 的 CSS 变量 `--width`（不用 `width` prop）；hover 不能写 `transform`（sonner 用它做堆叠位移）。

## 其他踩坑
- Pillow 画中文必须显式传 font（`demo_service._load_font`），`load_default()` 只有 ASCII → 全是「▯」；
  换行用 `draw.textlength` 按实际字宽算，别用 `textwrap.wrap`。
- 涂鸦用 perfect-freehand 生成轮廓 → `Path2D` → `ctx.fill()`；统一入口 `canvas-helpers.paintStrokePath()`；
  橡皮 `destination-out` + fill。

## 测试资产
- `e2e/mock_upstream.py`（**故意返回 JPEG**，验证 PNG 归一化）、`e2e/verify_flow.py`（API 全流程，自带清理）、
  `e2e/ui_verify.mjs`（零依赖 CDP：真实鼠标拖拽 + 文件注入 + 下载魔数校验）、`e2e/qa_full_flow_e2e.py`。
- `e2e/canvas_interaction.assert.mjs`：画布交互边界静态断言（源码级，无需起服务）。
  路径按脚本位置推导，**不要再硬编码绝对路径**；断言锁「行为契约」，交互改版时要同步改它。
- 性能探测 `scripts/`：`probe-quiet.mjs`（**结论首选**，零注入）、`probe-interaction.mjs`（连续缩放）、
  `probe-cpu.mjs`（采样热点）、`probe-idle.mjs`（按调用栈归因）。
- 浏览器自动化需 `--no-sandbox`；本机代理需 `NO_PROXY=localhost,127.0.0.1`。

## 性能测量铁律（2026-10-21 血的教训）
- **必须先校验落地 URL**：`admin@canvas.studio` 的 `onboarding_completed_at` 为 null 时，
  访问 `/workspace` 会被重定向到 `/onboarding`，探测脚本若只 sleep 就会把引导页当工作台测。
  先查 `location.href` + 关键 DOM（`.cs-canvas-card`）。
- **探测脚本不要自己注入 rAF 循环**去数帧数：那会让页面永远无法空闲，A/B 差异被固定负载淹掉。
  只读 CDP `Performance.getMetrics`，并等「连续 3 个 1s 窗口 TaskDuration < 60ms」再采。
- **`git stash` 做 A/B 会触发 Vite HMR 重编译**，测量窗口里混入编译尾巴；
  `stash pop` 若被信号打断，改动会留在 stash 里（先 `git stash list` 抢救）。
- 已知常驻但合理的开销：GSAP ticker、ScrollTrigger `_rafBugFix`（Firefox 重绘补丁）、
  Excalidraw `AnimationFrameHandler`。画布组件的 rAF **静止时因签名未变会直接 return**，
  优化它们对空闲 CPU 几乎没有影响——别在这上面找收益。
- **数据安全铁律**：探针里调 `api.updateScene({ elements })` / `addFiles` 会触发画布自动保存，
  **直接覆盖真实内容且不可恢复**（`backend/data/` 未入库、默认无 WAL）。
  一律新建临时画布再播种：`POST /api/projects/{project_id}/canvases`（**没有** `/api/canvases`），
  用完 `DELETE`。曾经这样毁掉 `cb00feb9` 的 29221 字节真实布局。
- 归因纪律：改代码前先把「现象」和「因果」分开写。本轮两次把「选中图片 CPU 高」误归因到自家的
  `viewTick` / `selectedImageInfo` effect，实际关掉它们只降 2 个百分点，真凶在上游库内部
  （Excalidraw 对选中 image 的每帧整树重渲染，纯 HEAD 也有 82.2%）。**先做归零实验再下结论**。


## 后端并发（2026-10-21 实测口径）
- **单进程 asyncio，任何阻塞 CPU/文件操作都会停掉所有请求**：Pillow 后处理（裁块/抠图/合成/转 PNG）
  一律走 `app/utils/offload.py` 的 `run_sync()`，**不要在协程里直接调图片同步函数**。
  实测 16 并发下未 offload 会让事件循环卡 **8.59s**；offload 后延迟 1.1ms、总耗时快 5.2 倍。
- **连接池要小不要大**：`db_pool_size=4 / max_overflow=2`。aiosqlite 每条连接独占一个 worker 线程，
  连接数≈并发数时全在等线程调度。`pool=2` 在 32 并发是 `pool=20` 的 **3.7 倍快**。
  要真上量加 `uvicorn --workers`，**不要加连接**。
- **高频读路径必须走复合索引**：`generation_tasks` 用 `(user_id, created_at)` 与
  `(user_id, status, created_at)`。缺了就会 `USE TEMP B-TREE FOR ORDER BY`，
  且 `status` 单列索引会让 `list_unread` 扫全库所有用户。加索引后 32 并发 p95 -64%。
- 分页/列表查询**只取需要的列**返回 `dict`，不要实体化：16 并发下 1774/s vs 471/s。
  ⚠️ 维护 `_LIST_COLUMNS` 时必须覆盖 `GenerationTaskOut` 全部必填字段，
  漏一列（如 `idempotency_key`）会让整个接口 500 —— 已用 `test_task_list_contract.py` 锁死。
- SSE 轮询不要每秒全行 SELECT：只取需要的 5 列 + 0.5/1.5/3.0s 退避。
- httpx 客户端要复用（`gateway_client._shared_client`），且 `_client()` 是
  `@asynccontextmanager` 只借不关——**退出时关闭会掐掉其它并发请求的连接**。
- 当前容量参考（单进程，32 并发）：`/api/tasks/active` 670/s、`/api/tasks/unread` 720/s、
  `/api/generate/tasks?size=20` 666/s。业务层已接近单事件循环上限，剩余差距在 ASGI 序列化。
- 跑测试用 `backend/.venv/bin/python -m pytest`（直接调 `.venv/bin/pytest` 会因 shebang 指向旧路径
  `canvas-studio` 报 `bad interpreter`）。整套会 OOM（exit 137），必须分组跑。
