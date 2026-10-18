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
- `run_task` 公共落库段期望 `{images:[bytes], demo}`，所有分支入口必须转换到该契约。
- 接口：`POST /api/generate/plan`、`GET /api/generate/capabilities`、`POST /api/generate/edit`（`ops` 表单字段，兼容旧 `region`）。

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
- 浏览器自动化需 `--no-sandbox`；本机代理需 `NO_PROXY=localhost,127.0.0.1`。
