#!/usr/bin/env node
/**
 * 六项需求的实机验收（v2，修正探针）。
 *
 * v1 的两次误判都源于探针而非产品：
 *  - 主题：起始态是 dark（上一轮遗留），断言却写死 light；
 *  - 流式：用 Enter 提交没触发发送，采样到的是**上一条已完成消息**的折叠摘要（li 数为 0）。
 * v2 改成点真实发送键（aria-label="发送"）、只采样最后一条 role=status、并用
 * data-dock-media / aria-label="最近生成" 校验结果落位。
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
      }, 90000)
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
    return result.result.value
  }
}

async function main() {
  const login = await fetch('http://127.0.0.1:27180/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  }).then((r) => r.json())
  const token = login?.data?.access_token
  if (!token) throw new Error('登录失败')

  const tab = await fetch(`${CDP}/json/new?${encodeURIComponent(APP)}`, { method: 'PUT' }).then((r) => r.json())
  const ws = new WebSocket(tab.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', rej, { once: true })
  })
  const page = new Session(ws)
  await page.send('Page.enable')
  await page.send('Runtime.enable')

  await page.eval(`(() => {
    window.__csErrors = []
    window.addEventListener('error', e => window.__csErrors.push(String(e.message)))
    window.addEventListener('unhandledrejection', e => window.__csErrors.push(String(e.reason)))
    return true
  })()`)

  await page.eval(`localStorage.setItem('cs.token', ${JSON.stringify(token)}); true`)
  await page.send('Page.navigate', { url: APP + '/workspace' })
  await sleep(6000)

  // ================= 需求 4：画布尺寸 / 缩放 =================
  const layout = await page.eval(`(() => {
    const doc = document.documentElement
    const card = document.querySelector('.cs-canvas-card')
    const r = card ? card.getBoundingClientRect() : null
    return {
      hOverflow: doc.scrollWidth - doc.clientWidth,
      vOverflow: doc.scrollHeight - doc.clientHeight,
      cardW: r ? Math.round(r.width) : 0,
      cardH: r ? Math.round(r.height) : 0,
      winW: window.innerWidth, winH: window.innerHeight,
    }
  })()`)
  console.log('layout:', JSON.stringify(layout))
  check('画布容器未占满全屏', layout.cardH > 100 && layout.cardH < layout.winH - 20, `${layout.cardW}x${layout.cardH} / win ${layout.winW}x${layout.winH}`)
  check('页面无横向溢出', layout.hOverflow <= 0, `${layout.hOverflow}px`)
  check('页面无纵向溢出', layout.vOverflow <= 1, `${layout.vOverflow}px`)

  const readZoom = `(() => {
    const t = [...document.querySelectorAll('.excalidraw *')]
      .map(el => (el.children.length === 0 ? (el.textContent || '') : '').trim())
      .find(x => /^\\d{1,3}%$/.test(x))
    return t || ''
  })()`
  const zoom0 = await page.eval(readZoom)
  check('初始缩放 ≤ 105%', Boolean(zoom0) && parseInt(zoom0, 10) <= 105, `zoom=${zoom0 || '未读到'}`)

  const zoomTest = await page.eval(`(async () => {
    const canvas = document.querySelector('.excalidraw__canvas')
    const read = () => {
      const t = [...document.querySelectorAll('.excalidraw *')]
        .map(el => (el.children.length === 0 ? (el.textContent || '') : '').trim())
        .find(x => /^\\d{1,3}%$/.test(x))
      return t || ''
    }
    const before = read()
    const r = canvas.getBoundingClientRect()
    const fire = (dy) => canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: dy, ctrlKey: true, bubbles: true, cancelable: true,
      clientX: r.left + r.width/2, clientY: r.top + r.height/2 }))
    for (let i = 0; i < 6; i++) { fire(-100); await new Promise(res => setTimeout(res, 60)) }
    await new Promise(res => setTimeout(res, 500))
    const after = read()
    for (let i = 0; i < 6; i++) { fire(100); await new Promise(res => setTimeout(res, 60)) }
    await new Promise(res => setTimeout(res, 500))
    return { before, after, restored: read() }
  })()`)
  check('Ctrl+滚轮可缩放画布', zoomTest.before !== zoomTest.after, `${zoomTest.before} → ${zoomTest.after} → ${zoomTest.restored}`)

  // ================= 需求 5：主题扩散 =================
  const theme = await page.eval(`(async () => {
    const btn = document.querySelector('[aria-label*="主题"]')
    const before = document.documentElement.getAttribute('data-theme')
    const bgBefore = getComputedStyle(document.body).backgroundColor
    const t0 = performance.now()
    btn.click()
    let peakAnim = 0, layerSeen = false, flippedAt = -1
    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 40))
      peakAnim = Math.max(peakAnim, document.getAnimations().length)
      if (document.querySelectorAll('[data-cs-ripple],[data-theme-ripple],[data-cs-theme-layer],[data-cs-vt]').length > 0) layerSeen = true
      if (document.documentElement.getAttribute('data-theme') !== before && flippedAt < 0) {
        flippedAt = Math.round(performance.now() - t0)
      }
    }
    await new Promise(r => setTimeout(r, 900))
    return {
      before, after: document.documentElement.getAttribute('data-theme'),
      bgBefore, bgAfter: getComputedStyle(document.body).backgroundColor,
      peakAnim, layerSeen, flippedAt,
      leftover: document.querySelectorAll('[data-cs-ripple],[data-theme-ripple],[data-cs-theme-layer]').length,
    }
  })()`)
  console.log('theme:', JSON.stringify(theme))
  check('主题确实翻转', theme.before !== theme.after, `${theme.before} → ${theme.after}`)
  check('底色随主题改变', theme.bgBefore !== theme.bgAfter, `${theme.bgBefore} → ${theme.bgAfter}`)
  check('切换不是瞬时全局变色（有动画过程）', theme.peakAnim > 0 || theme.layerSeen, `peakAnimations=${theme.peakAnim} layer=${theme.layerSeen} flippedAt=${theme.flippedAt}ms`)
  check('扩散结束后无残留层', theme.leftover === 0, `leftover=${theme.leftover}`)

  const back = await page.eval(`(async () => {
    const cur = document.documentElement.getAttribute('data-theme')
    if (cur !== 'light') {
      document.querySelector('[aria-label*="主题"]').click()
      await new Promise(r => setTimeout(r, 1800))
    }
    return { theme: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor }
  })()`)
  check('可切回亮色主题', back.theme === 'light', `theme=${back.theme} bg=${back.bg}`)

  const motionAttrs = await page.eval(`document.querySelectorAll('[data-motion]').length`)
  check('声明式动效标记存在', motionAttrs > 0, `${motionAttrs} 个节点`)

  // ================= 需求 1：工作流流式 =================
  const stream = await page.eval(`(async () => {
    const ta = document.querySelector('textarea')
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(ta, '帮我画一张极简咖啡品牌海报，暖砂纸质感')
    ta.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 300))
    const sendBtn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'') === '发送')
    if (!sendBtn) return { ok: false, reason: '找不到发送键' }
    const countBefore = document.querySelectorAll('[role="status"]').length
    sendBtn.click()
    const samples = []
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500))
      const traces = document.querySelectorAll('[role="status"]')
      const last = traces[traces.length - 1]
      const isNew = traces.length > countBefore
      samples.push({
        t: (i + 1) * 500,
        count: traces.length,
        isNew,
        lis: last && isNew ? last.querySelectorAll('li').length : 0,
        chars: last && isNew ? (last.innerText || '').replace(/\\s+/g, '').length : 0,
        head: last && isNew ? (last.innerText || '').replace(/\\s+/g, ' ').slice(0, 60) : '',
      })
    }
    return { ok: true, samples }
  })()`)

  if (!stream.ok) {
    check('提交需求', false, stream.reason)
  } else {
    const s = stream.samples
    console.log('lis   :', s.map((x) => x.lis).join(','))
    console.log('chars :', s.map((x) => x.chars).join(','))
    const heads = [...new Set(s.map((x) => x.head).filter(Boolean))]
    console.log('heads :', heads.slice(0, 4).join(' || '))
    const newTrace = s.some((x) => x.isNew)
    check('提交后出现新的思考区', newTrace, newTrace ? '' : '窗口内未出现新 role=status')
    const lisSeq = s.map((x) => x.lis)
    const distinctLis = new Set(lisSeq.filter((n) => n > 0))
    check('思考步骤逐步长出（流式，非静态列表）', distinctLis.size >= 2, `节点数档位=${distinctLis.size}，序列=${lisSeq.join(',')}`)
    const charSeq = s.map((x) => x.chars).filter((c) => c > 0)
    check('思考文字随流式增长', new Set(charSeq).size >= 2, `字符数档位=${new Set(charSeq).size}`)
  }

  // ================= 需求 3：结果落对话底部 + 画布同步 =================
  const done = await page.eval(`(async () => {
    const deadline = Date.now() + 150000
    while (Date.now() < deadline) {
      const dock = document.querySelector('[aria-label="最近生成"]')
      const media = document.querySelectorAll('[data-dock-media]').length
      if (dock && media > 0) return { ok: true, media, waited: 150000 - (deadline - Date.now()) }
      await new Promise(r => setTimeout(r, 1500))
    }
    return { ok: false }
  })()`)
  check('出图后对话区底部出现「最近生成」结果坞', done.ok === true, done.ok ? `${done.media} 张，等待 ${Math.round(done.waited / 1000)}s` : '150s 内未出现')

  if (done.ok) {
    const pos = await page.eval(`(() => {
      const dock = document.querySelector('[aria-label="最近生成"]')
      const dr = dock.getBoundingClientRect()
      let node = dock.parentElement, scroller = null
      while (node) {
        const st = getComputedStyle(node)
        if (/(auto|scroll)/.test(st.overflowY) && node.scrollHeight > node.clientHeight + 4) { scroller = node; break }
        node = node.parentElement
      }
      const sr = scroller ? scroller.getBoundingClientRect() : null
      return {
        dockBottom: Math.round(dr.bottom),
        scrollerBottom: sr ? Math.round(sr.bottom) : null,
        gap: sr ? Math.round(sr.bottom - dr.bottom) : null,
      }
    })()`)
    console.log('dockPos:', JSON.stringify(pos))
    check('结果坞位于对话区底部', pos.gap !== null && pos.gap >= -8 && pos.gap < 140, `距滚动区底 ${pos.gap}px`)

    const assets = await page.eval(`(() => {
      const statics = [...document.querySelectorAll('img')].filter(i => /\\/static\\//.test(i.src))
      return { count: statics.length, sample: statics.slice(0, 3).map(i => i.src.split('/').pop()) }
    })()`)
    console.log('assets:', JSON.stringify(assets))
    check('生成结果图片已渲染', assets.count > 0, `${assets.count} 个图片节点`)
  }

  const runtimeErrors = await page.eval('window.__csErrors || []')
  check('无未捕获运行时错误', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | ') || '0 条')

  console.log('')
  console.log(`通过 ${PASS.length} / 失败 ${FAIL.length}`)
  if (FAIL.length) {
    console.log('失败项：')
    FAIL.forEach((i) => console.log(' -', i))
  }
  process.exitCode = FAIL.length ? 1 : 0
}

main().catch((e) => {
  console.error('FATAL', e)
  process.exit(2)
})
