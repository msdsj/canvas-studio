/**
 * 场景 E：画笔自由选区（矩形/套索/画笔混用、同区域续画、区域数正确）
 * 场景 F：多气泡不重叠、不越界、不盖住顶部工具条
 */
import { connectExisting, login, authLogin, apiFetch, sleep, trace, Reporter, APP } from './harness.mjs'

trace('=== E/F start ===')
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

async function enterEditMode() {
  const canvas = await page.box('.excalidraw')
  await page.clickAt(canvas.cx, canvas.cy)
  await page.waitFor(
    `Boolean([...document.querySelectorAll('input,textarea')].find(n => (n.placeholder||'').includes('框选区域')))`,
    { label: '编辑层工具条', timeout: 15000 }
  )
  await page.waitFor(`document.querySelector('img[alt="编辑基准"]')`, { label: '编辑基准图', timeout: 15000 })
  return page.eval(`(() => {
    const r = document.querySelector('img[alt="编辑基准"]').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`)
}

const badgeCount = () => page.eval(`document.querySelectorAll('[title="编辑该区域的说明"]').length`)

/** 画一笔（带中间点，保证 Canvas 上真的生成笔迹） */
async function stroke(imgRect, pts) {
  const mapped = pts.map(([px, py]) => ({ x: imgRect.x + imgRect.w * px, y: imgRect.y + imgRect.h * py }))
  await page.drag(mapped, { steps: 8 })
  await sleep(500)
}

/** 所有区域 UI 的矩形（徽章 / chip / 展开的气泡） */
const regionRects = () =>
  page.eval(`(() => {
    const out = { badges: [], chips: [], bubble: null, toolbar: null, container: null };
    document.querySelectorAll('[title="编辑该区域的说明"]').forEach(n => {
      const r = n.getBoundingClientRect();
      out.badges.push({ x: r.left, y: r.top, w: r.width, h: r.height, text: (n.innerText||'').trim() });
    });
    document.querySelectorAll('[title="点击填写该区域的说明"]').forEach(n => {
      const r = n.getBoundingClientRect();
      out.chips.push({ x: r.left, y: r.top, w: r.width, h: r.height, text: (n.innerText||'').trim() });
    });
    const ta = document.querySelector('textarea[placeholder*="这个区域要做什么"]');
    if (ta) {
      const bubble = ta.closest('div.z-40');
      if (bubble) {
        const r = bubble.getBoundingClientRect();
        out.bubble = { x: r.left, y: r.top, w: r.width, h: r.height, text: (bubble.innerText||'').trim().slice(0, 30) };
      }
    }
    // 顶部编辑工具条：包含「画笔」按钮的那颗圆角胶囊
    const brushBtn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('title')||'').includes('画笔选区'));
    if (brushBtn) {
      let el = brushBtn.parentElement;
      while (el && !(el.className || '').includes('rounded-full')) el = el.parentElement;
      if (el) { const r = el.getBoundingClientRect(); out.toolbar = { x: r.left, y: r.top, w: r.width, h: r.height }; }
    }
    if (ta) {
      let el = ta.parentElement;
      while (el && getComputedStyle(el).position === 'static') el = el.parentElement;
      if (el) { const r = el.getBoundingClientRect(); out.container = { x: r.left, y: r.top, w: r.width, h: r.height }; }
    }
    return out;
  })()`)

function overlaps(a, b) {
  if (!a || !b) return false
  return !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)
}

