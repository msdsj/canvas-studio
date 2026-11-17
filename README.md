# Canvas Studio

[![Product preview](frontend/public/generated/preview-mountain.jpg)](frontend/public/generated/preview-mountain.jpg)

Canvas Studio 是一个用于 AI 图像创作与编辑的 Web 应用。它将提示词、图片生成与编辑、项目管理和无限画布整合在同一工作区。

## 功能

- 通过提示词生成图像，并在画布中组织结果
- 上传图片、进行编辑，并对局部区域添加标注后提交修改
- 管理项目、素材和生成任务
- 通过 AI 网关连接 OpenAI 兼容的文本与图像服务

## 架构

```text
React / TypeScript 前端 → FastAPI 业务后端 → FastAPI AI 网关 → 模型服务
```

- `frontend/`：React 19、TypeScript、Vite
- `backend/`：FastAPI 业务 API、数据库及文件存储
- `gateway/`：模型请求转发与上游服务接入
- `deploy/`：Docker Compose 配置

## 本地开发

要求 Node.js、npm、Python 3.11+。模型生成需要可访问的兼容模型服务及相应 API key。

1. 复制根目录 `.env.example` 为 `.env`，为密钥、管理员密码及需要使用的模型服务配置独立值。不要提交 `.env`。
2. 分别安装前后端依赖：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
python3 -m venv gateway/.venv
gateway/.venv/bin/pip install -r gateway/requirements.txt
cd frontend && npm install
```

3. 初始化后端数据目录和数据库：

```bash
mkdir -p backend/data/storage
cd backend && .venv/bin/python -m app.migrations.run
```

4. 启动服务。可按[启动与运行指南](启动与运行指南.md)逐项启动，或使用仓库提供的本地启动脚本。开发服务默认地址为前端 `http://localhost:27180`、后端 `http://localhost:27181`、网关 `http://localhost:27182`。端口、环境变量和脚本选项以对应配置为准。

## Docker Compose

部署前，在 `deploy/` 创建本地 `.env` 并填写强随机 `CS_SECRET_KEY`、`CS_GATEWAY_INTERNAL_TOKEN` 和唯一的 `CS_DEFAULT_ADMIN_PASSWORD`，以及所需模型服务配置。不要把真实密钥提交到仓库。

```bash
cd deploy
cp .env.example .env
# 编辑 .env，替换所有 replace-with-... 值为独立的强随机凭据
docker compose --env-file .env up --build
```

## 检查与测试

```bash
cd frontend && npm run typecheck && npm run lint && npm run build
cd backend && .venv/bin/python -m pytest tests/ -q
cd gateway && .venv/bin/python -m pytest tests/ -q
```

## 配置与安全

- `.env.example` 文件仅是变量模板，不是可直接用于生产的配置；所有标记为 `replace-with-...` 的值都必须替换。
- 不要提交 `.env`、浏览器认证状态、日志、数据库、个人运行报告或真实 API key。
- 生产部署必须设置强随机秘密、唯一管理员密码，并将服务限制在预期网络范围内。
- 如果凭据曾提交或推送，应立即在对应服务撤销并轮换；删除当前文件不会从 Git 历史中移除旧值。

## 图片与许可

README 展示图复用 `frontend/public/generated/preview-mountain.jpg`，该图片同时用于应用内预览。发布仓库前，请确认该素材的创作来源和再分发许可；仓库中的所有图片、字体、图标及第三方依赖均应分别遵循其适用许可。若无法确认某项素材的再分发权，请在发布前替换为已获授权的图片。
