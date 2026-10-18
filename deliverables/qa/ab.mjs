/**
 * 场景 A / B：会话 ↔ 画布一对一
 *  A. 新建对话 → 全新空画布（元素 0、URL session 变新、后端 canvas_id 与旧的不同的）
 *  B. 切回历史对话 → 恢复该对话的画布与内容（元素仍在，且 canvas_id 回到旧的）
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

trace('=== A/B start ===')
const R = new Reporter()
const page = await connectExisting()
trace('connected')

/** 用隐藏 file input 上传一张图到画布（走真实上传弹窗）。 */
async function uploadOneImage(tag) {
  const doc = await page.send('DOM.getDocument', { depth: -1 })
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  if (!input.nodeId) throw new Error('未找到上传 input')
  await page.send('DOM.setFileInputFiles', { files: ['/tmp/cs-upload.png'], nodeId: input.nodeId })
  await page.waitFor(`document.body.innerText.includes('常用预设')`, { label: '上传弹窗', timeout: 20000 })
  await page.typeInto('textarea', `QA 上传 ${tag}`)
  await page.clickText('上传并加入画布', { tag: 'button' })
  await page.waitFor(`!document.body.innerText.includes('常用预设')`, { label: '弹窗关闭', timeout: 30000 })
}

try {
  const token = await authLogin()
  trace('auth ok')

  // 干净基线：新建会话同时开干净画布（历史会话画布里有几十张图，软件渲染下会拖慢挂载）
  const created = await apiFetch(token, '/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'QA-AB 基线会话', new_canvas: true }),
  })
  const baseSession = created.body?.data?.id
  R.check('A00', '通过真实 API 创建干净基线会话', Boolean(baseSession), `status=${created.status} session=${String(baseSession).slice(0, 8)}`)

  await login(page, { token, url: `${APP}/workspace?session=${baseSession}`, waitCanvas: true, canvasTimeout: 90000 })
  trace('opened base session')
  await sleep(1500)

  // ---- 基线 ----
  const s0 = (await currentSessionId(page)) || baseSession
  let c0 = await canvasOfSession(token, s0)
  R.check('A0', '拿到基线会话与画布', Boolean(s0 && c0.canvasId), `session=${String(s0).slice(0, 8)} canvas=${String(c0.canvasId).slice(0, 8)} elements=${c0.count}`)

  const before = c0.count
  await uploadOneImage('A')
  trace('uploaded')
  await pollUntil(async () => {
    const c = await canvasOfSession(token, s0)
    return c.count > before ? c : null
  }, { label: '上传后画布元素增加', timeout: 40000 })
  c0 = await canvasOfSession(token, s0)
  R.check('A1', '画布放入一张图后元素数 > 0', c0.count > 0, `elements=${c0.count} canvas=${String(c0.canvasId).slice(0, 8)}`)
  await page.screenshot('A-01-canvas-has-image.png')

  const oldCanvasId = c0.canvasId
  const oldCount = c0.count
  const oldSession = s0

  // ---- A：新建对话 ----
  await page.clickAria('新建对话')
  trace('clicked new session')
  await pollUntil(async () => {
    const id = await currentSessionId(page)
    return id && id !== oldSession ? id : null
  }, { label: 'URL session 变化', timeout: 25000 })
  const sNew = await currentSessionId(page)
  R.check('A2', '新建对话后 URL 的 session 变新', sNew !== oldSession, `${String(oldSession).slice(0, 8)} → ${String(sNew).slice(0, 8)}`)

  let cNew = null
  try {
    cNew = await pollUntil(async () => {
      const c = await canvasOfSession(token, sNew)
      return c.canvasId ? c : null
    }, { label: '新会话绑定画布', timeout: 30000 })
  } catch (e) {
    R.check('A3', '新会话已绑定画布', false, e.message)
  }
  if (cNew) {
    R.check('A3', '新会话已绑定画布（后端 chat_sessions.canvas_id 有值）', Boolean(cNew.canvasId), `canvas=${String(cNew.canvasId).slice(0, 8)}`)
    R.check('A4', '新会话的 canvas_id 与旧的不同（一对一）', cNew.canvasId !== oldCanvasId, `${String(oldCanvasId).slice(0, 8)} vs ${String(cNew.canvasId).slice(0, 8)}`)
  }

  try {
    const c = await pollUntil(async () => {
      const x = await canvasOfSession(token, sNew)
      return x.count === 0 ? x : null
    }, { label: '新画布元素为 0', timeout: 25000 })
    R.check('A5', '新建对话的画布元素数 = 0', c.count === 0, `elements=${c.count}`)
  } catch {
    const c = await canvasOfSession(token, sNew)
    R.check('A5', '新建对话的画布元素数 = 0', false, `elements=${c.count}（期望 0）`)
  }

  const domEmpty = await page.eval(`(() => {
    const host = [...document.querySelectorAll('*')].find(n => n.children.length <= 3 && /^\\s*导航\\s*\\d+\\s*$/.test(n.innerText || ''));
    return {
      layerRows: document.querySelectorAll('[data-layer-id]').length,
      hasExcalidraw: !!document.querySelector('.excalidraw'),
      minimap: host ? host.innerText.trim() : null,
    };
  })()`)
  R.check('A6', 'Excalidraw 仍挂载且前端画布为空（导航 0）', domEmpty.hasExcalidraw && /导航\s*0/.test(domEmpty.minimap || ''), JSON.stringify(domEmpty))
  await page.screenshot('A-02-new-session-empty.png')

  // ---- B：切回历史对话 ----
  // 1) 先验证「界面里的切换入口」：打开会话下拉，看能列出几个会话
  const trigger = await page.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => {
      const r = b.getBoundingClientRect();
      return r.width > 0 && b.querySelector('svg.lucide-message-square') && b.getAttribute('aria-haspopup') === 'menu';
    });
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, text: (btn.innerText||'').trim() };
  })()`)
  R.check('B0', '找到会话下拉按钮（可见）', Boolean(trigger), trigger ? `当前会话：${trigger.text}` : '')
  await page.clickAt(trigger.x, trigger.y)
  await page.waitFor(`document.querySelectorAll('[role="menuitem"]').length >= 1`, { label: '会话下拉展开', timeout: 10000 })
  await sleep(600)
  const menuItems = await page.eval(`[...document.querySelectorAll('[role="menuitem"]')].map(n => (n.innerText||'').trim())`)
  await page.screenshot('B-00-session-dropdown.png')
  // 用户视角的期望：下拉里能看到「当前会话 + 其它历史会话」
  R.check('B1', '会话下拉能列出历史会话（可切换）', menuItems.length > 1, `${menuItems.length} 项: ${JSON.stringify(menuItems.slice(0, 6))}`)

  // 关掉下拉（Esc），避免遮罩影响后续真实点击
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(400)

  // 2) 再验证「恢复画布」这条核心逻辑本身：直接用 ?session= 打开历史会话
  //    （与下拉切换走的是同一个 WorkspaceView 解析路径，可把「入口缺失」与「恢复逻辑」分开定责）
  trace('navigate back to base session by URL')
  await page.goto(`${APP}/workspace?session=${oldSession}`)
  await page.waitFor(`document.querySelector('.excalidraw')`, { label: '切回后 Excalidraw 挂载', timeout: 60000 })
  await pollUntil(async () => {
    const id = await currentSessionId(page)
    return id === oldSession ? id : null
  }, { label: 'URL 回到旧会话', timeout: 25000 })
  R.check('B2', '切回历史会话后 URL session 复原', true, `→ ${String(oldSession).slice(0, 8)}`)

  const cBack = await pollUntil(async () => {
    const c = await canvasOfSession(token, oldSession)
    return c.count === oldCount ? c : null
  }, { label: '画布内容恢复', timeout: 30000 })
  R.check('B3', '切回后恢复该会话的画布（canvas_id 一致）', cBack.canvasId === oldCanvasId, `${String(cBack.canvasId).slice(0, 8)} vs ${String(oldCanvasId).slice(0, 8)}`)
  R.check('B4', '切回后画布内容仍在（元素数一致）', cBack.count === oldCount, `elements=${cBack.count} (期望 ${oldCount})`)

  // DOM 侧：前端 store 里真的装载了这块画布的元素（右下角缩略导航显示元素计数）
  const minimap = await pollUntil(async () => {
    const m = await page.eval(`(() => {
      const el = [...document.querySelectorAll('span')].find(n => /导航/.test(n.parentElement?.innerText || ''));
      const host = [...document.querySelectorAll('*')].find(n => n.children.length <= 3 && /^\\s*导航\\s*\\d+\\s*$/.test(n.innerText || ''));
      return host ? host.innerText.trim() : null;
    })()`)
    return m && /\d+/.test(m) ? m : null
  }, { label: '缩略导航元素计数出现', timeout: 20000 })
  const n = Number((minimap.match(/\d+/) || [0])[0])
  R.check('B4b', '前端已装载该画布的元素（缩略导航计数一致）', n === oldCount, `导航显示 ${n}（期望 ${oldCount}）`)

  await sleep(2000)
  await page.screenshot('B-01-restored-canvas.png')

  const cNewAgain = await canvasOfSession(token, sNew)
  R.check('B5', '两块画布互不影响（新会话画布仍为空）', cNewAgain.count === 0, `elements=${cNewAgain.count}`)
} catch (e) {
  R.check('FATAL', '场景 A/B 执行异常', false, e.message)
  await page.screenshot('AB-error.png').catch(() => {})
} finally {
  trace(`A/B 小结：通过 ${R.passCount} / 失败 ${R.failCount}`)
  page.ws.close()
}
process.exit(R.failCount ? 1 : 0)
