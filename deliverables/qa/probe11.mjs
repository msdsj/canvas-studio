import { connectExisting, login, authLogin, apiFetch, sleep, trace, APP } from './harness.mjs'
const page = await connectExisting()
const token = await authLogin()
const created = await apiFetch(token, '/api/chat/sessions', { method: 'POST', body: JSON.stringify({ title: 'QA-PB 抓包', new_canvas: true }) })
const sid = created.body.data.id
await login(page, { token, url: `${APP}/workspace?session=${sid}`, waitCanvas: true })
const doc = await page.send('DOM.getDocument', { depth: -1 })
const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
await page.send('DOM.setFileInputFiles', { files: ['/tmp/cs-upload.png'], nodeId: input.nodeId })
await page.waitFor(`document.body.innerText.includes('常用预设')`, { label: '弹窗', timeout: 20000 })
await page.typeInto('textarea', 'PB')
await page.clickText('上传并加入画布', { tag: 'button' })
await page.waitFor(`!document.body.innerText.includes('常用预设')`, { label: '关闭', timeout: 30000 })
await sleep(1200)
const canvas = await page.box('.excalidraw')
await page.clickAt(canvas.cx, canvas.cy)
await page.waitFor(`Boolean([...document.querySelectorAll('input,textarea')].find(n => (n.placeholder||'').includes('框选区域')))`, { timeout: 15000 })
const img = await page.eval(`(() => { const r = document.querySelector('img[alt="编辑基准"]').getBoundingClientRect(); return { x:r.left,y:r.top,w:r.width,h:r.height }; })()`)
await page.drag([{ x: img.x+img.w*0.2, y: img.y+img.h*0.2 }, { x: img.x+img.w*0.6, y: img.y+img.h*0.6 }])
await sleep(600)
const badge = await page.eval(`(() => { const n=document.querySelector('[title="编辑该区域的说明"]'); const r=n.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`)
await page.clickAt(badge.x, badge.y)
await page.waitFor(`document.querySelector('textarea[placeholder*="这个区域要做什么"]')`, { timeout: 8000 })
await page.typeInto('textarea[placeholder*="这个区域要做什么"]', '换成白色背景')
await sleep(300)

// 抓 /chat/analyze 的请求体 + 耗时
await page.eval(`(() => {
  window.__qa = { body: null, status: null, startedAt: null, endedAt: null };
  const orig = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('/chat/analyze')) {
      window.__qa.body = init && init.body ? String(init.body) : null;
      window.__qa.startedAt = Date.now();
      const p = orig.apply(this, arguments);
      p.then(r => { window.__qa.status = r.status; }).catch(e => { window.__qa.status = 'ERR ' + e.message; })
       .finally(() => { window.__qa.endedAt = Date.now(); });
      return p;
    }
    return orig.apply(this, arguments);
  };
  return true;
})()`)

await page.typeInto('textarea[aria-label]', '把背景换成白色')
await page.clickAria('发送')
await sleep(12000)
const got = await page.eval(`window.__qa`)
console.log('SID=' + sid)
console.log('status=' + got.status)
console.log('elapsedMs=' + (got.endedAt ? got.endedAt - got.startedAt : 'still-open'))
console.log('BODY=' + (got.body || '').slice(0, 1200))
await page.screenshot('probe-11-payload.png')
page.ws.close(); process.exit(0)
