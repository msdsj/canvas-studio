#!/usr/bin/env node
/**
 * 空闲 CPU 采样归因：node scripts/probe-cpu.mjs <url> [token] [秒数]
 *
 * 用 CDP 的采样分析器统计「页面静止时」各函数的自耗时，
 * 输出 Top N 热点（函数名 + 文件行号 + 占比），用来定位谁在空转。
 */
const URL_ = process.argv[2] || 'http://127.0.0.1:27180/workspace'
const TOKEN = process.argv[3] || ''
const SECONDS = Number(process.argv[4] || 6)
const TOP = Number(process.argv[5] || 18)
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
await s('Profiler.enable')
await s('Profiler.setSamplingInterval', { interval: 200 })
await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

if (TOKEN) {
  await s('Page.navigate', { url: 'http://127.0.0.1:27180/login' })
  await new Promise((r) => setTimeout(r, 2200))
  await s('Runtime.evaluate', { expression: `localStorage.setItem('cs.token', ${JSON.stringify(TOKEN)})` })
}

await s('Page.navigate', { url: URL_ })
await new Promise((r) => setTimeout(r, 9000))

await s('Profiler.start')
await new Promise((r) => setTimeout(r, SECONDS * 1000))
const { profile } = await s('Profiler.stop')

// 聚合：按 (函数名 + 位置) 统计采样命中次数
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
const self = new Map()
let total = 0
for (const node of profile.nodes) {
  const hits = node.hitCount || 0
  if (!hits) continue
  total += hits
  const f = node.callFrame
  const file = String(f.url || '').replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')
  const key = `${f.functionName || '(anonymous)'}  ${file ? file + ':' + (f.lineNumber + 1) : '(native)'}`
  self.set(key, (self.get(key) || 0) + hits)
}

const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP)
console.log(`\n  空闲 CPU 采样 ${SECONDS}s · ${URL_}`)
console.log(`  采样点 ${total} 个（约 ${(total / SECONDS).toFixed(0)} 个/秒，越高说明主线程越忙）`)
console.log(`  ─────────────────────────────────────────────────────────`)
for (const [k, n] of rows) {
  const pct = ((n / total) * 100).toFixed(1).padStart(5)
  console.log(`  ${pct}%  ${String(n).padStart(5)}  ${k}`)
}

await send('Target.closeTarget', { targetId })
ws.close()
