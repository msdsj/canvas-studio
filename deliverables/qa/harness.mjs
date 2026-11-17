/**
 * QA 复用的零依赖 CDP harness（Node 22 内置 WebSocket）。
 * 源自 e2e/ui_verify.mjs 的范式，补齐：网络监听、鼠标拖拽多步、视口切换、截图目录。
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { writeFile } from 'node:fs/promises'
import { appendFileSync as appendSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 同步落盘的进度日志：进程被强杀时也不会丢（stdout 管道/文件缓冲会丢）。 */
export const TRACE = '/tmp/qa-trace.log'
export function trace(...parts) {
  const line = `[${new Date().toISOString().slice(11, 23)}] ${parts.join(' ')}\n`
  try {
    appendSync(TRACE, line)
  } catch {
    /* ignore */
  }
  process.stdout.write(line)
}

export const APP = 'http://127.0.0.1:27180'
export const API = 'http://127.0.0.1:27181'
export const CDP = 'http://127.0.0.1:9222'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SHOTS = process.env.CS_SHOT_DIR || path.join(ROOT, 'deliverables/qa/shots')

export class Reporter {
  constructor() {
    this.rows = []
  }
  check(id, name, ok, detail = '') {
    this.rows.push({ id, name, ok, detail })
    trace(`${ok ? '✅ PASS' : '❌ FAIL'} [${id}] ${name}${detail ? ` — ${detail}` : ''}`)
    return ok
  }
  get passCount() {
    return this.rows.filter((r) => r.ok).length
  }
  get failCount() {
    return this.rows.filter((r) => !r.ok).length
  }
}

export async function newTab(url = 'about:blank') {
  const resp = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!resp.ok) throw new Error(`new tab failed: ${resp.status}`)
  return resp.json()
}

