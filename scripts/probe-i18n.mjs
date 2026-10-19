#!/usr/bin/env node
/** 探查页面里 i18n 的实际运行状态：node scripts/probe-i18n.mjs <url> <token> */
const URL_ = process.argv[2] || 'http://127.0.0.1:27180/'
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

if (TOKEN) {
  await s('Page.navigate', { url: 'http://127.0.0.1:27180/login' })
  await new Promise((r) => setTimeout(r, 2000))
  await s('Runtime.evaluate', {
    expression: `localStorage.setItem('cs.token', ${JSON.stringify(TOKEN)})`,
  })
}
await s('Page.navigate', { url: URL_ })
await new Promise((r) => setTimeout(r, 8000))

const probe = await s('Runtime.evaluate', {
  expression: `(async () => {
    const mod = await import('/src/i18n/index.ts')
    const i18n = mod.default
    const store = i18n.store?.data ?? {}
    return {
      isInitialized: i18n.isInitialized,
      language: i18n.language,
      resolved: i18n.resolvedLanguage,
      languages: i18n.languages,
      storeLangs: Object.keys(store),
      zhNamespaces: Object.keys(store['zh-CN'] ?? {}),
      enNamespaces: Object.keys(store['en'] ?? {}),
      probeKey: i18n.t('suggestions.items', { ns: 'home', returnObjects: true }),
      probeType: typeof i18n.t('suggestions.items', { ns: 'home', returnObjects: true }),
    }
  })()`,
  awaitPromise: true,
  returnByValue: true,
})
console.log(JSON.stringify(probe.result.value, null, 2))

await send('Target.closeTarget', { targetId })
ws.close()
