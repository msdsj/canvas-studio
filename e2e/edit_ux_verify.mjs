#!/usr/bin/env node
/**
 * 图片编辑层交互回归验证（零依赖 CDP）。
 *
 * 覆盖本次修复的两个缺陷：
 *   A. 气泡遮挡新选区 —— 拖拽期间所有气泡/chip 必须瞬时隐藏（opacity=0），
 *      松手后只留新区域的展开气泡；
 *   B. 编辑内容丢失 —— 退出编辑 / 切换图片后再回来，选区与每区提示词必须原样恢复，
 *      且多图之间互不串扰。
 *
 * 前置：Chrome 以 --remote-debugging-port=9333 启动；前端 27180、后端 27181 已运行。
 * 用法：node e2e/edit_ux_verify.mjs
 */
import { setTimeout as sleep } from 'node:timers/promises'

const APP = process.env.APP || 'http://127.0.0.1:27180'
const CDP = process.env.CDP || 'http://127.0.0.1:9333'
const IMG_A = '/tmp/cs-edit-a.png'
const IMG_B = '/tmp/cs-edit-b.png'
const NAME_A = 'cs-edit-a'
const NAME_B = 'cs-edit-b'

const PASS = []
const FAIL = []
const CONSOLE_ERRORS = []

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
      if (msg.method === 'Runtime.exceptionThrown') {
        CONSOLE_ERRORS.push(msg.params?.exceptionDetails?.exception?.description ?? 'exception')
      }
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        CONSOLE_ERRORS.push(msg.params.entry.text)
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        CONSOLE_ERRORS.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
      }
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
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 30000)
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(
        `eval error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description || '')}`
      )
    }
    return res.result.value
  }

  async waitFor(expression, { timeout = 15000, label = expression } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        if (await this.eval(`Boolean(${expression})`)) return true
      } catch {
        /* 页面导航中，忽略 */
      }
      await sleep(200)
    }
    throw new Error(`waitFor 超时: ${label}`)
  }

  async center(selector, index = 0) {
    const pos = await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, left: r.left, top: r.top };
    })()`)
    if (!pos) throw new Error(`元素不存在: ${selector}[${index}]`)
    return pos
  }

  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  async click(selector, index = 0) {
    const { x, y } = await this.center(selector, index)
    await this.clickAt(x, y)
  }

  async clickText(text, { tag = '*' } = {}) {
    const pos = await this.eval(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const el = nodes.reverse().find(n => n.textContent && n.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!pos) throw new Error(`找不到可点击文本: ${text}`)
    await this.clickAt(pos.x, pos.y)
  }

  async typeInto(selector, text, index = 0) {
    const ok = await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return false;
      el.focus();
      return true;
    })()`)
    if (!ok) throw new Error(`聚焦失败: ${selector}[${index}]`)
    await this.send('Input.insertText', { text })
  }

  async drag(from, to, steps = 10, onMidway = null) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps
      const y = from.y + ((to.y - from.y) * i) / steps
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
      await sleep(16)
    }
    if (onMidway) await onMidway()
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
  }

  async pressKey(key, code, vk) {
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    })
    await this.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    })
  }

  async screenshot(path) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, Buffer.from(res.data, 'base64'))
    console.log(`📸 截图：${path}`)
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

/** 编辑层是否打开（编辑基准图只在编辑层里渲染） */
const EDIT_OPEN = `document.querySelector('img[alt="编辑基准"]')`

/** 读取所有气泡/chip 的数量、可见性与文本 */
const SURFACES = `(() => {
  const all = [...document.querySelectorAll('[data-edit-surface]')];
  const opacity = (n) => getComputedStyle(n).opacity;
  const bubbles = all.filter((n) => n.dataset.editSurface === 'bubble');
  const chips = all.filter((n) => n.dataset.editSurface === 'chip');
  return {
    total: all.length,
    bubbles: bubbles.length,
    chips: chips.length,
    visibleBubbles: bubbles.filter((n) => opacity(n) !== '0').length,
    visibleChips: chips.filter((n) => opacity(n) !== '0').length,
    visible: all.filter((n) => opacity(n) !== '0').length,
    values: bubbles.map((n) => n.querySelector('textarea')?.value ?? ''),
    chipTexts: chips.map((n) => n.textContent.trim()),
    toolbar: (document.body.innerText.match(/\\d+ 区域 · \\d+ 标注/) || [''])[0],
  };
})()`

