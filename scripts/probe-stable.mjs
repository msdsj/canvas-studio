#!/usr/bin/env node
/**
 * 稳定态空闲开销测量：node scripts/probe-stable.mjs <url> [token] [秒数]
 *
 * 相比 probe-perf.mjs，这里解决两个会污染结论的问题：
 *
 *  1. **不猜「首屏已稳定」**：轮询 TaskDuration 的增量，直到连续 N 个窗口
 *     都低于阈值才认为进入稳定态。固定 sleep 很容易把首屏尾巴算成「空闲开销」。
 *  2. **连测两段**：稳定后先丢弃一段（残留的收尾工作），再采第二段作为结果。
 *     同一页面两段差异大 = 还没真正稳定，结果不可信，会直接提示。
 *
 * 输出：TaskDuration / Script / Style / Layout 的每段增量 + rAF 帧数。
 */
const URL_ = process.argv[2] || 'http://127.0.0.1:27180/workspace'
const TOKEN = process.argv[3] || ''
const SECONDS = Number(process.argv[4] || 8)
const CDP = 'http://127.0.0.1:9222'

const j = async (p) => (await fetch(CDP + p)).json()
const v = await j('/json/version')
const ws = new WebSocket(v.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params, sessionId }))
  })
await new Promise((r, je) => { ws.onopen = r; ws.onerror = je })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const s = (m, p) => send(m, p, sessionId)
await s('Page.enable')
await s('Runtime.enable')
await s('Performance.enable')
await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

if (TOKEN) {
  await s('Page.navigate', { url: 'http://127.0.0.1:27180/login' })
  await new Promise((r) => setTimeout(r, 1800))
  await s('Runtime.evaluate', { expression: `localStorage.setItem('cs.token', ${JSON.stringify(TOKEN)})` })
}
await s('Page.navigate', { url: URL_ })

const pick = async () => {
  const m = (await s('Performance.getMetrics')).metrics
  return Object.fromEntries(m.map((x) => [x.name, x.value]))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等到「连续 3 个 1s 窗口的 TaskDuration 都 < 80ms」才认为首屏收尾结束 */
async function waitQuiet(label) {
  let quiet = 0
  let waited = 0
  let prev = await pick()
  while (quiet < 3 && waited < 45000) {
    await sleep(1000)
    waited += 1000
    const now = await pick()
    const busy = (now.TaskDuration - prev.TaskDuration) * 1000
    prev = now
    quiet = busy < 80 ? quiet + 1 : 0
  }
  return waited
}

const settle = await waitQuiet()
console.log(`\n  稳定判据：等待 ${(settle / 1000).toFixed(1)}s 后进入静默（连续 3 个 1s 窗口 < 80ms）`)

/** 采一段：返回各指标增量 */
async function window8() {
  const before = await pick()
  await s('Runtime.evaluate', {
    expression: `window.__rafCount = 0; (function loop(){ window.__rafCount++; requestAnimationFrame(loop) })()`,
  })
  await sleep(SECONDS * 1000)
  const after = await pick()
  const raf = (await s('Runtime.evaluate', { expression: 'window.__rafCount', returnByValue: true })).result.value
  const d = (k) => Math.round((after[k] - before[k]) * 1000)
  return { task: d('TaskDuration'), script: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration'), raf }
}

// 第一段丢弃（可能还有残留收尾），第二段作为结论
const warm = await window8()
const real = await window8()

const pct = (ms) => ((ms / (SECONDS * 1000)) * 100).toFixed(1)
console.log(`  丢弃段：CPU ${warm.task}ms（${pct(warm.task)}%）  rAF ${warm.raf} 帧`)
console.log(`  ─────────────────────────────────────────`)
console.log(`  实测段：CPU ${real.task}ms → ${pct(real.task)}%`)
console.log(`    脚本 ${real.script}ms · 样式 ${real.style}ms · 布局 ${real.layout}ms`)
console.log(`    rAF ${real.raf} 帧 → ${(real.raf / SECONDS).toFixed(0)} fps`)
const drift = warm.task ? Math.abs(real.task - warm.task) / Math.max(warm.task, 1) : 0
if (drift > 0.4) console.log(`  ⚠️ 两段偏差 ${(drift * 100).toFixed(0)}%：页面可能仍未稳定，结论仅供参考`)

await send('Target.closeTarget', { targetId })
ws.close()