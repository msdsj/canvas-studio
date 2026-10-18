/**
 * 场景 G：掩码真的随请求上行（POST /api/generate/edit 的 multipart 里有 mask 文件，且 ops 带 region）
 * 场景 H：暗色 / 亮色 / 390px 移动端视觉与横向滚动检查
 */
import { connectExisting, login, authLogin, apiFetch, sleep, trace, Reporter, APP } from './harness.mjs'

trace('=== G/H start ===')
const R = new Reporter()
const page = await connectExisting()

async function freshSessionWithImage(token, title) {
  const created = await apiFetch(token, '/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, new_canvas: true }),
  })
  await login(page, { token, url: `${APP}/workspace?session=${created.body.data.id}`, waitCanvas: true })
  const doc = await page.send('DOM.getDocument', { depth: -1 })
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  await page.send('DOM.setFileInputFiles', { files: ['/tmp/cs-upload.png'], nodeId: input.nodeId })
  await page.waitFor(`document.body.innerText.includes('常用预设')`, { label: '上传弹窗', timeout: 20000 })
  await page.typeInto('textarea', 'QA 底图')
  await page.clickText('上传并加入画布', { tag: 'button' })
  await page.waitFor(`!document.body.innerText.includes('常用预设')`, { label: '弹窗关闭', timeout: 30000 })
  await sleep(1200)
  return created.body.data.id
}

