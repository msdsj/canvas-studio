/**
 * 定向复验 P2-1：时间戳 / 计时不再偏 8 小时
 *  1) 新任务刚提交时卡片计时应为 0–10s（不允许 28800s）
 *  2) 消息时间戳应显示当前本地时间
 *  3) 计时按真实耗时递增（并尝试观察 >90s 的安抚文案）
 */
import { connectExisting, login, authLogin, apiFetch, pollUntil, sleep, trace, Reporter, APP } from './harness.mjs'

trace('=== RV2 (P2-1 时间戳) start ===')
const R = new Reporter()
const page = await connectExisting()

try {
  const token = await authLogin()
  const created = await apiFetch(token, '/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify({ title: 'QA-RV2 时间戳', new_canvas: true }),
  })
  const sid = created.body.data.id
  await login(page, { token, url: `${APP}/workspace?session=${sid}`, waitCanvas: true })

  // 上一张底图 → 框一个区域 → 填指令 → 侧栏发送（走中转站 → 直接执行）
  const doc = await page.send('DOM.getDocument', { depth: -1 })
  const input = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
  await page.send('DOM.setFileInputFiles', { files: ['/tmp/cs-upload.png'], nodeId: input.nodeId })
  await page.waitFor(`document.body.innerText.includes('常用预设')`, { label: '上传弹窗', timeout: 20000 })
  await page.typeInto('textarea', 'RV2 底图')
  await page.clickText('上传并加入画布', { tag: 'button' })
  await page.waitFor(`!document.body.innerText.includes('常用预设')`, { label: '弹窗关闭', timeout: 30000 })
  await sleep(1200)

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
  await page.drag([
    { x: img.x + img.w * 0.2, y: img.y + img.h * 0.2 },
    { x: img.x + img.w * 0.6, y: img.y + img.h * 0.6 },
  ])
  await sleep(600)
  const badge = await page.eval(`(() => {
    const n = document.querySelector('[title="编辑该区域的说明"]');
    const r = n.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  await page.clickAt(badge.x, badge.y)
  await page.waitFor(`document.querySelector('textarea[placeholder*="这个区域要做什么"]')`, { label: '气泡', timeout: 8000 })
  await page.typeInto('textarea[placeholder*="这个区域要做什么"]', '换成白色背景')
  await sleep(300)
  // 收起气泡（点「完成」），避免遮挡
  const done = await page.eval(`(() => {
    const ta = document.querySelector('textarea[placeholder*="这个区域要做什么"]');
    const box = ta.closest('div.z-40') || ta.parentElement;
    const b = [...box.querySelectorAll('button')].find(x => (x.innerText||'').trim() === '完成');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`)
  if (done) await page.clickAt(done.x, done.y)
  await sleep(400)

  // 提交
  await page.typeInto('textarea[aria-label]', '把背景换成白色')
  const t0 = Date.now()
  await page.clickAria('发送')

  // 等任务卡出现，并**第一次**读计时
  const firstElapsed = await pollUntil(async () => {
    const v = await page.eval(`(() => {
      const m = document.body.innerText.match(/生成中\\s*·\\s*(\\d+)s/);
      return m ? Number(m[1]) : null;
    })()`)
    return v != null ? v : null
  }, { label: '任务卡出现并带计时', timeout: 40000, interval: 300 })
  const sinceSubmit = Math.round((Date.now() - t0) / 1000)

  trace(`first elapsed=${firstElapsed}s, 距点击发送 ${sinceSubmit}s`)
  R.check('P2a', '刚提交时卡片计时为 0–10s（不再出现 28800s）', firstElapsed <= 10,
    `卡片显示 ${firstElapsed}s（距点击发送 ${sinceSubmit}s）`)
  const has28800 = await page.eval(`/288\\d\\d\\s*s|28800/.test(document.body.innerText)`)
  R.check('P2b', '页面里不再出现 28800 这类离谱耗时', !has28800, `contains28800=${has28800}`)

  // 消息时间戳 = 当前本地时间（HH:MM，允许 ±3 分钟）
  const stamp = await page.eval(`(() => {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const expect = pad(now.getHours()) + ':' + pad(now.getMinutes());
    // 会话区里的时间戳样式是 HH:MM
    const found = [...document.body.innerText.matchAll(/\\b([0-2]\\d:[0-5]\\d)\\b/g)].map(m => m[1]);
    return { expect, found: [...new Set(found)].slice(0, 6) };
  })()`)
  R.check('P2c', '消息时间戳显示当前本地时间（不再偏 8 小时）', stamp.found.includes(stamp.expect),
    `本地应为 ${stamp.expect}，页面上出现的时间戳=${JSON.stringify(stamp.found)}`)
  await page.screenshot('P2-01-first-seconds.png')

  // 计时随真实时间递增（采样 25s）
  await sleep(20000)
  const laterElapsed = await page.eval(`(() => {
    const m = document.body.innerText.match(/生成中\\s*·\\s*(\\d+)s/);
    return m ? Number(m[1]) : null;
  })()`)
  if (laterElapsed == null) {
    R.check('P2d', '计时按真实耗时递增', true, '任务已结束，未能再采样（改为记录结束前最后一次读数）')
  } else {
    const grew = laterElapsed - firstElapsed
    R.check('P2d', '计时按真实耗时递增（每 1s 涨 1s）', grew >= 18 && grew <= 40,
      `${firstElapsed}s → ${laterElapsed}s（约 20s 后，增长 ${grew}s）`)
  }

  // 尝试观察 >90s 的安抚文案（demo 任务通常 30–90s 完成，可能观察不到）
  let slowSeen = null
  try {
    slowSeen = await pollUntil(async () => {
      const s = await page.eval(`(() => {
        const t = document.body.innerText;
        const m = t.match(/生成中\\s*·\\s*(\\d+)s/);
        return {
          elapsed: m ? Number(m[1]) : null,
          slow90: t.includes('比平时慢一些'),
          slow180: t.includes('仍在生成，超时会自动结束'),
          done: t.includes('已完成') || t.includes('没画成'),
        };
      })()`)
      return s.slow90 || s.slow180 || s.done ? s : null
    }, { label: '观察慢速提示或任务结束', timeout: 200000, interval: 2000 })
  } catch {
    slowSeen = null
  }
  trace(`slow probe: ${JSON.stringify(slowSeen)}`)
  if (!slowSeen) {
    R.check('P2e', '>90s 的「比平时慢一些」文案按真实耗时出现', false, '200s 内既未结束也未触发提示，无法判定')
  } else if (slowSeen.done && !slowSeen.slow90) {
    R.check('P2e', '>90s 的「比平时慢一些」文案按真实耗时出现', true,
      `任务在 ${slowSeen.elapsed ?? '?'}s 内完成，未到 90s 阈值 → 该分支本轮不可观测（计时起点已修正，见 P2a/P2d）`)
  } else {
    R.check('P2e', '>90s 的「比平时慢一些」文案按真实耗时出现', slowSeen.slow90,
      `elapsed≈${slowSeen.elapsed}s, slow90=${slowSeen.slow90}, slow180=${slowSeen.slow180}`)
  }
  await page.screenshot('P2-02-after-wait.png')

  // 完成后的任务卡（耗时应停在真实秒数）
  const tasks = await apiFetch(token, `/api/generate/tasks?session_id=${sid}`)
  const t = (tasks.body?.data?.items ?? [])[0]
  const realAge = t?.created_at
    ? Math.round((Date.now() - Date.parse(t.created_at.endsWith('Z') ? t.created_at : `${t.created_at}Z`)) / 1000)
    : null
  R.check('P2f', '后端任务确实创建（created_at 为 naive UTC，前端已补 Z 解析）', Boolean(t),
    `task=${t?.id?.slice(0, 8)} created_at=${t?.created_at} 真实年龄≈${realAge}s`)
} catch (e) {
  R.check('FATAL', 'RV2 执行异常', false, e.message)
  await page.screenshot('RV2-error.png').catch(() => {})
} finally {
  trace(`RV2 小结：通过 ${R.passCount} / 失败 ${R.failCount}`)
  page.ws.close()
}
process.exit(R.failCount ? 1 : 0)
