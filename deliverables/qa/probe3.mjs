import { CDP, Session, sleep } from './harness.mjs'

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && t.url.includes('27180'))
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true })
  ws.addEventListener('error', rej, { once: true })
})
const page = new Session(ws)
await page.send('Page.enable')
await page.send('Runtime.enable')
await page.send('Page.bringToFront')

const out = await page.eval(`(() => {
  const keys = Object.keys(localStorage);
  const tokKey = keys.find(k => /token/i.test(k));
  // 画布元素统计
  const layerRows = document.querySelectorAll('li > div[role="button"]');
  const editImgs = [...document.querySelectorAll('img')].map(i => ({ alt: i.alt, src: (i.src||'').slice(0,40) }));
  // 侧栏 composer
  const tabs = [...document.querySelectorAll('[role="tab"], button')].map(b => (b.textContent||'').trim()).filter(Boolean);
  const textareas = [...document.querySelectorAll('textarea,input')].map(n => ({ tag: n.tagName, ph: n.placeholder, type: n.type }));
  return {
    keys, tokKey, tok: tokKey ? String(localStorage.getItem(tokKey)).slice(0,20) : null,
    layerCount: layerRows.length,
    layerIds: [...layerRows].map(n => n.dataset.layerId),
    imgCount: document.querySelectorAll('img').length,
    editImgs, tabs: [...new Set(tabs)].slice(0, 60), textareas,
    canvasCount: document.querySelectorAll('canvas').length,
    sessionBtnText: [...document.querySelectorAll('button')].slice(0,6).map(b => (b.textContent||'').trim()),
  };
})()`)
console.log(JSON.stringify(out, null, 2))
ws.close()
process.exit(0)
