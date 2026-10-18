import { connectExisting, sleep } from './harness.mjs'
const page = await connectExisting()
const cands = await page.eval(`(() => [...document.querySelectorAll('button')].map(b => {
  const r = b.getBoundingClientRect();
  return { text: (b.innerText||'').trim().slice(0,24), w: Math.round(r.width), h: Math.round(r.height),
    chev: !!b.querySelector('svg.lucide-chevron-down'), msg: !!b.querySelector('svg.lucide-message-square'),
    x: Math.round(r.left), y: Math.round(r.top),
    expanded: b.getAttribute('aria-expanded'), haspopup: b.getAttribute('aria-haspopup') };
}).filter(b => b.w > 0 && (b.chev || b.haspopup || b.msg)))()`)
console.log(JSON.stringify(cands, null, 1))
const t = cands.find(c => c.chev && c.haspopup === 'menu') || cands.find(c => c.chev)
console.log('target', t)
await page.clickAt(t.x + t.w/2, t.y + t.h/2)
await sleep(1200)
console.log('after:', JSON.stringify(await page.eval(`({ items: document.querySelectorAll('[role="menuitem"]').length, texts: [...document.querySelectorAll('[role="menuitem"]')].map(n=>n.innerText.trim()).slice(0,8) })`)))
await page.screenshot('probe-06-dropdown-open.png')
page.ws.close(); process.exit(0)