export class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    this.requests = []
    this.consoleErrors = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
        return
      }
      if (msg.method === 'Network.requestWillBeSent') {
        const r = msg.params.request
        this.requests.push({ url: r.url, method: r.method, postData: r.postData || '', type: msg.params.type })
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(
          msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300)
        )
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(`EXC ${msg.params.exceptionDetails.text}`)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 60000)
    })
  }

  async init() {
    await this.send('Page.enable')
    await this.send('Runtime.enable')
    await this.send('DOM.enable')
    await this.send('Network.enable')
    return this
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    })
    if (res.exceptionDetails) {
      throw new Error(
        `eval error: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`
      )
    }
    return res.result.value
  }

  async waitFor(expression, { timeout = 20000, label = expression } = {}) {
    const deadline = Date.now() + timeout
    let lastErr = ''
    while (Date.now() < deadline) {
      try {
        if (await this.eval(`Boolean(${expression})`)) return true
      } catch (e) {
        lastErr = String(e.message || e)
      }
      await sleep(250)
    }
    throw new Error(`waitFor 超时: ${label}${lastErr ? ` / ${lastErr}` : ''}`)
  }

  async goto(url) {
    // 新建的 tab 默认在后台会被 Chrome 冻结（Runtime.evaluate 直接超时），必须先置前再导航
    await this.send('Page.bringToFront').catch(() => {})
    await this.send('Page.navigate', { url })
    await sleep(800)
    await this.send('Page.bringToFront').catch(() => {})
  }

  async box(selector, index = 0) {
    return this.eval(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      const el = els[${index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width/2, cy: r.top + r.height/2 };
    })()`)
  }

  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(120)
  }

  async click(selector, index = 0) {
    const b = await this.box(selector, index)
    if (!b) throw new Error(`元素不存在: ${selector}[${index}]`)
    await this.clickAt(b.cx, b.cy)
  }

  /** 按可见文本精确点击（倒序，优先取最上层/最后的节点）。 */
  async clickText(text, { tag = '*', contains = false } = {}) {
    const pos = await this.eval(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const hit = (n) => {
        const t = (n.textContent || '').trim();
        const okText = ${contains ? `t.includes(${JSON.stringify(text)})` : `t === ${JSON.stringify(text)}`};
        if (!okText) return false;
        const r = n.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const st = getComputedStyle(n);
        return st.visibility !== 'hidden' && st.display !== 'none';
      };
      const el = nodes.reverse().find(hit);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!pos) throw new Error(`找不到可点击文本: ${text}`)
    await this.clickAt(pos.x, pos.y)
    return pos
  }

  /** 通过 aria-label / title 点击按钮。 */
  async clickAria(label) {
    const pos = await this.eval(`(() => {
      const el = [...document.querySelectorAll('[aria-label],[title]')].reverse()
        .find(n => (n.getAttribute('aria-label') || n.getAttribute('title')) === ${JSON.stringify(label)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!pos) throw new Error(`找不到元素: ${label}`)
    await this.clickAt(pos.x, pos.y)
    return pos
  }

  async typeInto(selector, text, index = 0) {
    const ok = await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return false;
      el.focus();
      el.select && el.select();
      return true;
    })()`)
    if (!ok) throw new Error(`输入框不存在: ${selector}[${index}]`)
    await this.send('Input.insertText', { text })
    await sleep(80)
  }

  /** 真实鼠标按下-移动-抬起（画笔/拖拽都需要中间 move 才能生成笔迹）。 */
  async drag(points, { steps = 10 } = {}) {
    const [from, ...rest] = points
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
    let prev = from
    const waypoints = rest.length ? rest : [from]
    for (const to of waypoints) {
      for (let i = 1; i <= steps; i += 1) {
        const x = prev.x + ((to.x - prev.x) * i) / steps
        const y = prev.y + ((to.y - prev.y) * i) / steps
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
        await sleep(12)
      }
      prev = to
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: prev.x, y: prev.y, button: 'left', buttons: 0, clickCount: 1 })
    await sleep(200)
  }

  async screenshot(name) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    const path = `${SHOTS}/${name}`
    await writeFile(path, Buffer.from(res.data, 'base64'))
    console.log(`📸 ${path}`)
    return path
  }

  async setViewport(width, height, mobile = false) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    })
    await sleep(400)
  }

  async clearViewport() {
    await this.send('Emulation.clearDeviceMetricsOverride')
    await sleep(300)
  }
}

export async function connect() {
  const target = await newTab('about:blank')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const session = new Session(ws)
  // 关键：新 tab 在后台会被冻结，先置前才能稳定执行 Runtime.evaluate
  await session.send('Page.enable').catch(() => {})
  await session.send('Page.bringToFront').catch(() => {})
  await sleep(500)
  return session
}

/**
 * 复用已存在的 page target（比 json/new 更可靠：新建的后台 tab 会被 Chrome 冻结，
 * 导致 Runtime.evaluate 直接超时）。优先挑已经在 27180 上的那个 tab。
 */
export async function connectExisting() {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  const target =
    pages.find((t) => t.url.includes('27180/workspace')) ||
    pages.find((t) => t.url.includes('27180')) ||
    pages[pages.length - 1]
  if (!target) throw new Error('没有可复用的 page target')
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  const session = new Session(ws)
  await session.send('Page.enable').catch(() => {})
  await session.send('Page.bringToFront').catch(() => {})
  await sleep(300)
  return session
}

/** 关掉多余的 tab，只保留当前这个，避免重复 tab 抢占焦点/内存。 */
export async function closeOtherTabs(keepUrlPart = '27180') {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  for (const t of list) {
    if (t.type !== 'page') continue
    if (t.url.includes(keepUrlPart)) continue
    await fetch(`${CDP}/json/close/${t.id}`).catch(() => {})
  }
}

/** 走真实 /api/auth/login 拿 JWT，再注入 localStorage（等价于 UI 登录后的状态）。 */
export async function authLogin({ email = 'admin@canvas.studio', password = 'Admin@12345' } = {}) {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const json = await res.json()
  const token = json?.data?.access_token
  if (!token) throw new Error(`登录失败: ${res.status} ${JSON.stringify(json).slice(0, 200)}`)
  return token
}

/**
 * 干净的会话准备：注入 token → 直接打开指定 URL。
 * 比「在登录页填表点击」稳定得多（表单登录已由 probe4 单独证明可用）。
 */
export async function login(page, { width = 1440, height = 900, url = `${APP}/workspace`, waitCanvas = true, canvasTimeout = 60000, token = null } = {}) {
  await page.setViewport(width, height)
  const jwt = token || (await authLogin())
  await page.goto(`${APP}/login`)
  await page.eval(`localStorage.clear(); sessionStorage.clear(); localStorage.setItem('cs.token', ${JSON.stringify(jwt)}); true`)
  await page.goto(url)
  await page.waitFor(`location.pathname.startsWith('/workspace')`, { label: '进入工作台', timeout: 40000 })
  if (waitCanvas) {
    await page.waitFor(`document.querySelector('.excalidraw')`, { label: 'Excalidraw 挂载', timeout: canvasTimeout })
  }
  await sleep(800)
  return jwt
}

/** Node 侧直接调后端（不经过页面），用于准备/校验数据。 */
export async function apiFetch(token, path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    method: init.method || 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body,
  })
  let body = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return { status: res.status, body }
}

/** 直接调用后端 API（用页面里 localStorage 的 cs.token），用于交叉验证 DB 状态。 */
export async function api(page, path, init = null) {
  return page.eval(`(async () => {
    const token = localStorage.getItem('cs.token');
    const res = await fetch('${API}' + ${JSON.stringify(path)}, ${
      init
        ? `{ method: ${JSON.stringify(init.method || 'GET')}, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: ${JSON.stringify(init.body || '')} }`
        : `{ headers: { Authorization: 'Bearer ' + token } }`
    });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    return { status: res.status, body };
  })()`)
}

/** 会话 → 画布 → 元素数组（画布真实内容，后端权威数据；走 Node 侧直连避免 CORS）。 */
export async function canvasOfSession(token, sessionId) {
  const s = await apiFetch(token, `/api/chat/sessions/${sessionId}`)
  const canvasId = s.body?.data?.canvas_id ?? null
  if (!canvasId) return { canvasId: null, elements: [], count: 0 }
  const c = await apiFetch(token, `/api/canvases/${canvasId}`)
  const state = c.body?.data?.state ?? {}
  const elements = Array.isArray(state?.elements) ? state.elements : []
  return { canvasId, elements, count: elements.length, state }
}

export function currentSessionId(page) {
  return page.eval(`new URLSearchParams(location.search).get('session')`)
}

/** 工作台就绪：Excalidraw 挂载 + 画布已从后端加载完（画布 id 出现在页面上）。 */
export async function appReady(page, { timeout = 45000 } = {}) {
  await page.waitFor(`document.querySelector('.excalidraw')`, { label: 'Excalidraw 挂载', timeout })
  // 等首屏数据（会话/画布/素材）都落地，避免随后的操作与首屏请求抢时序
  await sleep(3000)
}

/** Element Plus 风格的轮询等待 */
export async function pollUntil(fn, { timeout = 25000, interval = 500, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await sleep(interval)
  }
  throw new Error(`pollUntil 超时: ${label}`)
}

export { sleep }
