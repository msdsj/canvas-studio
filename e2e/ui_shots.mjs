#!/usr/bin/env node
/**
 * 视觉取证：出图后截图（亮色 / 暗色各一张），并校验结果坞在 DOM 顺序上位于消息流之后。
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
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`timeout ${method}`)) }, 90000)
    })
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  async shot(name) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, 'base64'))
    console.log('shot:', `${OUT}/${name}.png`)
  }
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

await page.eval(`localStorage.setItem('cs.token', ${JSON.stringify(token)}); true`)
await page.send('Page.navigate', { url: APP + '/workspace' })
await sleep(6500)
await page.eval(`localStorage.setItem('cs.theme','light'); document.documentElement.setAttribute('data-theme','light'); true`)
await sleep(600)

// 已有历史会话时应直接看到结果坞；没有则提交一次
const hasDock = await page.eval(`!!document.querySelector('[aria-label="最近生成"]')`)
if (!hasDock) {
  await page.eval(`(async () => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '帮我画一张极简咖啡品牌海报，暖砂纸质感')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 300))
    ;[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'')==='发送')?.click()
    return true
  })()`)
  await page.eval(`(async () => {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      if (document.querySelector('[aria-label="最近生成"]') && document.querySelectorAll('[data-dock-media]').length) return true
      await new Promise(r => setTimeout(r, 1500))
    }
    return false
  })()`)
}

// DOM 顺序：结果坞必须是消息流之后的下一个区块
const order = await page.eval(`(() => {
  const dock = document.querySelector('[aria-label="最近生成"]')
  if (!dock) return { found: false }
  const panel = dock.closest('[data-chat-panel]') || dock.parentElement.parentElement
  const kids = [...panel.children].map(el => ({
    tag: el.tagName.toLowerCase(),
    cls: (el.className || '').toString().slice(0, 40),
    hasDock: el.contains(dock),
  }))
  const idx = kids.findIndex(k => k.hasDock)
  return { found: true, index: idx, total: kids.length, kids }
})()`)
console.log('dockOrder:', JSON.stringify(order, null, 1))

await page.shot('workspace-light-result')

// 暗色 + 扩散后的终态
await page.eval(`(async () => {
  const btn = document.querySelector('[aria-label*="主题"]')
  btn.click()
  await new Promise(r => setTimeout(r, 1400))
  return document.documentElement.getAttribute('data-theme')
})()`)
await sleep(600)
await page.shot('workspace-dark-result')

// 扩散中间帧（再次切换，180ms 时抓）
await page.eval(`(async () => {
  document.querySelector('[aria-label*="主题"]').click()
  await new Promise(r => setTimeout(r, 180))
  return true
})()`)
await page.shot('theme-ripple-midframe')
await sleep(1500)

// 流式中间帧：新提交后 2.2s 抓
await page.eval(`(async () => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '一张未来感音乐节主视觉，荧光青柠与墨黑')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 250))
  ;[...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'')==='发送')?.click()
  await new Promise(r => setTimeout(r, 2200))
  return true
})()`)
await page.shot('workflow-streaming-midframe')

console.log('done')
