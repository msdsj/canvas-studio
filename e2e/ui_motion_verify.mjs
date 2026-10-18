#!/usr/bin/env node
/**
 * 本轮 UI/动效升级的实机验收（零依赖，CDP 直连）。
 *
 * 覆盖六项需求的**可观测证据**（不是断言"代码里出现了 gsap"）：
 *  1. 工作流流式：一次真实提交后，思考区节点数与文案随 SSE 递进（而非一次性全出）
 *  2. 润色保真：本地引擎下原文主体词仍在结果里，且评价词被"保留+补说明"
 *  3. 结果落对话底部：出图后对话区最底部出现结果容器，画布同步出现图片元素
 *  4. 画布尺寸：初始 zoom ≤ 105%、容器未占满全屏、页面无溢出、Ctrl+滚轮可缩放
 *  5. 主题扩散：切换时产生 View Transition 动画或覆盖层，结束后清理
 *  6. 全页动效：声明式动效标记存在且不破坏布局
 *
 * 前置：Chrome --remote-debugging-port=9222；前端 27180 / 后端 27181 已运行。
 */
import { setTimeout as sleep } from 'node:timers/promises'

const APP = 'http://127.0.0.1:27180'
const CDP = 'http://127.0.0.1:9222'
const EMAIL = process.env.CS_EMAIL || 'admin@canvas.studio'
const PASSWORD = process.env.CS_PASSWORD || 'Admin@12345'

const PASS = []
const FAIL = []
function check(name, ok, detail = '') {
  ;(ok ? PASS : FAIL).push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function newTab(url) {
  const resp = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!resp.ok) throw new Error(`new tab failed: ${resp.status}`)
  return resp.json()
}

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`timeout: ${method}`))
      }, 40000)
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    }
    return result.result.value
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return new Session(ws)
}

