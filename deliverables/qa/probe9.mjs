import { connectExisting } from './harness.mjs'
const page = await connectExisting()
const o = await page.eval(`(() => ({
  analysisBlock: Boolean(document.querySelector('[role="status"]')),
  analysisText: (document.querySelector('[role="status"]')||{}).innerText?.slice(0,60) || '',
  confirm: document.querySelectorAll('[data-run-id]').length,
  taskCard: /生成中|已完成|排队中/.test(document.body.innerText),
}))()`)
console.log(JSON.stringify(o))
page.ws.close(); process.exit(0)