async function main() {
  const target = await newTab('about:blank')
  const page = await connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Log.enable')
  await page.send('DOM.enable')
  // 桌面视口：headless 默认 800×600 会落到移动断点，左栏（含上传入口、图层列表）整个被隐藏
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  })

  let baseline = 0
  try {
    // ---------- 0. 登录 ----------
    // 注意：这个产品**没有登录页**（/login 只是重定向），唯一入口是全局登录弹窗。
    // 未登录可以先浏览，真正要写入时才拦。所以这里从首页点「进入工作室」，
    // 若弹出登录框就地登录，登录后再等画布挂载。
    const ensureAuth = async () => {
      const hasDialog = await page.eval(`Boolean(document.querySelector('input[type=email]'))`)
      if (!hasDialog) return false
      await page.typeInto('input[type=email]', 'admin@canvas.studio')
      await page.typeInto('input[type=password]', 'Admin@12345')
      await page.pressKey('Enter', 'Enter', 13)
      await page.waitFor(`!document.querySelector('input[type=email]')`, { label: '登录弹窗关闭', timeout: 20000 })
      return true
    }

    await page.send('Page.navigate', { url: `${APP}/workspace` })
    await page.waitFor(
      `location.pathname.startsWith('/workspace') || document.querySelector('input[type=email]')`,
      { label: '工作台或登录弹窗', timeout: 30000 }
    )

    const loggedIn = await ensureAuth()
    await page.waitFor(`location.pathname.startsWith('/workspace')`, { label: '进入工作台', timeout: 25000 })
    await page.waitFor(`document.querySelector('.excalidraw')`, { label: 'Excalidraw 挂载', timeout: 30000 })
    check('登录并进入画布', true, loggedIn ? '经登录弹窗' : '已有会话')

    const rows = `document.querySelectorAll('li > div[role="button"]').length`

    /** 图层面板是画布底部工具条上的弹出层，默认关闭——用之前必须先点开 */
    const openLayers = async () => {
      const already = await page.eval(rows)
      if (already > 0) return
      const pos = await page.eval(`(() => {
        const btn = [...document.querySelectorAll('button[aria-label]')]
          .find((b) => (b.getAttribute('aria-label') || '').includes('图层'));
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)
      if (!pos) throw new Error('找不到图层面板入口')
      await page.clickAt(pos.x, pos.y)
      await sleep(400)
    }

    const upload = async (file, prompt) => {
      const doc = await page.send('DOM.getDocument', { depth: -1 })
      const node = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
      if (!node.nodeId) throw new Error('未找到上传 input')
      await page.send('DOM.setFileInputFiles', { files: [file], nodeId: node.nodeId })
      await page.waitFor(`document.body.innerText.includes('常用预设')`, { label: '上传弹窗', timeout: 20000 })
      // 弹窗里的 textarea 必须限定在 dialog 内：页面底部还有对话输入框，直接选 textarea 会打错地方
      await page.typeInto('div[role="dialog"] textarea', prompt)
      await page.clickText('上传并加入画布', { tag: 'button' })
      await page.waitFor(`!document.body.innerText.includes('常用预设')`, { label: '弹窗关闭', timeout: 25000 })
    }

    const clickLayer = async (name) => {
      await openLayers()
      // 图层行有 data-layer-name（自定义名优先，图片缺省是「图片 N」），按它精确匹配
      const pos = await page.eval(`(() => {
        const row = [...document.querySelectorAll('[data-layer-name]')]
          .find((n) => (n.getAttribute('data-layer-name') || '').includes(${JSON.stringify(name)}));
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)
      if (!pos) throw new Error(`找不到图层：${name}`)
      await page.clickAt(pos.x, pos.y)
    }

    // ---------- 1. 上传两张测试图 ----------
    // 计数用文件名更稳：li > div[role=button] 会随弹层状态变化，图层行本身带名称
    const countOf = async (name) =>
      page.eval(`[...document.querySelectorAll('li')].filter((n) => (n.textContent || '').includes(${JSON.stringify(name)})).length`)
    await openLayers()
    await upload(IMG_A, '测试图 A')
    await openLayers()
    await page.waitFor(`[...document.querySelectorAll('li')].some((n) => (n.textContent || '').includes('${NAME_A}'))`, {
      label: '图层 A 出现',
      timeout: 25000,
    })
    await upload(IMG_B, '测试图 B')
    await openLayers()
    await page.waitFor(`[...document.querySelectorAll('li')].some((n) => (n.textContent || '').includes('${NAME_B}'))`, {
      label: '图层 B 出现',
      timeout: 25000,
    })
    baseline = 0
    check('两张测试图已加入画布', (await countOf(NAME_A)) > 0 && (await countOf(NAME_B)) > 0, `A=${await countOf(NAME_A)} B=${await countOf(NAME_B)}`)

    // ---------- 2. 进入图片 A 的编辑层，框选区域 1 并填写 ----------
    // 入口统一走「点画布上的图」：产品现状里单击图片才进编辑层，图层点击只做选中
    const canvasArea = await page.eval(`(() => {
      const r = document.querySelector('.excalidraw').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`)
    const clickCanvasImage = async (hint) => {
      // 画面上的图片可能有三种 DOM：Excalidraw 的 canvas 渲染、img 元素、或编辑层的基准图。
      // 用「点图层列表里的图片行」更稳：它走 onElementSelected → enterEdit，与真实用户一致。
      await openLayers()
      const info = await page.eval(`(() => {
        const all = [...document.querySelectorAll('[data-layer-name]')]
          .map((n) => n.getAttribute('data-layer-name') || '');
        return { all, count: all.length };
      })()`)
      const pos = await page.eval(`(() => {
        const rows = [...document.querySelectorAll('[data-layer-name]')];
        const row = rows[${hint}];
        if (!row) return null;
        const r = row.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`)
      if (!pos) throw new Error(`图层列表没有第 ${hint} 行，实际：${JSON.stringify(info)}`)
      await page.clickAt(pos.x, pos.y)
      await sleep(700)
      return pos
    }
    let imageHint = 0
    const openEdit = async (label) => {
      for (let i = 0; i < 4; i += 1) {
        if (await page.eval(`Boolean(${EDIT_OPEN})`)) return
        await clickCanvasImage(imageHint)
        await sleep(400)
      }
      throw new Error(`无法进入编辑层：${label}`)
    }
    await openEdit('A')
    await page.waitFor(EDIT_OPEN, { label: '编辑层打开（A）', timeout: 15000 })
    const rectA = await page.eval(`(() => {
      const r = document.querySelector('img[alt="编辑基准"]').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`)
    check('单击图层即进入编辑层', true, `图 ${Math.round(rectA.w)}×${Math.round(rectA.h)}`)

    await page.drag(
      { x: rectA.x + rectA.w * 0.15, y: rectA.y + rectA.h * 0.15 },
      { x: rectA.x + rectA.w * 0.45, y: rectA.y + rectA.h * 0.4 }
    )
    await page.waitFor(`document.querySelectorAll('[data-edit-surface="bubble"]').length === 1`, {
      label: '区域 1 气泡出现',
      timeout: 8000,
    })
    const TEXT1 = '把圈中的圆形换成一只橘猫'
    await page.typeInto('[data-edit-surface="bubble"] textarea', TEXT1)
    let s = await page.eval(SURFACES)
    check('框选后自动弹出气泡并已聚焦可输入', s.values[0] === TEXT1, `value="${s.values[0]}"`)

    // ---------- 3. 点图片内空白 → 气泡收起成 chip（内容保留） ----------
    await page.clickAt(rectA.x + rectA.w * 0.85, rectA.y + rectA.h * 0.12)
    await sleep(300)
    s = await page.eval(SURFACES)
    check(
      '完成输入后点空白：气泡立即收起为 chip',
      s.visibleBubbles === 0 && s.chips === 1,
      `可见气泡 ${s.visibleBubbles} / chip ${s.chips}`
    )
    check('chip 上保留已写内容', (s.chipTexts[0] || '').includes(TEXT1), `chip="${s.chipTexts[0]}"`)

    // ---------- 4. 点 chip 重新展开，内容不丢 ----------
    await page.click('[data-edit-surface="chip"]')
    await page.waitFor(`document.querySelectorAll('[data-edit-surface="bubble"]').length === 1`, {
      label: 'chip 重新展开',
      timeout: 6000,
    })
    s = await page.eval(SURFACES)
    check('点历史区域可重新展开且内容还在', s.values[0] === TEXT1, `value="${s.values[0]}"`)

    // ---------- 5. 核心缺陷 1：气泡不再遮挡新选区 ----------
    const bubbleBox = await page.center('[data-edit-surface="bubble"]')
    const dragFrom = { x: bubbleBox.left - 10, y: bubbleBox.y }
    const dragTo = { x: bubbleBox.left + 120, y: bubbleBox.y + 90 }
    let mid = null
    await page.drag(dragFrom, dragTo, 10, async () => {
      await sleep(120)
      mid = await page.eval(SURFACES)
    })
    check(
      '拖拽期间所有气泡/chip 瞬时隐藏（opacity=0）',
      Boolean(mid) && mid.visible === 0 && mid.total >= 1,
      mid ? `DOM ${mid.total} 个 / 可见 ${mid.visible} 个` : '未取到拖拽中快照'
    )
    await page.waitFor(`document.querySelectorAll('[data-edit-surface="bubble"]').length === 1`, {
      label: '区域 2 气泡出现',
      timeout: 8000,
    })
    await sleep(250)
    s = await page.eval(SURFACES)
    check(
      '松手后只展开新区域，旧区域收为 chip',
      s.visibleBubbles === 1 && s.chips === 1 && s.total === 2,
      `气泡 ${s.visibleBubbles} / chip ${s.chips} / 合计 ${s.total}`
    )
    check('工具条计数正确', (s.toolbar || '').includes('2 区域'), s.toolbar)

    // ---------- 6. 核心缺陷 2：退出再进入不丢内容 ----------
    const canvasBox = await page.eval(`(() => {
      const r = document.querySelector('.excalidraw').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`)
    await page.clickAt(canvasBox.x + 24, canvasBox.y + canvasBox.h - 24)
    await page.waitFor(`!${EDIT_OPEN}`, { label: '点图外退出编辑', timeout: 8000 })
    check('点图片外空白退出编辑', true)

    await clickLayer(NAME_A)
    await page.waitFor(EDIT_OPEN, { label: '重新进入编辑（A）', timeout: 15000 })
    await sleep(400)
    s = await page.eval(SURFACES)
    check(
      '重新进入后选区全部恢复（2 个）',
      s.total === 2 && s.chips === 2,
      `合计 ${s.total} / chip ${s.chips} / 气泡 ${s.bubbles}`
    )
    const restoredText = await page.eval(`(() => {
      const chips = [...document.querySelectorAll('[data-edit-surface="chip"]')];
      return chips.map((n) => n.textContent.trim()).join(' | ');
    })()`)
    check('恢复后提示词仍在', restoredText.includes(TEXT1), restoredText)
    const toastText = await page.eval(`document.body.innerText`)
    check('有「已恢复上次」的一次性提示', toastText.includes('已恢复上次'), 'toast 命中')

    // ---------- 7. 多图隔离 ----------
    await clickLayer(NAME_B)
    await page.waitFor(EDIT_OPEN, { label: '编辑层打开（B）', timeout: 15000 })
    await sleep(400)
    s = await page.eval(SURFACES)
    check('切到图片 B：不继承 A 的选区', s.total === 0, `B 上区域数 ${s.total}`)

    const rectB = await page.eval(`(() => {
      const r = document.querySelector('img[alt="编辑基准"]').getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`)
    await page.drag(
      { x: rectB.x + rectB.w * 0.55, y: rectB.y + rectB.h * 0.55 },
      { x: rectB.x + rectB.w * 0.8, y: rectB.y + rectB.h * 0.8 }
    )
    await page.waitFor(`document.querySelectorAll('[data-edit-surface="bubble"]').length === 1`, {
      label: 'B 的区域气泡',
      timeout: 8000,
    })
    const TEXTB = '把背景改成暖白色'
    await page.typeInto('[data-edit-surface="bubble"] textarea', TEXTB)
    s = await page.eval(SURFACES)
    check('图片 B 可独立框选并填写', s.values[0] === TEXTB, `value="${s.values[0]}"`)

    await clickLayer(NAME_A)
    await page.waitFor(EDIT_OPEN, { label: '回到图片 A', timeout: 15000 })
    await sleep(400)
    const backA = await page.eval(SURFACES)
    check(
      '切回图片 A：A 的 2 个区域与文字都还在',
      backA.total === 2 && backA.chipTexts.join(' ').includes(TEXT1),
      `合计 ${backA.total}`
    )

    await clickLayer(NAME_B)
    await page.waitFor(EDIT_OPEN, { label: '再回图片 B', timeout: 15000 })
    await sleep(400)
    const backB = await page.eval(SURFACES)
    check(
      '再切回图片 B：B 的 1 个区域与文字仍在',
      backB.total === 1 && backB.chipTexts.join(' ').includes(TEXTB),
      `合计 ${backB.total}`
    )

    // ---------- 8. Esc 两级语义 ----------
    await page.click('[data-edit-surface="chip"]')
    await page.waitFor(`document.querySelectorAll('[data-edit-surface="bubble"]').length === 1`, {
      label: 'B 气泡展开',
      timeout: 6000,
    })
    await page.pressKey('Escape', 'Escape', 27)
    await sleep(350)
    const afterEsc1 = await page.eval(SURFACES)
    const stillOpen = await page.eval(`Boolean(${EDIT_OPEN})`)
    check('第一次 Esc：只收气泡，编辑层仍在', afterEsc1.visibleBubbles === 0 && stillOpen, `编辑层 ${stillOpen}`)

    await page.pressKey('Escape', 'Escape', 27)
    await page.waitFor(`!${EDIT_OPEN}`, { label: '第二次 Esc 退出编辑', timeout: 6000 })
    check('第二次 Esc：退出编辑层', true)

    // ---------- 9. 无 error 级控制台日志 ----------
    check(
      '全程无 error 级控制台日志',
      CONSOLE_ERRORS.length === 0,
      CONSOLE_ERRORS.slice(0, 2).join(' / ')
    )
  } catch (error) {
    console.error('💥 用例中断：', error.message)
    if (CONSOLE_ERRORS.length) {
      console.error('🧯 控制台错误：')
      CONSOLE_ERRORS.slice(0, 6).forEach((item) => console.error(`   - ${item}`))
    }
    FAIL.push(`用例中断 — ${error.message}`)
    try {
      await page.screenshot('/tmp/cs-edit-ux-failure.png')
    } catch {
      /* 截图失败不影响结论 */
    }
  } finally {
    // 清理：删掉本次上传的两张测试图，避免污染用户画布
    try {
      for (const name of [NAME_A, NAME_B]) {
        const pos = await page.eval(`(() => {
          const row = [...document.querySelectorAll('li > div[role="button"]')]
            .find((n) => (n.textContent || '').includes(${JSON.stringify(name)}));
          if (!row) return null;
          const r = row.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`)
        if (!pos) continue
        await page.clickAt(pos.x, pos.y)
        await sleep(400)
        await page.pressKey('Escape', 'Escape', 27)
        await sleep(250)
        await page.pressKey('Delete', 'Delete', 46)
        await sleep(400)
      }
      const left = await page.eval(`document.querySelectorAll('li > div[role="button"]').length`)
      console.log(`🧹 清理后图层数：${left}（基线 ${baseline}）`)
    } catch (error) {
      console.log(`🧹 清理失败（不影响结论）：${error.message}`)
    }
    console.log(`\n===== 结果：${PASS.length} 通过 / ${FAIL.length} 失败 =====`)
    if (FAIL.length) FAIL.forEach((item) => console.log(`  ❌ ${item}`))
    process.exitCode = FAIL.length ? 1 : 0
    process.exit(FAIL.length ? 1 : 0)
  }
}

main().catch((error) => {
  console.error('启动失败：', error)
  process.exit(1)
})
