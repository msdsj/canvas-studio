#!/usr/bin/env node
/**
 * 干净的空闲开销测量（不注入 rAF 计数循环）。
 *
 * 为什么单独写一个：probe-perf / probe-stable 为了数 rAF 帧数，会自己注入一个
 * `requestAnimationFrame` 循环。那个循环本身就让页面**无法进入空闲**，
 * 等于给被测页面加了一份固定负载，A/B 对比时会把真实差异淹掉。
 * 这里只读 CDP 的 Performance 指标，零注入。
 *
 * 流程：导航 → 轮询到连续 3 个 1s 窗口 TaskDuration < 阈值（进入静默）
 *      → 丢弃一段 → 采一段作为结论。
 *
 * 用法：node scripts/probe-quiet.mjs <url> [token] [秒数]
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

let prev = await pick()
let quiet = 0
let waited = 0
while (quiet < 3 && waited < 40000) {
  await sleep(1000)
  waited += 1000
  const now = await pick()
  const busy = (now.TaskDuration - prev.TaskDuration) * 1000
  prev = now
  quiet = busy < 60 ? quiet + 1 : 0
}
const reachedQuiet = quiet >= 3

async function measure() {
  const before = await pick()
  await sleep(SECONDS * 1000)
  const after = await pick()
  const d = (k) => Math.round((after[k] - before[k]) * 1000)
  return { task: d('TaskDuration'), script: d('ScriptDuration'), style: d('RecalcStyleDuration'), layout: d('LayoutDuration') }
}

await measure() // 丢弃段
const real = await measure()

const pct = (ms) => ((ms / (SECONDS * 1000)) * 100).toFixed(1)
// 机器可读的一行，方便外层脚本聚合
console.log(
  JSON.stringify({
    quiet: reachedQuiet,
    settleMs: waited,
    cpuMs: real.task,
    cpuPct: Number(pct(real.task)),
    scriptMs: real.script,
    styleMs: real.style,
    layoutMs: real.layout,
  })
)

await send('Target.closeTarget', { targetId })
ws.close()