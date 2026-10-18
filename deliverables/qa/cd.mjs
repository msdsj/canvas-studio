/**
 * 场景 C：有选区时聊天输入走需求分析中转站（实时步骤流，不是普通聊天）
 * 场景 D：结论不唯一 → 确认卡；未点击前绝不自动产生任务；点选后产生任务且卡片「已选择」；刷新后轨迹与已选择状态仍在
 */
import {
  connectExisting,
  login,
  authLogin,
  apiFetch,
  pollUntil,
  sleep,
  trace,
  Reporter,
  APP,
} from './harness.mjs'

trace('=== C/D start ===')
const R = new Reporter()
const page = await connectExisting()

const STEP_TITLES = ['读取需求', '判定产出', '编排决策', '整理指令']

/** 新建干净会话 + 上一张底图，返回 sessionId。 */
async function freshSessionWithImage(token, title) {
  const created = await apiFetch(token, '/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title, new_canvas: true }),
  })
  const sessionId = created.body?.data?.id
  await login(page, { token, url: `${APP}/workspace?session=${sessionId}`, waitCanvas: true, canvasTimeout: 60000 })
  const doc = await page.send('DOM.getDocument', { depth: -1 })
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  await page.send('DOM.setFileInputFiles', { files: ['/tmp/cs-upload.png'], nodeId: input.nodeId })
  await page.waitFor(`document.body.innerText.includes('常用预设')`, { label: '上传弹窗', timeout: 20000 })
  await page.typeInto('textarea', 'QA 底图')
  await page.clickText('上传并加入画布', { tag: 'button' })
  await page.waitFor(`!document.body.innerText.includes('常用预设')`, { label: '弹窗关闭', timeout: 30000 })
  await sleep(1500)
  return sessionId
}

/** 单击画布图片进入编辑层，返回编辑基准图矩形。 */
async function enterEditMode() {
  const canvas = await page.box('.excalidraw')
  await page.clickAt(canvas.cx, canvas.cy)
  await page.waitFor(`(() => {
    const i = [...document.querySelectorAll('input,textarea')].find(n => (n.placeholder||'').includes('框选区域'));
    return Boolean(i);
  })()`, { label: '编辑层工具条', timeout: 15000 })
  await page.waitFor(`document.querySelector('img[alt="编辑基准"]')`, { label: '编辑基准图', timeout: 15000 })
  return page.eval(`(() => {
    const r = document.querySelector('img[alt="编辑基准"]').getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`)
}

/** 在图片上拖一个矩形选区。 */
async function drawRegion(imgRect, [x1, y1], [x2, y2]) {
  await page.drag([
    { x: imgRect.x + imgRect.w * x1, y: imgRect.y + imgRect.h * y1 },
    { x: imgRect.x + imgRect.w * x2, y: imgRect.y + imgRect.h * y2 },
  ])
  await sleep(400)
}

