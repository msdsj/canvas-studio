#!/usr/bin/env node
/**
 * 测量页面空闲时的 CPU 开销：node scripts/probe-perf.mjs <url> <token> [秒数]
 * 输出 ScriptDuration / LayoutDuration / RecalcStyleDuration / TaskDuration 的增量，
 * 以及 10 秒内的 rAF 帧数（判断是否有常驻动画循环）。
 */
const URL_ = process.argv[2] || 'http://127.0.0.1:27180/workspace'
const TOKEN = process.argv[3] || ''
const SECONDS = Number(process.argv[4] || 10)
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
  await new Promise((r) => setTimeout(r, 2200))
  await s('Runtime.evaluate', { expression: `localStorage.setItem('cs.token', ${JSON.stringify(TOKEN)})` })
}

await s('Page.navigate', { url: URL_ })
await new Promise((r) => setTimeout(r, 9000)) // 等首屏稳定

const pick = (metrics) => Object.fromEntries(metrics.map((m) => [m.name, m.value]))
const before = pick((await s('Performance.getMetrics')).metrics)

// 不注入自己的 rAF 循环：否则测出来的帧数是被测量代码自己制造的，
// 无法反映页面真实动画开销。只靠 Performance 指标判断。
await new Promise((r) => setTimeout(r, SECONDS * 1000))

const after = pick((await s('Performance.getMetrics')).metrics)

const ms = (key) => Math.round((after[key] - before[key]) * 1000)
const total = ms('TaskDuration')
console.log(`\n  采样时长 ${SECONDS}s（页面空闲，无用户操作）`)
console.log(`  ─────────────────────────────────────────`)
console.log(`  CPU 总忙碌      ${total} ms   → 占用率 ≈ ${((total / (SECONDS * 1000)) * 100).toFixed(1)}%`)
console.log(`    脚本执行      ${ms('ScriptDuration')} ms`)
console.log(`    样式重算      ${ms('RecalcStyleDuration')} ms`)
console.log(`    布局          ${ms('LayoutDuration')} ms`)
console.log(`  堆内存          ${(after.JSHeapUsedSize / 1048576).toFixed(1)} MB`)
console.log(`  DOM 节点        ${after.Nodes}`)

await send('Target.closeTarget', { targetId })
ws.close()
