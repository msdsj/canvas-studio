# canvas-studio 部署说明

三组件独立可部署：`frontend`（nginx:80）、`backend`（FastAPI:8000）、`gateway`（FastAPI:8100）。

## 一、Docker Compose 一键起

```bash
cd deploy
cp .env.example .env      # 按需修改密钥与上游地址
docker compose up -d --build
# 如需同时起上游（chatgpt2api / sub2api）：
docker compose --profile upstream up -d
```

访问：`http://localhost`（前端）。默认管理员：`admin@canvas.studio / Admin@12345`。

## 二、本地零依赖启动（无 Docker）

```bash
bash deploy/scripts/start-local.sh
```

将依次：创建后端/网关 venv 并装依赖 → 建表 + seed 管理员 → 启动网关(:8100) → 启动后端(:8000) → 启动前端(:5173)。
前端访问 `http://localhost:5173`。仅管理员初始化可用 `bash deploy/scripts/seed-admin.sh`。

## 三、本地 ↔ 线上切换（只改配置，无需重新部署）

系统配置唯一真源为 backend `system_configs` 表：

1. 登录管理员 → `/admin/config`；
2. 修改 `SUB2API_BASE_URL` / `SUB2API_API_KEY` / `CHATGPT2API_BASE_URL` / `CHATGPT2API_ADMIN_KEY`；
3. 保存即由后端主动 `POST /gw/config` 推送给网关内存缓存，**立即生效**（无需重启）；
4. 点击「连通性测试」可区分 `sub2api` / `chatgpt2api` / `proxy` 是否可达。

> 敏感值（API Key）以密文/掩码展示，留空表示不修改。

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

| 服务 | dev | prod |
|------|-----|------|
| frontend | 5173 | 80 |
| backend | 8000 | 8000 |
| gateway | 8100 | 8100（仅内网） |
| chatgpt2api | 3000 | 3000 |
| sub2api | 8080 | 8080 |

## 七、数据卷

`backend_data` 挂载 `/app/data`（SQLite 库 + `storage/` 图片目录）。
