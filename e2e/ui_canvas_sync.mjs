#!/usr/bin/env node
/**
 * 需求 3 定向验证：**全新会话**提交 → 出图后
 *   ① 对话区底部出现结果坞（主展示）
 *   ② 画布**同步**出现该图片（不是历史遗留，不靠点「放入画布」）
 *
 * 判定方式用视觉取证：截图 + 画布内 canvas 非空像素统计。
 * Excalidraw 把图片画在 <canvas> 上，DOM 里没有 <img>，所以按像素判断最可靠。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFileSync, mkdirSync } from 'node:fs'

const APP = 'http://127.0.0.1:27180'
const CDP = 'http://127.0.0.1:9222'
const OUT = '/Users/meishiduoshuijiao/Desktop/canvas-studio/deliverables/gstack/shots'
mkdirSync(OUT, { recursive: true })

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)) }, 120000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'))
    console.log('shot:', name)
  }
}

const PASS = []
const FAIL = []
const check = (name, ok, detail = '') => {
  ;(ok ? PASS : FAIL).push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const login = await fetch('http://127.0.0.1:27180/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@canvas.studio', password: 'Admin@12345' }),
}).then((r) => r.json())
const token = login.data.access_token

const tab = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json())
const ws = new WebSocket(tab.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
const page = new Session(ws)
await page.send('Page.enable')
await page.send('Runtime.enable')
await page.send('Emulation.setDeviceMetricsOverride', { width: 1512, height: 950, deviceScaleFactor: 2, mobile: false })
await page.eval(`localStorage.setItem('cs.token', ${JSON.stringify(token)}); localStorage.setItem('cs.theme','light'); true`)
await page.send('Page.navigate', { url: APP + '/workspace' })
await sleep(6500)

// 画布区域非空像素比例（判断"画布上到底有没有东西"）
const canvasInk = `(() => {
  const cs = [...document.querySelectorAll('.excalidraw__canvas')]
  const c = cs.find(x => x.tagName === 'CANVAS' && x.width > 200)
  if (!c) return { ok: false }
  const ctx = c.getContext('2d')
  const w = c.width, h = c.height
  const data = ctx.getImageData(0, 0, w, h).data
  let nonEmpty = 0
  for (let i = 3; i < data.length; i += 4 * 97) {
    if (data[i] > 8) nonEmpty++
  }
  return { ok: true, w, h, sampled: Math.floor(data.length / (4 * 97)), nonEmpty }
})()`

const before = await page.eval(canvasInk)
console.log('canvas ink before:', JSON.stringify(before))

// 新建会话（避免历史任务的去重记录干扰）
await page.eval(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === '新建对话')
  btn?.click(); return !!btn
})()`)
await sleep(2000)
const freshSession = await page.eval(`document.querySelectorAll('[role="status"]').length`)
console.log('new session traces:', freshSession)

// 提交
await page.eval(`(async () => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '一只橘猫坐在窗台上，午后暖光，胶片质感')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 300))
  ;[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'')==='发送')?.click()
  return true
})()`)

// 等待出图（最多 180s），并观察画布墨迹变化
// 从 Node 侧轮询：单次 eval 只做瞬时读取，避免页面内长等待撞上 CDP 求值上限
const probe = `(() => {
  const cs = [...document.querySelectorAll('.excalidraw__canvas')]
  const c = cs.find(x => x.tagName === 'CANVAS' && x.width > 200)
  let nonEmpty = -1
  if (c) {
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    nonEmpty = 0
    for (let i = 3; i < data.length; i += 4 * 97) if (data[i] > 8) nonEmpty++
  }
  return {
    media: document.querySelectorAll('[data-dock-media]').length,
    dock: !!document.querySelector('[aria-label="最近生成"]'),
    nonEmpty,
    status: [...document.querySelectorAll('[role="status"]')].length,
  }
})()`

let mediaSeenAt = -1
let last = null
const deadline = Date.now() + 200000
while (Date.now() < deadline) {
  last = await page.eval(probe)
  if (last.media > 0 && mediaSeenAt < 0) mediaSeenAt = Date.now()
  // 出图后再给自动落图与聚焦补间留 5s，然后看画布墨迹
  if (last.media > 0 && Date.now() - mediaSeenAt > 5000 && last.nonEmpty > 0) break
  await sleep(1500)
}
const result = { ...last, mediaWaited: mediaSeenAt > 0 ? Math.round((mediaSeenAt - (deadline - 200000)) / 1000) : -1 }
console.log('result:', JSON.stringify(result))

check('新会话出图后出现结果坞', result.dock === true, `media=${result.media}`)
const inkGrew = result.nonEmpty > (before.nonEmpty || 0) + 50
check('画布同步渲染了该图片（像素证据）', inkGrew,
  `画布非空采样 ${before.nonEmpty ?? '?'} → ${result.nonEmpty}`)

await page.shot('fresh-generation-canvas-sync')
console.log('')
console.log(`通过 ${PASS.length} / 失败 ${FAIL.length}`)
FAIL.forEach((f) => console.log(' -', f))
process.exitCode = FAIL.length ? 1 : 0
