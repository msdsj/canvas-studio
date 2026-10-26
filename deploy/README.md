# msdsj 部署说明

三组件独立可部署：`frontend`（nginx:80）、`backend`（FastAPI:8000）、`gateway`（FastAPI:8100）。

## 一、Docker Compose 一键起

```bash
cd deploy
cp .env.example .env      # 按需修改密钥与上游地址
docker compose up -d --build
# 第三方 provider 由网关直接访问，不需要额外启动上游容器。
```

访问：`http://localhost`（前端）。默认管理员：`admin@canvas.studio / Admin@12345`。

## 二、本地零依赖启动（无 Docker）

```bash
bash deploy/scripts/start-local.sh
```

将依次创建后端/网关 venv 并安装依赖、初始化数据库和管理员，再启动本地服务。脚本使用固定开发端口：网关 `27182`、后端 `27181`、前端 `27180`。
前端访问 `http://localhost:27180`，后端健康检查为 `http://localhost:27181/api/health`，网关健康检查为 `http://localhost:27182/gw/health`。仅管理员初始化可用 `bash deploy/scripts/seed-admin.sh`。

需要后台常驻运行时可使用：

```bash
bash deploy/scripts/start-local-daemon.sh start
bash deploy/scripts/start-local-daemon.sh status
```

本地脚本从 `backend/.env`、`gateway/.env` 和 `frontend/.env` 读取配置；Docker Compose 则读取 `deploy/.env`。

## 三、本地 ↔ 线上切换（只改配置，无需重新部署）

系统配置唯一真源为 backend `system_configs` 表：

1. 登录管理员 → `/admin/config`；
2. 修改 `TEXT_API_BASE_URL` / `TEXT_API_KEY` / `TEXT_MODEL`、`IMAGE_API_BASE_URL` / `IMAGE_API_KEY` / `IMAGE_MODEL`，以及可选的 `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`；
3. 保存即由后端主动 `POST /gw/config` 推送给网关内存缓存，**立即生效**（无需重启）；
4. 点击「测试文本服务」「测试图片服务」「测试意图模型」或「测试账号池」验证对应能力。

> 敏感值（API Key）以密文/掩码展示，留空表示不修改。

`LLM_BASE_URL` 需要指向 OpenAI 兼容接口的地址，通常填到提供商的 `/v1` 路径；网关会请求 `${LLM_BASE_URL}/chat/completions` 和 `${LLM_BASE_URL}/models`。`LLM_MODEL` 留空时使用中转站默认模型。首次初始化时，环境变量会作为后台配置表的默认值；已有项目建议直接在 `/admin/config` 中填写并保存。

## 四、VPN 代理（服务器内部网络）

网关的 httpx 支持 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`：

- 方式一：环境变量（compose `.env` 或 shell）；
- 方式二：`/admin/config` 的 `HTTP_PROXY` / `HTTPS_PROXY` 项（推送网关即生效）。

连通性测试中若返回 `PROXY_UNREACHABLE`，表示代理/VPN 不可达；`UPSTREAM_ERROR` 表示代理通但上游异常。

## 五、Demo 演示模式

`CS_DEMO_MODE`（或 `/admin/config` 的 `DEMO_MODE`）：

| 值 | 行为 |
|----|------|
| `auto`（默认） | 上游不可达/池空时自动降级为占位图 / 模拟对话，响应标 `demo:true` |
| `on` | 强制演示（始终返回占位结果） |
| `off` | 严格真实上游，不可达则报 `UPSTREAM_ERROR` / `POOL_UNAVAILABLE` |

降级结果不扣费（未成功不扣费），前端在结果卡标注「演示结果」。

## 六、端口规划

| 服务 | Docker Compose dev | Docker Compose prod | 本地脚本 |
|------|-------------------|--------------------|----------|
| frontend | 5173 | 80 | 27180 |
| backend | 8000 | 8000 | 27181 |
| gateway | 8100 | 8100（仅内网） | 27182 |

## 七、数据卷

`backend_data` 挂载 `/app/data`（SQLite 库 + `storage/` 图片目录）；`gateway_data` 挂载网关自己的 provider 账号池文件。

## 八、多账号并发与部署边界

账号可以在单个 Gateway 进程内并发使用，图片请求通过异步任务队列执行，后端的 `CS_IMAGE_CONCURRENCY`（默认 4）控制同时调用上游的任务数，超出的任务排队。Gateway 在一个进程内用租约和批次预留避免本地账号重复分配；因此部署时保留 `gateway` 单 worker、单副本，不要使用 `--scale gateway` 或额外启动同一账号池的 Gateway 实例。

本地号池模式可以为同一批的每张图严格预留不同凭据。chatgpt2api 上游模式会为每张图提交独立的并发请求，由上游轮询 ChatGPT 账号；上游报告的健康数量用于提交前容量检查，但上游没有任务级账号租约接口，所以不能保证同一批的每张图绝不落到同一个账号。chatgpt2api 也应保持单 worker。

横向扩容需要先把账号租约、在途计数、批次预留、冷却状态和上游任务状态迁移到 Redis 或共享数据库，并为每个账号使用原子租约与过期回收；仅共享账号 JSON 文件不能安全扩容。当前 Docker Compose 和本地启动脚本都显式使用单 Gateway worker。
