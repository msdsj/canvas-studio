import { connectExisting, authLogin, apiFetch, canvasOfSession, currentSessionId, sleep, trace } from './harness.mjs'
const page = await connectExisting()
const token = await authLogin()
await sleep(2500)
const sid = await currentSessionId(page)
const c = await canvasOfSession(token, sid)
const domN = await page.eval(`(() => {
  const host = [...document.querySelectorAll('*')].find(n => n.children.length <= 3 && /^\\s*导航\\s*\\d+\\s*$/.test(n.innerText || ''));
  return host ? host.innerText.trim() : null;
})()`)
const title = await page.eval(`(() => { const b=[...document.querySelectorAll('button')].find(x=>x.querySelector('svg.lucide-message-square')&&x.getBoundingClientRect().width>0); return b?b.innerText.trim():''; })()`)
trace(`final session=${sid} title=${title} 后端elements=${c.count} 前端导航=${JSON.stringify(domN)}`)
await page.screenshot('P1-03-after-rapid.png')
page.ws.close(); process.exit(0)
