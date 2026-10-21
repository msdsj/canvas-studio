#!/usr/bin/env node
/**
 * 空闲开销归因：node scripts/probe-idle.mjs <url> [token] [秒数]
 *
 * 与 probe-perf.mjs 的区别：这里在页面脚本之前注入计数器，按「调用方堆栈」
 * 统计 rAF / setTimeout / setInterval / MutationObserver 回调，
 * 直接指出空闲时到底是谁在跑，而不是只给一个总 CPU 占用。
 */
const URL_ = process.argv[2] || 'http://127.0.0.1:27180/workspace'
const TOKEN = process.argv[3] || ''
const SECONDS = Number(process.argv[4] || 6)
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

/** 注入到每个新文档：按调用栈归因统计各类回调 */
const INSTRUMENT = `
(() => {
  const buckets = { raf: {}, timer: {}, interval: {}, mo: {} }
  window.__idleStats = buckets
  const key = (stack) => {
    const lines = String(stack || '').split('\\n').slice(2, 5)
      .map((l) => l.trim().replace(/^at\\s+/, '').replace(/https?:\\/\\/[^/]+/, ''))
      .filter(Boolean)
    return lines.join(' < ') || '(anonymous)'
  }
  const bump = (b, k) => { buckets[b][k] = (buckets[b][k] || 0) + 1 }
  const origRaf = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = function (cb) {
    const k = key(new Error().stack)
    return origRaf(function (t) { bump('raf', k); return cb(t) })
  }
  const origST = window.setTimeout.bind(window)
  window.setTimeout = function (fn, d, ...rest) {
    const k = key(new Error().stack)
    return origST(function () { bump('timer', k); return typeof fn === 'function' ? fn.apply(this, rest) : undefined }, d)
  }
  const origSI = window.setInterval.bind(window)
  window.setInterval = function (fn, d, ...rest) {
    const k = key(new Error().stack)
    return origSI(function () { bump('interval', k); return typeof fn === 'function' ? fn.apply(this, rest) : undefined }, d)
  }
  const OrigMO = window.MutationObserver
  window.MutationObserver = class extends OrigMO {
    constructor(cb) {
      const k = key(new Error().stack)
      super(function (...a) { bump('mo', k); return cb.apply(this, a) })
    }
  }
  window.__resetIdle = () => { for (const b of Object.keys(buckets)) buckets[b] = {} }
})()
`

await s('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT })

if (TOKEN) {
  await s('Page.navigate', { url: 'http://127.0.0.1:27180/login' })
  await new Promise((r) => setTimeout(r, 2200))
  await s('Runtime.evaluate', { expression: `localStorage.setItem('cs.token', ${JSON.stringify(TOKEN)})` })
}

await s('Page.navigate', { url: URL_ })
await new Promise((r) => setTimeout(r, 9000))

const pick = (metrics) => Object.fromEntries(metrics.map((m) => [m.name, m.value]))
const before = pick((await s('Performance.getMetrics')).metrics)
await s('Runtime.evaluate', { expression: 'window.__resetIdle()' })

await new Promise((r) => setTimeout(r, SECONDS * 1000))

const after = pick((await s('Performance.getMetrics')).metrics)
const stats = (await s('Runtime.evaluate', {
  expression: 'JSON.stringify(window.__idleStats || {})',
  returnByValue: true,
})).result.value

const ms = (key) => Math.round((after[key] - before[key]) * 1000)
const total = ms('TaskDuration')
console.log(`\n  空闲采样 ${SECONDS}s · ${URL_}`)
console.log(`  ─────────────────────────────────────────`)
console.log(`  CPU 忙碌 ${total} ms → ${((total / (SECONDS * 1000)) * 100).toFixed(1)}%`)
console.log(`    脚本 ${ms('ScriptDuration')} ms · 样式 ${ms('RecalcStyleDuration')} ms · 布局 ${ms('LayoutDuration')} ms`)

const parsed = JSON.parse(stats || '{}')
const label = { raf: 'requestAnimationFrame', timer: 'setTimeout', interval: 'setInterval', mo: 'MutationObserver' }
for (const kind of ['raf', 'interval', 'timer', 'mo']) {
  const entries = Object.entries(parsed[kind] || {}).sort((a, b) => b[1] - a[1]).slice(0, 8)
  if (!entries.length) continue
  console.log(`\n  ${label[kind]} 回调 Top：`)
  for (const [k, n] of entries) console.log(`    ${String(n).padStart(5)} 次  ${k}`)
}

await send('Target.closeTarget', { targetId })
ws.close()
