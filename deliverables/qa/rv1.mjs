/**
 * 定向复验 P1-1：会话下拉列出全部会话 + A↔B 来回切 + 快速连切 5 次不串画布
 */
import {
  connectExisting,
  login,
  authLogin,
  apiFetch,
  canvasOfSession,
  currentSessionId,
  pollUntil,
  sleep,
  trace,
  Reporter,
  APP,
} from './harness.mjs'

trace('=== RV1 (P1-1 会话下拉) start ===')
const R = new Reporter()
const page = await connectExisting()

/** 新建会话并往画布上放 n 张图 */
async function makeSession(token, title, n) {
  const created = await apiFetch(token, '/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, new_canvas: true }),
  })
  const id = created.body.data.id
  await login(page, { token, url: `${APP}/workspace?session=${id}`, waitCanvas: true })
  for (let i = 0; i < n; i += 1) {
    const doc = await page.send('DOM.getDocument', { depth: -1 })
    const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
    await page.send('DOM.setFileInputFiles', { files: ['/tmp/cs-upload.png'], nodeId: input.nodeId })
    await page.waitFor(`document.body.innerText.includes('常用预设')`, { label: '上传弹窗', timeout: 20000 })
    await page.typeInto('textarea', `RV ${i + 1}`)
    await page.clickText('上传并加入画布', { tag: 'button' })
    await page.waitFor(`!document.body.innerText.includes('常用预设')`, { label: '弹窗关闭', timeout: 30000 })
    await sleep(600)
  }
  await pollUntil(async () => {
    const c = await canvasOfSession(token, id)
    return c.count >= n ? c : null
  }, { label: `${title} 元素数就绪`, timeout: 30000 })
  return id
}

/** 打开会话下拉，返回菜单项文本 */
async function openMenu() {
  const trigger = await page.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && b.querySelector('svg.lucide-message-square') && b.getAttribute('aria-haspopup') === 'menu';
    });
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!trigger) throw new Error('找不到会话下拉按钮')
  await page.clickAt(trigger.x, trigger.y)
  await page.waitFor(`document.querySelectorAll('[role="menuitem"]').length >= 1`, { label: '下拉展开', timeout: 10000 })
  await sleep(500)
  return page.eval(`[...document.querySelectorAll('[role="menuitem"]')].map(n => (n.innerText||'').trim())`)
}

/** 在下拉里点某个标题的会话，并等到 URL 切过去 */
async function switchTo(title, { wait = true } = {}) {
  const pos = await page.eval(`(() => {
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    const el = items.find(n => (n.innerText||'').trim().includes(${JSON.stringify(title)}));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!pos) throw new Error(`下拉里找不到「${title}」`)
  await page.clickAt(pos.x, pos.y)
  if (!wait) return
  await sleep(200)
}

/** 前端「导航 N」里的 N */
const minimapCount = () =>
  page.eval(`(() => {
    const host = [...document.querySelectorAll('*')].find(n => n.children.length <= 3 && /^\\s*导航\\s*\\d+\\s*$/.test(n.innerText || ''));
    return host ? Number((host.innerText.match(/\\d+/) || [0])[0]) : null;
  })()`)

try {
  const token = await authLogin()

  // 三个元素数各不相同的干净会话，用来判定「画布是否串了」
  const sA = await makeSession(token, 'QA-RV A', 1)
  const sB = await makeSession(token, 'QA-RV B', 2)
  const sC = await makeSession(token, 'QA-RV C', 3)
  R.check('P1-a', '准备 3 个元素数不同的会话（1/2/3 张）', Boolean(sA && sB && sC),
    `A=${sA.slice(0, 8)}(1) B=${sB.slice(0, 8)}(2) C=${sC.slice(0, 8)}(3)`)

  // ---- 复验点 1：下拉应列出 admin 全部会话 ----
  await login(page, { token, url: `${APP}/workspace?session=${sA}`, waitCanvas: true })
  await sleep(1500)
  const items = await openMenu()
  const totalSessions = (await apiFetch(token, '/api/chat/sessions')).body.data.length
  R.check('P1-b', '下拉展开项数 = 后端会话总数（不再被 canvas_id 过滤成 1）', items.length === totalSessions,
    `下拉 ${items.length} 项 / 后端 ${totalSessions} 个会话`)
  R.check('P1-c', '下拉里能同时看到 A/B/C 三个会话', ['QA-RV A', 'QA-RV B', 'QA-RV C'].every((t) => items.some((x) => x.includes(t))),
    JSON.stringify(items.slice(0, 6)))
  await page.screenshot('P1-01-dropdown-full.png')

  // ---- 复验点 2：A↔B 来回切两次，内容都在 ----
  const backAndForth = [
    ['QA-RV B', sB, 2],
    ['QA-RV A', sA, 1],
    ['QA-RV B', sB, 2],
    ['QA-RV A', sA, 1],
  ]
  const abDetails = []
  let abOk = true
  for (const [title, sid, expect] of backAndForth) {
    if (!(await page.eval(`document.querySelectorAll('[role="menuitem"]').length > 0`))) await openMenu()
    await switchTo(title)
    await pollUntil(async () => ((await currentSessionId(page)) === sid ? true : null), { label: `切到 ${title}`, timeout: 20000 })
    // 后端数据
    const c = await canvasOfSession(token, sid)
    // 前端显示
    let domN = null
    try {
      domN = await pollUntil(async () => {
        const n = await minimapCount()
        return n === expect ? n : null
      }, { label: `${title} 前端计数`, timeout: 15000 })
    } catch {
      domN = await minimapCount()
    }
    const ok = c.count === expect && domN === expect
    if (!ok) abOk = false
    abDetails.push({ title, 期望: expect, 后端: c.count, 前端导航: domN, ok })
  }
  R.check('P1-d', 'A↔B 来回切两次，每次内容都在且不串（后端 + 前端双侧）', abOk, JSON.stringify(abDetails))
  await page.screenshot('P1-02-back-to-A.png')

  // ---- 复验点 3：快速连切 5 次，最终停在最后点的会话 ----
  const seq = [
    ['QA-RV B', sB],
    ['QA-RV C', sC],
    ['QA-RV A', sA],
    ['QA-RV B', sB],
    ['QA-RV A', sA],
  ]
  for (const [title] of seq) {
    await openMenu()
    await switchTo(title, { wait: false })
    await sleep(120) // 故意不等加载完，制造并发切换
  }
  const finalSid = await pollUntil(async () => {
    const id = await currentSessionId(page)
    return id === sA ? id : null
  }, { label: '快速连切后停在 A', timeout: 25000 })
  R.check('P1-e', '快速连切 5 次后停在最后点击的会话（A）', finalSid === sA, `${finalSid?.slice(0, 8)} (期望 ${sA.slice(0, 8)})`)

  await sleep(3000)
  const finalCanvas = await canvasOfSession(token, sA)
  const finalDomN = await minimapCount()
  R.check('P1-f', '快速连切后画布不串（应显示 A 的 1 张）', finalCanvas.count === 1 && finalDomN === 1,
    `后端 ${finalCanvas.count} / 前端导航 ${finalDomN}（期望 1）`)
  await page.screenshot('P1-03-after-rapid.png')
} catch (e) {
  R.check('FATAL', 'RV1 执行异常', false, e.message)
  await page.screenshot('RV1-error.png').catch(() => {})
} finally {
  trace(`RV1 小结：通过 ${R.passCount} / 失败 ${R.failCount}`)
  page.ws.close()
}
process.exit(R.failCount ? 1 : 0)