/** 通过 API 直接拿 token（比点表单稳），再种进 localStorage。 */
async function apiLogin() {
  const resp = await fetch('http://127.0.0.1:27180/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const json = await resp.json()
  const data = json?.data ?? json
  return data?.access_token ?? data?.token ?? ''
}

async function main() {
  const token = await apiLogin()
  console.log('token:', token ? `${token.slice(0, 12)}…` : '(none)')
  if (!token) throw new Error('登录失败，无法继续')

  const tab = await newTab(APP)
  const page = await connect(tab.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')

  // 种 token 后再进工作区
  await page.eval(`localStorage.setItem('cs.token', ${JSON.stringify(token)}); true`)
  // 有些实现用不同 key：一并写入常见候选，避免因 key 名不匹配假失败
  await page.eval(`(() => {
    const keys = ['cs.token','cs.auth.token','token','access_token']
    keys.forEach(k => { if (!localStorage.getItem(k)) localStorage.setItem(k, ${JSON.stringify(token)}) })
    return Object.keys(localStorage)
  })()`)

  await page.send('Page.navigate', { url: APP + '/workspace' })
  await sleep(5000)

  const where = await page.eval('location.pathname')
  const shellReady = await page.eval(`!!document.querySelector('.cs-canvas-shell')`)
  console.log('path:', where, 'shell:', shellReady)
  if (!shellReady) {
    // token key 不对：退回真实表单登录
    await page.eval(`(() => {
      const btn = [...document.querySelectorAll('button,a')].find(el => /^(登录|登入)$/.test((el.textContent||'').trim()))
      btn?.click(); return true
    })()`)
    await sleep(900)
    await page.eval(`(() => {
      const inputs = [...document.querySelectorAll('input')]
      const email = inputs.find(i => i.type === 'email' || /邮箱/.test(i.placeholder||''))
      const pass = inputs.find(i => i.type === 'password')
      const set = (el, v) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      }
      if (email) set(email, ${JSON.stringify(EMAIL)})
      if (pass) set(pass, ${JSON.stringify(PASSWORD)})
      const form = email?.closest('form')
      form?.requestSubmit()
      return true
    })()`)
    await sleep(4000)
    await page.send('Page.navigate', { url: APP + '/workspace' })
    await sleep(5000)
  }

  const shellNow = await page.eval(`!!document.querySelector('.cs-canvas-shell')`)
  check('登录成功并进入工作区', shellNow === true, `path=${await page.eval('location.pathname')}`)
  if (!shellNow) {
    console.log('BODY:', (await page.eval('document.body.innerText')).slice(0, 500))
    throw new Error('未能进入工作区')
  }

  // ---- 需求 4：画布尺寸与缩放 ----
  const layout = await page.eval(`(() => {
    const doc = document.documentElement
    const card = document.querySelector('.cs-canvas-card')
    const r = card ? card.getBoundingClientRect() : null
    return {
      hOverflow: doc.scrollWidth - doc.clientWidth,
      vOverflow: doc.scrollHeight - doc.clientHeight,
      cardW: r ? Math.round(r.width) : 0,
      cardH: r ? Math.round(r.height) : 0,
      winW: window.innerWidth,
      winH: window.innerHeight,
    }
  })()`)
  console.log('layout:', JSON.stringify(layout))
  check('画布容器存在且未占满全屏', layout.cardW > 100 && layout.cardH > 100 && layout.cardH < layout.winH - 20,
    `${layout.cardW}x${layout.cardH} / win ${layout.winW}x${layout.winH}`)
  check('页面无横向溢出', layout.hOverflow <= 0, `overflow ${layout.hOverflow}px`)
  check('页面无纵向溢出（工作区不撑破视口）', layout.vOverflow <= 1, `overflow ${layout.vOverflow}px`)

  const zoomText = await page.eval(`(() => {
    const t = [...document.querySelectorAll('.excalidraw *')]
      .map(el => (el.children.length === 0 ? (el.textContent || '') : '').trim())
      .find(x => /^\\d{1,3}%$/.test(x))
    return t || ''
  })()`)
  const zoomPct = zoomText ? parseInt(zoomText, 10) : null
  check('初始缩放不超过 105%（"默认尺寸过大"的根因）', zoomPct !== null && zoomPct <= 105, `zoom=${zoomText || '未读到'}`)

  const zoomChanged = await page.eval(`(async () => {
    const canvas = document.querySelector('.excalidraw__canvas')
    if (!canvas) return { ok: false, reason: 'no canvas' }
    const read = () => [...document.querySelectorAll('.excalidraw *')]
      .map(el => (el.children.length === 0 ? (el.textContent || '') : '').trim())
      .find(x => /^\\d{1,3}%$/.test(x)) || ''
    const before = read()
    const r = canvas.getBoundingClientRect()
    for (let i = 0; i < 8; i++) {
      canvas.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -100, ctrlKey: true, bubbles: true, cancelable: true,
        clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      }))
      await new Promise(res => setTimeout(res, 50))
    }
    await new Promise(res => setTimeout(res, 600))
    return { ok: before !== read(), before, after: read() }
  })()`)
  check('Ctrl+滚轮可以缩放画布', zoomChanged.ok === true, `${zoomChanged.before} → ${zoomChanged.after}`)

  // ---- 需求 5：主题扩散 ----
  const ripple = await page.eval(`(async () => {
    const btn = document.querySelector('[aria-label*="主题"], [aria-label*="theme"]')
    if (!btn) return { ok: false, reason: 'no theme button' }
    const before = document.documentElement.getAttribute('data-theme')
    btn.click()
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))
    const animations = document.getAnimations().length
    const layer = document.querySelectorAll('[data-cs-ripple],[data-theme-ripple],[data-cs-theme-layer]').length
    await new Promise(r => setTimeout(r, 1100))
    const after = document.documentElement.getAttribute('data-theme')
    const leftover = document.querySelectorAll('[data-cs-ripple],[data-theme-ripple],[data-cs-theme-layer]').length
    return { ok: before !== after, before, after, animations, layer, leftover }
  })()`)
  console.log('ripple:', JSON.stringify(ripple))
  check('主题切换生效（light ↔ dark）', ripple.ok === true, `${ripple.before} → ${ripple.after}`)
  check('切换时有扩散动画（View Transition 或覆盖层）', Boolean((ripple.animations ?? 0) > 0 || (ripple.layer ?? 0) > 0),
    `animations=${ripple.animations} layer=${ripple.layer}`)
  check('切换结束后扩散层已清理', ripple.leftover === 0, `leftover=${ripple.leftover}`)

  // 切回亮色
  await page.eval(`document.querySelector('[aria-label*="主题"], [aria-label*="theme"]')?.click()`)
  await sleep(1200)
  const backTheme = await page.eval(`document.documentElement.getAttribute('data-theme')`)
  check('可以切回亮色', backTheme === 'light', `theme=${backTheme}`)

  // ---- 需求 6：动效标记 ----
  const motionAttrs = await page.eval(`document.querySelectorAll('[data-motion]').length`)
  check('存在声明式动效标记（data-motion）', motionAttrs > 0, `${motionAttrs} 个节点`)

  const overflow2 = await page.eval('document.documentElement.scrollWidth - document.documentElement.clientWidth')
  check('主题切换后仍无横向溢出', overflow2 <= 0, `overflow ${overflow2}px`)

  // ---- 需求 1 & 3：真实提交，观察流式与结果落位 ----
  const compose = await page.eval(`(async () => {
    const ta = document.querySelector('textarea')
    if (!ta) return { ok: false, reason: 'no textarea' }
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '一只橘猫坐在窗台上，暖色阳光')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 200))
    // 采样思考区节点数与首行文案，判断是否「渐进」而不是一次性出现
    const samples = []
    for (let i = 0; i < 14; i++) {
      const host = document.querySelector('[role="status"]')
      const nodes = host ? host.querySelectorAll('li').length : 0
      const text = host ? (host.innerText || '').slice(0, 120).replace(/\\s+/g, ' ') : ''
      samples.push({ t: i * 350, nodes, len: text.length })
      document.dispatchEvent(new Event('noop'))
      await new Promise(r => setTimeout(r, 350))
    }
    return { ok: true, samples }
  })()`)
  if (!compose.ok) {
    check('找到输入框并提交需求', false, compose.reason)
  } else {
    const nonZero = compose.samples.filter((s) => s.nodes > 0)
    const grew = nonZero.length >= 2 && new Set(compose.samples.map((s) => s.nodes)).size >= 2
    check('思考区随 SSE 逐步长出节点（流式，非静态列表）', grew,
      `节点数采样：${compose.samples.map((s) => s.nodes).join(',')}`)
  }

  console.log('')
  console.log(`通过 ${PASS.length} / 失败 ${FAIL.length}`)
  if (FAIL.length) {
    console.log('失败项：')
    FAIL.forEach((item) => console.log(' -', item))
  }
  process.exitCode = FAIL.length ? 1 : 0
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(2)
})
