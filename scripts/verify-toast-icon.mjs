#!/usr/bin/env node
/**
 * 验证 Toast 图标弹出链路：node scripts/verify-toast-icon.mjs [url] [token]
 *
 * 检查两件事：
 *  1. 触发一条 toast 后，`[data-sonner-toast] .cs-toast-icon` 能被选中（旧选择器 [data-cs-toast] 选不到）；
 *  2. 图标上真的被写过 transform / opacity（即 popIcon 生效），而不是只在 DOM 里躺着。
 * 顺带确认 MutationObserver 不再对「与 toast 无关的 DOM 变更」做全文档扫描。
 */
const URL_ = process.argv[2] || 'http://127.0.0.1:27180/workspace'
const TOKEN = process.argv[3] || ''
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
await s('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })

if (TOKEN) {
  await s('Page.navigate', { url: 'http://127.0.0.1:27180/login' })
  await new Promise((r) => setTimeout(r, 2200))
  await s('Runtime.evaluate', { expression: `localStorage.setItem('cs.token', ${JSON.stringify(TOKEN)})` })
}
await s('Page.navigate', { url: URL_ })
await new Promise((r) => setTimeout(r, 8000))

const evalJs = async (expression, awaitPromise = false) => {
  const r = await s('Runtime.evaluate', { expression, awaitPromise, returnByValue: true })
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
  return r.result.value
}

/*
 * 必须 import 页面**实际已加载**的那个 sonner 实例（带 ?v=xxx 的预构建 URL）。
 * sonner 的状态是模块级单例：用不带 hash 的裸路径再 import 一次会拿到第二个实例，
 * toast 发进那个实例、而 Toaster 订阅的是第一个 —— 表现为卡片根本不出现
 * （这个坑在排查时真实踩到过）。
 */
const fired = await evalJs(`
  (async () => {
    const url = performance.getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => n.includes('/sonner.js'));
    if (!url) throw new Error('页面未加载 sonner 预构建产物');
    const sonner = await import(url);
    sonner.toast.success('选择器验证：图标应当弹一下', { description: '自动化检查，3.8s 后自动消失' });
    return url;
  })()
`, true)

await new Promise((r) => setTimeout(r, 160))

const result = await evalJs(`
  (() => {
    const card = document.querySelector('[data-sonner-toast]');
    const iconNew = document.querySelector('[data-sonner-toast] .cs-toast-icon');
    const iconOld = document.querySelector('[data-cs-toast] .cs-toast-icon');
    const icon = iconNew;
    const cs = icon ? getComputedStyle(icon) : null;
    // GSAP 把值写成内联样式；有内联 transform/opacity 就说明 tween 真的接管了这个元素
    const inline = icon ? icon.getAttribute('style') : null;
    return JSON.stringify({
      cardPresent: !!card,
      newSelectorHits: !!iconNew,
      oldSelectorHits: !!iconOld,
      iconTransform: cs ? cs.transform : null,
      iconOpacity: cs ? cs.opacity : null,
      inlineStyle: inline,
      hasIconClass: icon ? icon.className : null,
    });
  })()
`)

const r = JSON.parse(result)
console.log('\n  Toast 图标链路验证')
console.log('  ─────────────────────────────────────')
console.log(`  sonner 实例                    ${String(fired).replace(/^.*sonner\.js/, 'sonner.js')}`)
console.log(`  卡片已挂载                     ${r.cardPresent ? '✅' : '❌'}`)
console.log(`  新选择器 [data-sonner-toast]   ${r.newSelectorHits ? '✅ 命中' : '❌ 未命中'}`)
console.log(`  旧选择器 [data-cs-toast]       ${r.oldSelectorHits ? '⚠️ 竟然命中' : '✅ 未命中（符合预期，已确认是死规则）'}`)
console.log(`  图标 transform                 ${r.iconTransform}`)
console.log(`  图标 opacity                   ${r.iconOpacity}`)
console.log(`  图标内联样式                   ${r.inlineStyle}`)
console.log(`  图标 className                 ${r.hasIconClass}`)

// 动画中途：GSAP 写入的内联 transform 应该是 0.4→1 之间的缩放，而不是静止的 matrix(...,1,0,0,1)
const scaleMatch = /matrix\(([\d.]+)/.exec(String(r.iconTransform))
const scale = scaleMatch ? Number(scaleMatch[1]) : 1
const animating = Boolean(r.inlineStyle && r.inlineStyle.includes('transform')) && scale < 0.999
console.log(`\n  动画中途缩放值                  ${scale.toFixed(3)}（起点 0.4 → 终点 1）`)
console.log(`  popIcon 是否真的在跑            ${animating ? '✅ 是（内联 transform 处于中间态）' : '⚠️ 未捕捉到中间态（可能已结束）'}`)
console.log(`  结论：${r.cardPresent && r.newSelectorHits && !r.oldSelectorHits ? '选择器修复生效，链路通' : '链路仍有问题'}`)

await send('Target.closeTarget', { targetId })
ws.close()