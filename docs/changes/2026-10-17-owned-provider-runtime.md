# 自有 Provider 与账号池

## 背景

Canvas Studio 曾把文本、图片和账号池请求转发到两个外部参考项目。它们现在只保留为实现参考，运行时不再需要启动或安装。

## 运行时边界

- gateway 直接调用 OpenAI 兼容的第三方文本 provider：`TEXT_API_BASE_URL`、`TEXT_API_KEY`、`TEXT_MODEL`。
- gateway 直接调用 OpenAI 兼容的第三方图片 provider：`IMAGE_API_BASE_URL`、`IMAGE_API_KEY`、`IMAGE_MODEL`。
- 意图分析可配置独立的 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`；留空时复用文本 provider。
- `/gw/pool/accounts*` 由 gateway 自己实现，账号凭据持久化到 `POOL_FILE`，支持导入、删除、轮询选择、失败冷却、状态更新、刷新任务和导出。
- 图片请求优先选择本地账号池中的可用凭据；没有账号池时使用图片 provider 的固定 API Key。

## 兼容行为

backend 的管理员号池 API、图片任务 API、对话 API 和前端配置页保持原有调用边界。旧数据库中的四个外部服务配置会在启动时迁移到通用文本/图片配置并移除旧配置项。

通用 API Key 没有统一的 OAuth、额度刷新协议，因此账号池的刷新/重登录接口会生成已完成的维护任务并记录时间；真正的 provider-specific OAuth 可以作为后续 adapter 扩展，不会再通过外部项目代理。

## 部署

Docker Compose 只启动 frontend、backend、gateway，并为 gateway 挂载 `gateway_data` 保存账号池。第三方 provider 地址和密钥由环境变量或 `/admin/config` 配置，保存后由 backend 推送到 gateway 即时生效。
