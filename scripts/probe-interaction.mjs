#!/usr/bin/env node
/**
 * 交互态开销测量：node scripts/probe-interaction.mjs <url> [token] [秒数]
 *
 * 空闲态看不出画布相关优化的价值——原版每帧都做全量元素扫描，但「场景签名没变
 * 就直接 return」，静止时本来就很便宜。真正要量的是**连续平移 / 缩放**时：
 * 那时签名每帧都在变，全量扫描 + 包围盒计算是实打实的成本。
 *
 * 做法：稳定后对画布区域连续派发 wheel 事件（缩放），统计这段时间的 CPU。
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

if (TOKEN) {
  await s('Page.navigate', { url: 'http://127.0.0.1:27180/login' })
  await new Promise((r) => setTimeout(r, 1800))
  await s('Runtime.evaluate', { expression: `localStorage.setItem('cs.token', ${JSON.stringify(TOKEN)})` })
}
await s('Page.navigate', { url: URL_ })
await new Promise((r) => setTimeout(r, 9000))

const pick = async () => {
  const m = (await s('Performance.getMetrics')).metrics
  return Object.fromEntries(m.map((x) => [x.name, x.value]))
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 画布中心（画布卡在左栏 268 之后、右侧对话 400 之前）
const CX = 620
const CY = 450

const before = await pick()
// 连续缩放：每秒约 30 次 wheel，持续 SECONDS 秒
const ticks = SECONDS * 30
for (let i = 0; i < ticks; i++) {
  await s('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: CX,
    y: CY,
    deltaX: 0,
    deltaY: i % 60 < 30 ? 12 : -12, // 来回缩放，避免撞到缩放上下限
  })
  await sleep(1000 / 30)
}
const after = await pick()

const d = (k) => Math.round((after[k] - before[k]) * 1000)
const total = d('TaskDuration')
console.log(
  JSON.stringify({
    seconds: SECONDS,
    cpuMs: total,
    cpuPct: Number(((total / (SECONDS * 1000)) * 100).toFixed(1)),
    scriptMs: d('ScriptDuration'),
    styleMs: d('RecalcStyleDuration'),
    layoutMs: d('LayoutDuration'),
  })
)

await send('Target.closeTarget', { targetId })
ws.close()