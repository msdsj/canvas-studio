import { connectExisting } from './harness.mjs'
const page = await connectExisting()
const out = await page.eval(`(() => ({
  url: location.href,
  hasConfirm: document.querySelectorAll('[data-run-id]').length,
  hasTaskText: /生成中|已完成|排队中/.test(document.body.innerText),
  sidebar: (document.querySelector('[role="status"]')||{}).innerText || '',
  tail: document.body.innerText.slice(0, 900),
}))()`)
console.log(JSON.stringify(out, null, 1).slice(0, 2000))
await page.screenshot('probe-08-rv2-state.png')
page.ws.close(); process.exit(0)
