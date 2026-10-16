# Canvas Studio 全流程测试报告（v2.0 · 图片编辑重构轮）

> 日期：2026-10-16 · 执行人：交付团队 · 环境：macOS · Node 22.22.2 · Python 3.13.12
> 被测版本：本轮「图片编辑链路重构 + 类 Figma 图层 + 导出扩展」改动
> 结论：**IS_PASS = YES**（自动化断言 128 项全通过，0 失败）

---

## 一、测试环境与拓扑

| 组件 | 地址 | 说明 |
|---|---|---|
| 前端 | http://127.0.0.1:27180 | Vite 6 dev（`/api`、`/static` 反代后端） |
| 后端 | http://127.0.0.1:27181 | FastAPI + SQLite（本轮重建 dev 库） |
| 网关 | http://127.0.0.1:27182 | `CS_DEMO_MODE=off`，强制走真实上游链路 |
| 模拟上游 | http://127.0.0.1:3000 | `e2e/mock_upstream.py`，**故意返回 JPEG** |
| 浏览器 | Chrome 155 headless | 通过 CDP 驱动（零依赖 Node 脚本） |

> 刻意把 Demo 降级关掉 + 让上游返回 JPEG：若"统一 PNG"没生效，测试会直接暴露为格式不符。

---

## 二、执行结果总览

| # | 测试层 | 命令 | 断言数 | 结果 |
|---|---|---|---|---|
| 1 | 后端单元/接口 | `backend/.venv/bin/python -m pytest -q` | 89 | ✅ 89 passed |
| 2 | 前端类型 | `npm run typecheck` | — | ✅ 0 error |
| 3 | 前端 Lint | `npx eslint src` | — | ✅ 0 error / 4 warning（改动外既有文件） |
| 4 | 前端构建 | `npm run build` | — | ✅ built in 7.55s |
| 5 | API 全流程 | `python e2e/verify_flow.py` | 19 | ✅ 19/19 |
| 6 | 真实浏览器 UI 全流程 | `node e2e/ui_verify.mjs` | 20 | ✅ 20/20 |
| | **合计** | | **128** | **0 失败** |

---

## 三、API 全流程（19 项）

```
✅ 登录超管账号 — HTTP 200
✅ 关闭 Demo 降级（走真实上游） — HTTP 200
✅ 内置提示词配置接口 — 5 个预设
✅ 上传图片并保存内置提示词 — 把背景换成纯白色
✅ 创建文生图任务 — HTTP 200
✅ 文生图任务成功 — succeeded
✅ 文生图结果为 .png 资源 — ae7404ea-….png
✅ 文生图产物字节为真 PNG — 4547 bytes          ← 上游给的是 JPEG
✅ 创建图生图（编辑）任务 — HTTP 200
✅ 图生图任务成功 — succeeded
✅ 图生图结果为 .png 资源 — b35f4a2e-….png
✅ 图生图产物字节为真 PNG — 2571 bytes          ← 上游给的是 JPEG
✅ 图生图产物可正常解码 — 512x512 PNG
✅ 编辑任务记录了 region 选区 — [{"x":0.25,"y":0.25,"w":0.3,"h":0.3}]
✅ 编辑任务保留了 mask
✅ 保存画布图层状态 — HTTP 200
✅ 图层元素可持久化并回读 — 1 个元素
✅ 额度已按任务扣减 — 当前余额 90
✅ 清理验证项目 — HTTP 200
```

**关键结论**：上游返回 JPEG 的情况下，平台落库资源后缀为 `.png`、字节首 8 位为 `89 50 4E 47 0D 0A 1A 0A` —— **统一 PNG 输出生效**。

---

## 四、真实浏览器 UI 全流程（20 项）

```
✅ 登录页正常渲染
✅ 登录并进入工作台
✅ 图层面板渲染
✅ 上传流程内置提示词配置弹窗
✅ 提示词预设可一键选用 — 5 个预设按钮
✅ 上传成功并出现在图层面板
✅ 图层名取自文件名 — 图层项显示 cs-upload
✅ 单击图片即进入编辑模式
✅ 编辑层提示词输入可用
✅ 框选生成编号标记（1 区域）
✅ 提交图生图任务（提示词 + 标记图）
✅ 导出 PNG 真实可用 — canvas-*.png · 14219 bytes · PNG 魔数校验通过
✅ 导出 JPG 真实可用 — canvas-*.jpg · 21895 bytes · JPEG 魔数校验通过
✅ 图层可查看全部元素
✅ 图层可调整层级（下移）— 顶层元素下移后层级顺序改变
✅ 图层可切换显隐 — 隐藏后图层项呈删除线态
✅ 图层可锁定/解锁
✅ 图层选中与画布双向同步 — 高亮图层=命中，右栏预览=true
✅ 从图层选中图片同样进入编辑模式
✅ 已消除与单击编辑冲突的「双击裁剪」入口
```

