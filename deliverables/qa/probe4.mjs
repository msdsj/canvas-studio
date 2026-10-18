import { CDP, Session, APP, sleep } from './harness.mjs'

const log = (...a) => console.error(...a)

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.find((t) => t.type === 'page')
log('attach', target.id, target.url)
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
const page = new Session(ws)
await page.send('Page.enable')
await page.send('Page.bringToFront')

const t = (label) => {
  const s = Date.now()
  return { label, done: () => log(`${label}: ${Date.now() - s}ms`) }
}

let m = t('navigate login')
await page.goto(`${APP}/login`)
m.done()

m = t('eval 1+1')
log('eval result', await page.eval('1+1'))
m.done()

m = t('type email')
await page.typeInto('input[type=email]', 'admin@canvas.studio')
m.done()
m = t('type pass')
await page.typeInto('input[type=password]', 'Admin@12345')
m.done()
m = t('click login')
await page.clickText('登录', { tag: 'button' })
m.done()

m = t('wait workspace')
try {
  await page.waitFor(`location.pathname.startsWith('/workspace')`, { timeout: 40000, label: 'ws' })
  log('ok at', await page.eval('location.href'))
} catch (e) {
  log('wait ws failed', e.message)
}
m.done()

m = t('wait excalidraw')
try {
  await page.waitFor(`document.querySelector('.excalidraw')`, { timeout: 60000, label: 'excalidraw' })
  log('excalidraw ok')
} catch (e) {
  log('excalidraw failed', e.message)
}
m.done()

m = t('count elements')
log('layers', await page.eval(`document.querySelectorAll('[data-layer-id]').length`))
m.done()

await page.screenshot('probe-04-login-refresh.png')
ws.close()
process.exit(0)
