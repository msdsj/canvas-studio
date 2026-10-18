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