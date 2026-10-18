import { CDP, Session, sleep } from './harness.mjs'

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && t.url.includes('27180')) || list.find((t) => t.type === 'page')
console.log('attach:', target.id, target.url)

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
const page = new Session(ws)
await page.send('Page.enable')
await page.send('Runtime.enable')
await page.send('Page.bringToFront')

for (let i = 0; i < 40; i += 1) {
  try {
    const t = await page.eval(`document.title + ' | ' + location.pathname`)
    console.log(`[${i}] ready:`, t)
    const has = await page.eval(
      `({ excalidraw: !!document.querySelector('.excalidraw'), text: document.body.innerText.slice(0, 400) })`
    )
    console.log(JSON.stringify(has, null, 2))
    break
  } catch (e) {
    console.log(`[${i}] wait:`, e.message)
    await sleep(2000)
  }
}
await page.screenshot('probe-02-attached.png')
ws.close()
process.exit(0)
