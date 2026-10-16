# canvas-studio 项目长期记忆

## 项目性质
AI 生图 + 画布协作平台。三组件：`frontend`（React 19 + Vite 6 + Tailwind 4 + Zustand + TanStack + Excalidraw 0.18）、
`backend`（FastAPI + SQLAlchemy 2.0 async + SQLite + APScheduler + Pillow）、`gateway`（FastAPI + httpx，负责上游转发与 Demo 降级）。

## 服务端口与账号（本地）
- 前端 `http://localhost:27180` · 后端 `27181` · 网关 `27182` · 上游 chatgpt2api `3000`
- 超管：`admin@canvas.studio` / `Admin@12345`
- 一键启动：`deploy/scripts/start-local.sh`

## 关键架构约定
- 统一响应包裹 `{code,data,message}`；错误码集中映射在 `backend/app/utils/errors.py`
- 额度账本唯一真源 = backend `quota_service`（条件 UPDATE 原子预扣 + `(ref_id,type)` 幂等回滚）
- 配置真源 = `system_configs` 表 > env；变更后 `POST /gw/config` 推送网关内存即时生效（后端 60s 周期同步兜底）
- 前端只调 `/api/*`，由 vite/nginx 反代，无直连 gateway 代码
- 本地资源 URL `/static/*` 一律走同源相对路径，避免跨源 fetch 失败

## Excalidraw 集成要点（重要，易踩坑）
1. **禁止在 `onChange` 里无条件 setState**：Excalidraw 每次 onChange 都返回新数组引用，会造成
   `Maximum update depth exceeded`。必须用内容签名（`id:version:opacity:locked`）比较后再落 state。
2. **程序化 `updateScene({appState:{selectedElementIds}})` 不会触发 `onChange`**：需要平台侧同步维护选中态。
3. **修改元素属性必须 bump `version` / `versionNonce` / `updated`**，否则 Excalidraw 判定元素"未变化"而丢弃更新。
4. 持久化元素必须经官方 `restoreElements()` 规范化，否则缺 `index`/`fractionalIndex` 会被整体丢弃（刷新后空白）。
5. 原生"双击裁剪"提示与自定义图片编辑入口冲突时，用 `onDoubleClickCapture` 拦截 + 隐藏 `.HintViewer`。

## 产品交互约定（本轮确立）
- **图片编辑唯一入口 = 在画布/图层面板单击图片** → 进入统一编辑层（框选编号红框 + 画笔/橡皮 + 提示词）→ 提交图生图
- 编辑层工具条须避开 Excalidraw 原生工具条（顶部居中），现位于 `top-[88px]`
- 同一功能只保留一处主入口；入口贴近操作对象；界面文案不得出现原始 i18n key
- 平台**所有 AI 生成图片统一 PNG 输出**（`generate_service.to_png()` 在落库前归一化，不依赖上游格式）

## 测试资产
- `e2e/mock_upstream.py`：模拟上游（**故意返回 JPEG**，用于验证 PNG 归一化）
- `e2e/verify_flow.py`：API 全流程断言（自带清理）
- `e2e/ui_verify.mjs`：真实浏览器 UI 全流程（零依赖 CDP：真实鼠标拖拽 + 文件注入 + 下载魔数校验）
- 注意：浏览器自动化需 `--no-sandbox`（本机沙箱内 Chrome 默认沙箱无法初始化）；本机代理需 `NO_PROXY=localhost,127.0.0.1`
