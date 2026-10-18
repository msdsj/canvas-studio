import { connectExisting, sleep } from './harness.mjs'
const page = await connectExisting()
const out = await page.eval(`(() => {
  const btns = [...document.querySelectorAll('button')].map(b => {
    const r = b.getBoundingClientRect();
    return { t: (b.innerText||'').trim().slice(0,12), w: Math.round(r.width), h: Math.round(r.height),
      y: Math.round(r.top), x: Math.round(r.left), cls: (b.querySelector('svg')||{}).getAttribute?.('class') || '',
      disabled: b.disabled };
  }).filter(b => b.w > 0 && b.h > 0);
  return { btns: btns.filter(b => /生成|分析|完成|继续/.test(b.t)), tail: document.body.innerText.slice(-400) };
})()`)
console.log(JSON.stringify(out, null, 1))
await page.screenshot('probe-07-composer.png')
page.ws.close(); process.exit(0)