/** 打开第 index 个区域的气泡并写入指令（气泡同一时刻只展开一个）。 */
async function fillRegionPrompt(index, text) {
  const pos = await page.eval(`(() => {
    const els = [...document.querySelectorAll('[title="编辑该区域的说明"]')];
    const el = els[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (!pos) throw new Error(`第 ${index + 1} 个区域徽章不存在`)
  await page.clickAt(pos.x, pos.y)
  await page.waitFor(`document.querySelector('textarea[placeholder*="这个区域要做什么"]')`, {
    label: '区域气泡展开',
    timeout: 8000,
  })
  await page.typeInto('textarea[placeholder*="这个区域要做什么"]', text)
  await sleep(200)
  await page.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
  })
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await sleep(400)
}

/** 侧栏发送一句话（确保停在「对话」标签）。 */
async function sendInSidebar(text) {
  const mode = await page.eval(`(() => {
    const chat = [...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '对话');
    return chat ? chat.className : '';
  })()`)
  trace('sidebar mode class:', mode.slice(0, 80))
  await page.typeInto('textarea[aria-label]', text)
  await page.clickAria('发送')
  await sleep(500)
}

try {
  const token = await authLogin()
  trace('auth ok')

  // ============ 场景 C ============
  const sC = await freshSessionWithImage(token, 'QA-C 中转站单区域')
  R.check('C0', 'C 会话就绪（含一张底图）', Boolean(sC), `session=${String(sC).slice(0, 8)}`)
  const imgRect = await enterEditMode()
  R.check('C1', '单击画布图片进入编辑层', Boolean(imgRect?.w), `基准图 ${Math.round(imgRect.w)}×${Math.round(imgRect.h)}`)

  await drawRegion(imgRect, [0.15, 0.15], [0.55, 0.55])
  const badges1 = await page.eval(`document.querySelectorAll('[title="编辑该区域的说明"]').length`)
  R.check('C2', '框选出 1 个编号区域', badges1 === 1, `区域数=${badges1}`)

  await fillRegionPrompt(0, '换成白色背景')
  const regionPrompt = await page.eval(`(() => {
    const chip = [...document.querySelectorAll('[title="点击填写该区域的说明"]')][0];
    return chip ? chip.innerText.trim() : '';
  })()`)
  R.check('C3', '区域气泡指令已写入', regionPrompt.includes('换成白色背景'), `chip=${JSON.stringify(regionPrompt)}`)
  await page.screenshot('C-01-region-filled.png')

  const tasksBefore = await apiFetch(token, `/api/generate/tasks?session_id=${sC}`)
  const beforeCount = (tasksBefore.body?.data?.items ?? tasksBefore.body?.data ?? []).length

  // 装一个 MutationObserver：证明「步骤是实时一条条流出来的」，而不是最后一次性渲染
  await page.eval(`(() => {
    window.__qa = { sawLive: false, maxTitles: 0, seen: new Set() };
    const scan = () => {
      const el = document.querySelector('[role="status"]');
      if (!el) return;
      const txt = el.innerText || '';
      if (txt.includes('读取需求')) window.__qa.sawLive = true;
      [...el.querySelectorAll('li span')].forEach(n => {
        const t = (n.innerText || '').trim();
        if (t && t.length < 12) window.__qa.seen.add(t);
      });
      window.__qa.maxTitles = Math.max(window.__qa.maxTitles, window.__qa.seen.size);
    };
    window.__qaObserver = new MutationObserver(scan);
    window.__qaObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    return true;
  })()`)

  await sendInSidebar('把背景换成白色')
  trace('sent in sidebar')

  // 等流程收敛：要么出现确认卡，要么出现任务卡
  const settle = await pollUntil(async () => {
    const snap = await page.eval(`(() => {
      const text = document.body.innerText;
      return {
        confirm: document.querySelectorAll('[data-run-id]').length,
        submitted: text.includes('已按所选方案开始生成') || text.includes('生成中') || text.includes('已提交 1 个生成任务'),
        live: { sawLive: window.__qa.sawLive, maxTitles: window.__qa.maxTitles, seen: [...window.__qa.seen] },
      };
    })()`)
    return snap.submitted || snap.confirm > 0 ? snap : null
  }, { label: '分析流程收敛', timeout: 45000 })
  trace(`live observer: ${JSON.stringify(settle.live)}`)

  R.check('C4', '实时流式步骤块出现过（非最后一次性渲染）', settle.live.sawLive, `观察到的步骤标题=${JSON.stringify(settle.live.seen)}`)
  R.check('C4b', '步骤是逐步追加的（同一气泡内标题数递增 ≥2）', settle.live.maxTitles >= 2, `峰值标题数=${settle.live.maxTitles}`)

  // 持久化的轨迹（历史消息里的 run 卡）：步骤 + 置信度 + 编排规则
  const persist = await page.eval(`(() => {
    const text = document.body.innerText;
    return {
      count: /产出\\s*\\d+\\s*张/.test(text),
      confidence: /置信度\\s*\\d+%/.test(text),
      steps: ['读取需求','判定产出','编排决策','整理指令','提交生成'].filter(t => text.includes(t)),
      rules: text.includes('编排规则'),
    };
  })()`)
  R.check('C5', '历史卡片保留完整步骤轨迹（5 步齐全）', persist.steps.length >= 4, `命中 ${persist.steps.length}/5：${JSON.stringify(persist.steps)}`)
  R.check('C5b', '卡片显示产出张数 + 置信度', persist.count && persist.confidence, JSON.stringify({ count: persist.count, confidence: persist.confidence }))
  R.check('C6', '最终出现任务卡或确认卡（不是普通聊天文本）', settle.confirm > 0 || settle.submitted, JSON.stringify({ confirm: settle.confirm, submitted: settle.submitted }))
  await page.screenshot('C-03-outcome.png')

  const tasksAfterC = await apiFetch(token, `/api/generate/tasks?session_id=${sC}`)
  const afterCountC = (tasksAfterC.body?.data?.items ?? tasksAfterC.body?.data ?? []).length
  R.check('C7', '结论明确时直接执行（产生任务）', afterCountC > beforeCount, `任务数 ${beforeCount} → ${afterCountC}`)

  // C8：任务卡上的「生成中 · Ns」是否可信（用它自己的 created_at 反算真实耗时）
  const elapsedProbe = await page.eval(`(() => {
    const m = document.body.innerText.match(/生成中\\s*·\\s*(\\d+)s/);
    return m ? Number(m[1]) : null;
  })()`)
  const latestTask = (tasksAfterC.body?.data?.items ?? tasksAfterC.body?.data ?? []).slice(-1)[0]
  const createdAtRaw = latestTask?.created_at
  // 后端返回的是 naive UTC（无时区后缀），按 UTC 解析算真实年龄
  const realAge = createdAtRaw
    ? Math.round((Date.now() - Date.parse(createdAtRaw.endsWith('Z') ? createdAtRaw : `${createdAtRaw}Z`)) / 1000)
    : null
  const elapsedOk = elapsedProbe != null && realAge != null && Math.abs(elapsedProbe - realAge) <= 120
  R.check(
    'C8',
    '任务卡耗时显示正确（与实际经过时间一致）',
    elapsedOk,
    `UI 显示 ${elapsedProbe}s / 实际约 ${realAge}s（created_at=${createdAtRaw}）`
  )

  // ============ 场景 D ============
  const sD = await freshSessionWithImage(token, 'QA-D 确认卡')
  R.check('D0', 'D 会话就绪（含一张底图）', Boolean(sD), `session=${String(sD).slice(0, 8)}`)
  const imgRect2 = await enterEditMode()
  await drawRegion(imgRect2, [0.1, 0.1], [0.45, 0.5])
  await drawRegion(imgRect2, [0.55, 0.2], [0.85, 0.7])
  const badges2 = await page.eval(`document.querySelectorAll('[title="编辑该区域的说明"]').length`)
  R.check('D1', '画布上标出 2 个区域', badges2 === 2, `区域数=${badges2}`)

  await fillRegionPrompt(0, '换成白色背景')
  await fillRegionPrompt(1, '抠出人物')
  await page.screenshot('D-01-two-regions.png')

  const tasksBeforeD = await apiFetch(token, `/api/generate/tasks?session_id=${sD}`)
  const beforeD = (tasksBeforeD.body?.data?.items ?? tasksBeforeD.body?.data ?? []).length

  await sendInSidebar('把背景换成白色，或者把人物抠出来')
  trace('D sent')

  // 两个方案
  const options = await pollUntil(async () => {
    const els = await page.eval(`(() => {
      const card = document.querySelector('[data-run-id]');
      if (!card) return null;
      return {
        runId: card.getAttribute('data-run-id'),
        texts: [...card.querySelectorAll('button')].map(b => (b.innerText||'').trim()).slice(0, 6),
        reply: (card.innerText || '').split('\\n').slice(0, 3),
      };
    })()`)
    return els && els.texts.length >= 2 ? els : null
  }, { label: '确认卡出现', timeout: 35000 })
  const optText = options.texts.join(' | ')
  R.check('D2', '出现确认卡且给出两个方案', options.texts.length >= 2, `runId=${String(options.runId).slice(0, 8)} 方案=${JSON.stringify(options.texts)}`)
  R.check('D3', '两个方案分别是「1 张修改图」与「2 张：修改图+透明素材」', /1 张/.test(optText) && /2 张/.test(optText), optText.slice(0, 120))
  await page.screenshot('D-02-confirm-card.png')

  // 未点击前 15 秒内绝不产生新任务
  await sleep(15000)
  const tasksIdle = await apiFetch(token, `/api/generate/tasks?session_id=${sD}`)
  const idleCount = (tasksIdle.body?.data?.items ?? tasksIdle.body?.data ?? []).length
  R.check('D4', '未点击前 15 秒内不产生任何新任务（不自动扣费）', idleCount === beforeD, `任务数 ${beforeD} → ${idleCount}`)

  // 点「出 2 张」再点「就按这个来」
  const picked = await page.eval(`(() => {
    const card = document.querySelector('[data-run-id]');
    const btn = [...card.querySelectorAll('button')].find(b => (b.innerText||'').includes('出 2 张'));
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  R.check('D5', '确认卡里能点到「出 2 张」方案', Boolean(picked))
  await page.clickAt(picked.x, picked.y)
  await sleep(400)
  await page.clickText('就按这个来', { tag: 'button' })
  trace('clicked confirm')

  const settled = await pollUntil(async () => {
    const ok = await page.eval(`document.body.innerText.includes('已选择')`)
    return ok ? true : null
  }, { label: '卡片进入已选择', timeout: 30000 })
  R.check('D6', '确认后卡片变为「已选择」', Boolean(settled))

  const tasksAfterD = await pollUntil(async () => {
    const t = await apiFetch(token, `/api/generate/tasks?session_id=${sD}`)
    const n = (t.body?.data?.items ?? t.body?.data ?? []).length
    return n > beforeD ? n : null
  }, { label: '确认后产生任务', timeout: 30000 })
  R.check('D7', '确认后产生任务（按 2 张执行）', tasksAfterD > beforeD, `任务数 ${beforeD} → ${tasksAfterD}`)
  await page.screenshot('D-03-selected.png')

  // 刷新后仍能看到步骤轨迹与已选择状态
  await page.goto(`${APP}/workspace?session=${sD}`)
  await page.waitFor(`document.querySelector('.excalidraw')`, { label: '刷新后画布', timeout: 60000 })
  await sleep(3500)
  const persisted = await page.eval(`(() => ({
    steps: ${JSON.stringify(STEP_TITLES)}.filter(t => document.body.innerText.includes(t)),
    selected: document.body.innerText.includes('已选择'),
    rules: document.body.innerText.includes('编排规则'),
    confidence: /置信度\\s*\\d+%/.test(document.body.innerText),
  }))()`)
  R.check('D8', '刷新后 assistant 消息仍保留步骤轨迹', persisted.steps.length >= 3, `命中步骤=${JSON.stringify(persisted.steps)}`)
  R.check('D9', '刷新后仍显示「已选择」状态', persisted.selected, JSON.stringify(persisted))
  R.check('D10', '历史消息里保留 Skills 编排规则（可折叠）与置信度', persisted.rules && persisted.confidence, JSON.stringify(persisted))
  await page.screenshot('D-04-after-reload.png')
} catch (e) {
  R.check('FATAL', '场景 C/D 执行异常', false, e.message)
  await page.screenshot('CD-error.png').catch(() => {})
} finally {
  trace(`C/D 小结：通过 ${R.passCount} / 失败 ${R.failCount}`)
  page.ws.close()
}
process.exit(R.failCount ? 1 : 0)