**测试手段**：`Input.dispatchMouseEvent` 真实鼠标事件（含拖拽框选）、`DOM.setFileInputFiles` 真实文件注入、
`Browser.setDownloadBehavior` 真实下载并做字节魔数校验、`getComputedStyle` 校验样式生效。
非"读 DOM 文本"式弱验证。

---

## 五、需求逐条对照

| 需求 | 验收点 | 结论 |
|---|---|---|
| ① 修复图片编辑失效 | 单击图片 → 编辑层打开 → 框选 → 提交成功 | ✅ |
| ① 上传内置提示词 | 上传弹窗含预设与输入框；`source_prompt` 落库并回填 | ✅ |
| ① 统一 PNG 输出 | 上游 JPEG → 落库真 PNG（API + UI 双层验证） | ✅ |
| ② 类 Figma 画布 / 图层 | 图层可查看、可选中、可调层级、可显隐/锁定/删除 | ✅ |
| ③ 单击进入编辑 | 单击（非拖拽）即进入；点空白/完成/ESC 退出 | ✅ |
| ③ 框选 + 标记 + 修改 | 编号红框、画笔/橡皮标注、提示词 | ✅ |
| ③ 标记图 + 提示词送上游 | `region` / `mask` / `prompt` 均正确透传并成功出图 | ✅ |
| ④ UX 梳理去冗余 | 移除 3 组件 / 3 废弃事件 / 3 处重复入口 / 1 诊断钩子 | ✅ |
| ⑤ 导出 PNG + JPG | 两种格式真实下载且字节格式正确 | ✅ |
| ⑥ 全流程测试 | 上传→生成→编辑→框选→AI 调用→导出 全链路无异常 | ✅ |

---

## 六、过程中发现并修复的缺陷（本轮新增）

| 级别 | 缺陷 | 根因 | 修复 |
|---|---|---|---|
| **P0** | 工作台白屏 `Maximum update depth exceeded` | `handleChange` 无条件 `setElements/setSelectedIds`，Excalidraw 每次 onChange 都给新数组引用 → 无限回灌 | 引入 `sceneSignature()` 内容级比较，仅真正变化才落 state |
| **P1** | 图层面板点击无反应（选中不同步） | Excalidraw 程序化 `updateScene({appState:{selectedElementIds}})` **不触发 onChange** | 图层选中由面板直接回调同步选中态，同时保留 `updateScene` 让画布显示选中框 |
| **P1** | 图层显隐 / 锁定不生效 | 只改 `opacity`/`locked` 未升版本号，Excalidraw 判定元素"未变化"而丢弃 | `LayerPanel.patch()` 统一 bump `version` / `versionNonce` / `updated` |
| **P2** | 编辑层工具条与 Excalidraw 原生工具条重叠 | 两者都定位在顶部居中 | 编辑层工具条下移至 `top-[88px]` |
| **P2** | 双击编辑与原生"双击裁剪"冲突 | Excalidraw 原生行为未被拦截 | `onDoubleClickCapture` 拦截 + CSS 隐藏裁剪提示 |

---

## 七、遗留风险与后续

| 级别 | 事项 | 说明 |
|---|---|---|
| P1 | 真实上游接入复验 | 本轮上游为本地 mock；替换线上 URL + Key 后需复跑 `e2e/verify_flow.py` |
| P2 | 多选批量 / 拖拽排序 | 图层面板目前单选 + 按钮式排序 |
| P3 | 旋转元素编辑 | 编辑层对旋转图用外接盒近似 |
| P3 | 移动端手势 | 未覆盖移动端双指缩放/长按菜单 |

---

## 八、复现命令

```bash
# 1) 启动模拟上游（返回 JPEG）
backend/.venv/bin/python e2e/mock_upstream.py

# 2) 启动网关（关闭 Demo 降级）
cd gateway && CS_DEMO_MODE=off CHATGPT2API_BASE_URL=http://127.0.0.1:3000 \
  .venv/bin/uvicorn app.main:app --port 27182

# 3) 启动后端
cd backend && CS_DEMO_MODE=off .venv/bin/uvicorn app.main:app --port 27181

# 4) 启动前端
cd frontend && npm run dev -- --port 27180

# 5) API 全流程
backend/.venv/bin/python e2e/verify_flow.py

# 6) 真实浏览器 UI 全流程（需 Chrome 以 --remote-debugging-port=9222 启动）
node e2e/ui_verify.mjs
```