try {
  const token = await authLogin()
  const sE = await freshSessionWithImage(token, 'QA-E 画笔选区')
  R.check('E0', '会话就绪（含底图）', Boolean(sE), `session=${String(sE).slice(0, 8)}`)
  const img = await enterEditMode()
  R.check('E1', '进入编辑层', Boolean(img?.w), `基准图 ${Math.round(img.w)}×${Math.round(img.h)}`)

  // 切到画笔
  await page.clickAria('画笔选区：按住涂抹，松手即成为可填写指令的区域')
  const brushActive = await page.eval(`(() => {
    const b = [...document.querySelectorAll('button')].find(n => (n.getAttribute('title')||'').includes('画笔选区'));
    return b ? b.className : '';
  })()`)
  R.check('E2', '画笔工具已激活', /bg-brand|text-white|active/.test(brushActive), brushActive.slice(0, 60))

  // 第一笔：左上
  await stroke(img, [[0.15, 0.18], [0.28, 0.22], [0.35, 0.3]])
  const c1 = await badgeCount()
  R.check('E3', '画笔涂抹后生成 1 个带编号区域', c1 === 1, `区域数=${c1}`)
  await page.screenshot('E-01-brush-first.png')

  // 第二笔：右下（不同位置）
  await stroke(img, [[0.6, 0.62], [0.72, 0.68], [0.8, 0.75]])
  const c2 = await badgeCount()
  const nums = await page.eval(`[...document.querySelectorAll('[title="编辑该区域的说明"]')].map(n => (n.innerText||'').trim())`)
  R.check('E4', '第二笔在别处生成第 2 个区域，编号连续', c2 === 2 && nums.join(',') === '1,2', `区域数=${c2} 编号=${JSON.stringify(nums)}`)
  // 每个区域都有自己的输入面：刚画完的那个是展开气泡，另一个收缩成 chip
  const surfaces = await page.eval(`(() => ({
    chips: document.querySelectorAll('[title="点击填写该区域的说明"]').length,
    bubbles: document.querySelectorAll('textarea[placeholder*="这个区域要做什么"]').length,
  }))()`)
  R.check(
    'E5',
    '两个画笔区域各有自己的输入气泡（1 展开 + 1 chip）',
    surfaces.chips + surfaces.bubbles === 2,
    JSON.stringify(surfaces)
  )
  await page.screenshot('E-02-brush-two.png')

  // 同一区域续画：起点落在第 1 个区域包围盒内
  const badge1 = await page.eval(`(() => {
    const n = document.querySelectorAll('[title="编辑该区域的说明"]')[0];
    const r = n.getBoundingClientRect();
    return { x: r.left, y: r.top };
  })()`)
  await stroke(img, [[0.2, 0.2], [0.24, 0.26]])
  const c3 = await badgeCount()
  R.check('E6', '在同一区域内续画不会新增区域（笔迹合并）', c3 === 2, `区域数=${c3}（期望 2）`)

  // 矩形 + 画笔混用
  await page.clickText('框选', { tag: 'button' })
  await page.drag([
    { x: img.x + img.w * 0.08, y: img.y + img.h * 0.62 },
    { x: img.x + img.w * 0.42, y: img.y + img.h * 0.92 },
  ])
  await sleep(600)
  const c4 = await badgeCount()
  R.check('E7', '矩形 + 画笔混合，区域数正确（3 个）', c4 === 3, `区域数=${c4}`)
  await page.screenshot('E-03-mixed-three.png')

  // ============ F：多气泡不重叠 / 不越界 / 不盖工具条 ============
  let allOk = true
  const details = []
  for (let i = 0; i < 3; i += 1) {
    const pos = await page.eval(`(() => {
      const n = document.querySelectorAll('[title="编辑该区域的说明"]')[${i}];
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!pos) throw new Error(`第 ${i + 1} 个徽章不存在`)
    await page.clickAt(pos.x, pos.y)
    await page.waitFor(`document.querySelector('textarea[placeholder*="这个区域要做什么"]')`, { label: `第 ${i + 1} 个气泡`, timeout: 8000 })
    await sleep(500)

    const rects = await regionRects()
    const active = rects.bubble
    const others = rects.chips
    const hitOther = others.filter((c) => overlaps(active, c))
    const inContainer =
      rects.container &&
      active.x >= rects.container.x - 1 &&
      active.y >= rects.container.y - 1 &&
      active.x + active.w <= rects.container.x + rects.container.w + 1 &&
      active.y + active.h <= rects.container.y + rects.container.h + 1
    const hitToolbar = overlaps(active, rects.toolbar)
    const ok = !hitOther.length && inContainer && !hitToolbar
    if (!ok) allOk = false
    details.push({
      region: i + 1,
      bubble: active && { x: Math.round(active.x), y: Math.round(active.y), w: Math.round(active.w), h: Math.round(active.h) },
      overlapWith: hitOther.length,
      inContainer: Boolean(inContainer),
      coversToolbar: Boolean(hitToolbar),
      toolbar: rects.toolbar && { y: Math.round(rects.toolbar.y), h: Math.round(rects.toolbar.h) },
    })
    await page.screenshot(`F-0${i + 1}-bubble-${i + 1}.png`)
  }
  trace(`F 细节: ${JSON.stringify(details, null, 1)}`)

  R.check('F1', '3 个气泡逐个展开都不与其它气泡/chip 相交', details.every((d) => d.overlapWith === 0), JSON.stringify(details.map((d) => d.overlapWith)))
  R.check('F2', '气泡不超出画布容器边界', details.every((d) => d.inContainer), JSON.stringify(details.map((d) => d.inContainer)))
  R.check('F3', '气泡不盖住顶部工具条', details.every((d) => !d.coversToolbar), JSON.stringify(details.map((d) => ({ covers: d.coversToolbar, bubbleY: d.bubble?.y, toolbar: d.toolbar }))))
} catch (e) {
  R.check('FATAL', '场景 E/F 执行异常', false, e.message)
  await page.screenshot('EF-error.png').catch(() => {})
} finally {
  trace(`E/F 小结：通过 ${R.passCount} / 失败 ${R.failCount}`)
  page.ws.close()
}
process.exit(R.failCount ? 1 : 0)
