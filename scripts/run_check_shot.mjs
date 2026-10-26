#!/usr/bin/env node
/**
 * 运行态取证：打开首页 / 工作台，截图并抓控制台报错。
 * 只读：不写画布、不提交生成任务。
 *
 * 用法：node scripts/run_check_shot.mjs [outDir]
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { mkdirSync, writeFileSync } from 'node:fs'

const APP = process.env.APP_URL || 'http://127.0.0.1:27180'
const CDP = process.env.CDP_URL || 'http://127.0.0.1:9222'
const OUT = process.argv[2] || '/Users/meishiduoshuijiao/Desktop/canvas-studio/deliverables/run-check'
mkdirSync(OUT, { recursive: true })

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.logs = []
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data)
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id)
        this.pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
        return
      }
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
        this.logs.push(`${m.params.type}: ` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
      }
      if (m.method === 'Runtime.exceptionThrown') {
        this.logs.push('exception: ' + (m.params.exceptionDetails?.exception?.description || ''))
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)) }, 60000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    const file = `${OUT}/${name}.png`
    writeFileSync(file, Buffer.from(data, 'base64'))
    return file
  }
}

const targets = await (await fetch(`${CDP}/json/list`)).json()
const page = targets.find((t) => t.type === 'page')
if (!page) throw new Error('没有可用的 page target')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
const s = new Session(ws)
await s.send('Page.enable')
await s.send('Runtime.enable')
await s.send('Emulation.setDeviceMetricsOverride', {
  width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
})

const report = {}
for (const [name, path] of [['home', '/'], ['workspace', '/workspace'], ['projects', '/projects']]) {
  await s.send('Page.navigate', { url: APP + path })
  await sleep(4200)
  report[name] = {
    url: await s.eval('location.href'),
    title: await s.eval('document.title'),
    h1: await s.eval('(document.querySelector("h1")||{}).innerText || ""'),
    bodyLen: await s.eval('document.body.innerText.length'),
    shot: await s.shot(name),
  }
}
report.console = s.logs.slice(-30)
writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
ws.close()