try {
  const token = await authLogin()

  // ============ G ============
  const sG = await freshSessionWithImage(token, 'QA-G 掩码上行')
  R.check('G0', '会话就绪', Boolean(sG), `session=${String(sG).slice(0, 8)}`)

  // 进入编辑层
  const canvas = await page.box('.excalidraw')
  await page.clickAt(canvas.cx, canvas.cy)
  await page.waitFor(
    `Boolean([...document.querySelectorAll('input,textarea')].find(n => (n.placeholder||'').includes('框选区域')))`,
    { label: '编辑层', timeout: 15000 }
  )
  const img = await page.eval(`(() => {
    const r = document.querySelector('img[alt="编辑基准"]').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`)

  // 画笔选区（掩码按真实笔画走）
  await page.clickAria('画笔选区：按住涂抹，松手即成为可填写指令的区域')
  await page.drag([
    { x: img.x + img.w * 0.2, y: img.y + img.h * 0.25 },
    { x: img.x + img.w * 0.4, y: img.y + img.h * 0.3 },
    { x: img.x + img.w * 0.5, y: img.y + img.h * 0.5 },
  ])
  await sleep(600)
  const regions = await page.eval(`document.querySelectorAll('[title="编辑该区域的说明"]').length`)
  R.check('G1', '画笔画出 1 个区域', regions === 1, `区域数=${regions}`)

  // 气泡里写指令
  const badge = await page.eval(`(() => {
    const n = document.querySelector('[title="编辑该区域的说明"]');
    const r = n.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  await page.clickAt(badge.x, badge.y)
  await page.waitFor(`document.querySelector('textarea[placeholder*="这个区域要做什么"]')`, { label: '气泡', timeout: 8000 })
  await page.typeInto('textarea[placeholder*="这个区域要做什么"]', '把这里的人物抠出来')
  await sleep(300)

  // 监听真实的上行请求（只观察，不改写请求）
  await page.eval(`(() => {
    window.__qaEdit = null;
    const orig = window.fetch;
    window.fetch = async function (input, init) {
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || '';
        const body = init && init.body;
        if (url.includes('/generate/edit') && body instanceof FormData) {
          const entries = [];
          for (const [k, v] of body.entries()) {
            entries.push(v instanceof File
              ? { key: k, kind: 'file', name: v.name, type: v.type, size: v.size }
              : { key: k, kind: 'text', value: String(v).slice(0, 300) });
          }
          window.__qaEdit = { url, entries };
        }
      } catch (e) { window.__qaEdit = { error: String(e) }; }
      return orig.apply(this, arguments);
    };
    return true;
  })()`)

  // 只收起区域气泡（点气泡里的「完成」），不要按 Esc——Esc 会把整个编辑层关掉
  const doneBtn = await page.eval(`(() => {
    const ta = document.querySelector('textarea[placeholder*="这个区域要做什么"]');
    if (!ta) return null;
    const box = ta.closest('div.z-40') || ta.parentElement;
    const b = [...box.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '完成');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (doneBtn) await page.clickAt(doneBtn.x, doneBtn.y)
  await sleep(700)
  const stillEditing = await page.eval(`document.body.innerText.includes('已标记')`)
  trace(`still editing: ${stillEditing}`)

  // 「生成」按钮在编辑气泡底部操作行里（中栏素材面板也有一个「生成」标签）
  // 用「祖先里离它最近的编辑气泡提示语」来挑，避免取到外层容器的第一个匹配
  const genPos = await page.eval(`(() => {
    const cands = [...document.querySelectorAll('button')].filter(b => (b.innerText||'').trim() === '生成');
    const scored = cands.map(b => {
      let el = b, depth = 0, score = 0;
      while (el && depth < 8) {
        const txt = el.innerText || '';
        if (txt.includes('在区域旁边的气泡里写需求')) { score = 8 - depth; break; }
        el = el.parentElement; depth += 1;
      }
      return { b, score, depth };
    }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    if (!scored.length) return null;
    const b = scored[0].b;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, disabled: b.disabled };
  })()`)
  trace(`生成 button: ${JSON.stringify(genPos)}`)
  if (!genPos) throw new Error('找不到「生成」按钮')
  await sleep(300)
  await page.clickAt(genPos.x, genPos.y)
  trace('clicked 生成 in edit layer')

  const rec = await page.waitFor(`Boolean(window.__qaEdit)`, { label: '捕获 /generate/edit 请求', timeout: 40000 }).then(
    () => page.eval(`window.__qaEdit`)
  )
  trace(`captured: ${JSON.stringify(rec).slice(0, 900)}`)

  const maskEntry = (rec.entries || []).find((e) => e.key === 'mask')
  const fileEntry = (rec.entries || []).find((e) => e.key === 'file')
  const opsEntry = (rec.entries || []).find((e) => e.key === 'ops')
  const regionEntry = (rec.entries || []).find((e) => e.key === 'region')

  R.check('G2', '请求打到 POST /api/generate/edit 且是 multipart', /\/generate\/edit/.test(rec.url || ''), rec.url)
  R.check('G3', 'multipart 里有 mask 文件字段且大小 > 0', Boolean(maskEntry && maskEntry.size > 0), JSON.stringify(maskEntry))
  R.check('G4', 'multipart 里有底图 file 字段', Boolean(fileEntry && fileEntry.size > 0), JSON.stringify(fileEntry))
  R.check('G5', 'ops 里带 region（结构化区域指令）', Boolean(opsEntry && /"region"/.test(opsEntry.value || '')), (opsEntry?.value || '').slice(0, 200))
  R.check('G6', 'ops 里带 handler（自动识别为 cutout）', /cutout/.test(opsEntry?.value || ''), (opsEntry?.value || '').slice(0, 160))
  R.check('G7', '单区域请求也带 region 字段（兼容单区模式）', Boolean(regionEntry), (regionEntry?.value || '').slice(0, 160))
  R.check('G8', 'mask 是 PNG 图片', maskEntry?.type === 'image/png', String(maskEntry?.type))

  // 后端确认收到了 mask：任务 params 里能看到
  // 后端确认建了任务（请求是异步处理的，需要轮询）
  let items = []
  try {
    items = await (async () => {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const t = await apiFetch(token, `/api/generate/tasks?session_id=${sG}`)
        const list = t.body?.data?.items ?? []
        if (list.length > 0) return list
        await sleep(1000)
      }
      return []
    })()
  } catch {
    items = []
  }
  R.check('G9', '后端确实建了任务（掩码请求被受理）', items.length > 0, `任务数=${items.length} status=${items[0]?.status}`)

  // ============ H：视觉 ============
  // 用 D 会话（历史里有分析卡 + 方案卡）做视觉回归
  const sessions = await apiFetch(token, '/api/chat/sessions')
  const dSession = (sessions.body?.data ?? []).find((s) => s.title === 'QA-D 确认卡')
  R.check('H0', '找到用于视觉截图的会话', Boolean(dSession), dSession?.id?.slice(0, 8))

  // 暗色
  await page.eval(`localStorage.setItem('cs.theme','dark'); true`)
  await page.goto(`${APP}/workspace?session=${dSession.id}`)
  await page.waitFor(`document.querySelector('.excalidraw')`, { label: '暗色画布', timeout: 60000 })
  await sleep(3000)
  // 把侧栏里的分析卡/确认卡滚到可视区中间，保证截图里能看到它们
  await page.eval(`(() => {
    const card = [...document.querySelectorAll('div')].find(d => (d.innerText||'').includes('编排规则') && d.children.length > 1);
    if (card) card.scrollIntoView({ block: 'center' });
    return true;
  })()`)
  await sleep(800)
  const darkTheme = await page.eval(`document.documentElement.getAttribute('data-theme')`)
  R.check('H1', '暗色主题生效', darkTheme === 'dark', `data-theme=${darkTheme}`)
  await page.screenshot('H-01-dark.png')

  // 亮色
  await page.eval(`localStorage.setItem('cs.theme','light'); true`)
  await page.goto(`${APP}/workspace?session=${dSession.id}`)
  await page.waitFor(`document.querySelector('.excalidraw')`, { label: '亮色画布', timeout: 60000 })
  await sleep(2500)
  const lightTheme = await page.eval(`document.documentElement.getAttribute('data-theme')`)
  R.check('H2', '亮色主题生效', lightTheme === 'light', `data-theme=${lightTheme}`)
  await page.screenshot('H-02-light.png')

  // 390px 移动端：不能有横向滚动
  await page.setViewport(390, 844, true)
  await sleep(2000)
  const mobile = await page.eval(`(() => ({
    innerW: window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    bodyScrollW: document.body.scrollWidth,
  }))()`)
  R.check(
    'H3',
    '390px 移动端无横向滚动',
    mobile.scrollW <= mobile.innerW + 1 && mobile.bodyScrollW <= mobile.innerW + 1,
    JSON.stringify(mobile)
  )
  await page.screenshot('H-03-mobile-390.png')

  await page.clearViewport()
} catch (e) {
  R.check('FATAL', '场景 G/H 执行异常', false, e.message)
  await page.screenshot('GH-error.png').catch(() => {})
} finally {
  trace(`G/H 小结：通过 ${R.passCount} / 失败 ${R.failCount}`)
  page.ws.close()
}
process.exit(R.failCount ? 1 : 0)
