import { connectExisting, sleep } from './harness.mjs'

const page = await connectExisting()
const info = await page.eval(`(() => {
  const btns = [...document.querySelectorAll('button')].map((b, i) => {
    const r = b.getBoundingClientRect();
    return {
      i,
      text: (b.innerText||'').trim().slice(0, 20),
      aria: b.getAttribute('aria-label'),
      hasMsg: !!b.querySelector('svg.lucide-message-square'),
      r: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    };
  }).filter(b => b.hasMsg || /对话|新建/.test(b.text) || b.aria);
  return { btns, dpr: devicePixelRatio, innerW: innerWidth, innerH: innerHeight };
})()`)
console.log(JSON.stringify(info, null, 2))

const t = info.btns.find((b) => b.hasMsg)
console.log('clicking', t)
await page.clickAt(t.r.x + t.r.w / 2, t.r.y + t.r.h / 2)
await sleep(1200)
const after = await page.eval(`(() => ({
  menuitems: document.querySelectorAll('[role="menuitem"]').length,
  menu: document.querySelectorAll('[role="menu"]').length,
  overlay: document.querySelectorAll('[data-radix-popper-content-wrapper]').length,
  expanded: [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-expanded')).filter(Boolean),
}))()`)
console.log('after click:', JSON.stringify(after))
await page.screenshot('probe-05-dropdown.png')
page.ws.close()
process.exit(0)
