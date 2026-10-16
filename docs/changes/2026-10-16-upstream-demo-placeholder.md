# 上游生图链路修复：DEMO 占位图冒充成功

- **日期**：2026-10-16 20:10–20:35
- **严重级别**：P0（平台核心功能不可用，且**失败被伪装成成功**）
- **影响**：所有文生图/图生图结果都是占位图（红字 `CANVAS STUDIO · DEMO`），任务状态却是 `succeeded`，用户完全无法察觉

---

## 一、背景与现象

用户在画布上看到的两张"图"几乎空白、只有一行红字标题和一段说明文字。

后端产物可验证：结果图内含 `CANVAS STUDIO · DEMO` 与 `DEMO PLACEHOLDER` 水印文本。
在数据库中，这些任务的 `demo` 字段为 `1`（平台用来标记"这是演示占位图，不是真实生成"）。

---

## 二、排查路径

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1 | curl 直连 chatgpt2api 生图（模型 `gpt-image-1`） | ❌ `unsupported image model`，上游只支持 `gpt-image-2` 系列 |
| 2 | curl 直连（模型 `gpt-image-2`） | ✅ 成功返回 b64 → **网络与上游本身没问题** |
| 3 | 带 `quality: standard` 参数复测 | ✅ 仍成功 → 排除参数问题 |
| 4 | 平台端到端提交生图任务 | ⚠️ `succeeded`，但下载结果图 = 占位图 |
| 5 | 带 `X-Internal-Token: dev-internal-token` 直调网关 `/gw/images/generations` | ❌ 返回 `demo: true` |
| 6 | 在 `image_router.py` 的 demo 回退分支加 warning 日志 | 🎯 **抓到真相：`401 Unauthorized`** |

---

## 三、根因（两个独立缺陷叠加）

### 根因 1：本地回环调用被错误地挂上 VPN 代理

`gateway/app/upstream.py` 的 `make_client()` 无差别地把 `runtime_config.proxy_url`（本机 VPN `http://127.0.0.1:7890`）挂到**所有**上游请求上。

而平台 → 上游 chatgpt2api 是**本机回环调用**（`http://localhost:3000`），根本不需要代理。这条回环请求被劫持到 VPN 代理，一旦代理不可用/异常，整条生图链路就会失败。

> 项目架构约定里本就写明「平台→上游是本地回环调用不走代理」，加代理配置时没有把这个边界排除掉。

### 根因 2：网关重启后运行时配置丢失 → 上游 401

`backend` 只在**自己启动时**推一次配置给网关（`lifespan` → `push_to_gateway`）。单独重启网关后：

- 网关的 `runtime_config.chatgpt2api_admin_key` 退回 `settings` 默认值 `"xxx"`
- 带错误 Key 请求 chatgpt2api → **401**
- `demo_mode=auto` 捕获该异常 → **静默降级为占位图**（任务状态仍是成功）

---

## 四、修复方案

### 1. 回环地址永不挂代理（`gateway/app/upstream.py`）

```python
def _is_loopback(base_url: str) -> bool:
    """本地回环地址判断：平台→上游为本地回环调用，永不走代理。"""
    host = urlparse(base_url).hostname or ""
    return host in {"localhost", "127.0.0.1", "::1", "0.0.0.0"}

proxy = None if _is_loopback(base_url) else (runtime_config.proxy_url or None)
```

### 2. 配置周期性同步（`backend/app/services/scheduler.py`）

新增调度任务 `_config_sync_job`，**每 60 秒**把上游地址/Key/代理/Demo 模式重新推送给网关。网关无论何时重启，最多 60 秒自动恢复配置，不再依赖"谁先启动"。

### 3. demo 回退前打日志（`gateway/app/services/image_router.py`）

降级是保护机制，但静默降级会掩盖故障。保留 warning 日志：

```
生图上游失败（demo 回退前）: ErrorCode.UPSTREAM_ERROR 上游鉴权失败，请检查 Key 配置
```

以后再出现占位图，直接看网关日志即可定位真实原因。

---

## 五、改动文件清单

| 文件 | 改动 |
|---|---|
| `gateway/app/upstream.py` | 新增 `_is_loopback()`；`make_client` 对回环地址不挂代理 |
| `gateway/app/services/image_router.py` | demo 回退前 `logger.warning` 记录真实错误（保留） |
| `backend/app/services/scheduler.py` | 新增 `_config_sync_job`（60s 周期 `push_to_gateway`），并注册进 `start_scheduler` |

---

## 六、验证

- 网关直调 `/gw/images/generations` → `demo: false`
- 平台端到端 `POST /api/generate/image` → `succeeded`、`demo=False`、结果图 1254×1254 真实照片（橘猫，与提示词一致）
- 单独重启 gateway 后等待 ≤60s → 配置自动恢复，生图恢复正常

---

## 七、遗留与运维提示

1. **上游模型名固定为 `gpt-image-2`**（`codex-gpt-image-2` / `plus-` / `pro-` / `team-` 等变体亦可）；旧的 `gpt-image-1` 已下线
2. 用户界面若卡片带「演示结果」标签，说明那次是降级产物 → 直接重试即可
3. 排查占位图问题的标准动作：`grep "demo 回退前"` 网关日志
4. `DEMO_MODE=off` 可让上游失败直接报错（不再降级），适合正式环境验证