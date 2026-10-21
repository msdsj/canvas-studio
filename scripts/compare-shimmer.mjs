#!/usr/bin/env node
/**
 * 逐像素比对「旧 background-position 扫光」与「新伪元素 transform 扫光」。
 *
 * 用法：node scripts/compare-shimmer.mjs [进度点数]
 * 需要 headless Chrome 在 127.0.0.1:9222（带 --remote-debugging-port=9222）。
 *
 * 做法：
 *  1. 页面里并排放两个 320×120 宿主：左 = 旧实现，右 = 新实现；
 *  2. 用负 animation-delay 把两侧钉在同一进度并暂停；
 *  3. 整页截图 → 把 PNG 回灌进页面 → canvas 解码 → 逐列取平均亮度；
 *  4. 左半剖面 vs 右半剖面做差，输出最大/平均偏差。
 *
 * 两侧宿主同宽同高，剖面即可直接相减，无需对齐缩放。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CDP = 'http://127.0.0.1:9222'
const STEPS = Number(process.argv[2] || 9)

const html = readFileSync(resolve(ROOT, '.tmp-shimmer-compare.html'), 'utf8')
const dataUrl = 'data:text/html;base64,' + Buffer.from(html).toString('base64')

const j = async (p) => (await fetch(CDP + p)).json()
const v = await j('/json/version')
const ws = new WebSocket(v.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
const send = (method, params = {}, sessionId) =>
  new Promise((res, rej) => {
    const i = ++id
    pending.set(i, { res, rej })
    ws.send(JSON.stringify({ id: i, method, params, sessionId }))
  })
await new Promise((r, je) => { ws.onopen = r; ws.onerror = je })
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
}

const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
const s = (m, p) => send(m, p, sessionId)
await s('Page.enable')
await s('Runtime.enable')
await s('Emulation.setDeviceMetricsOverride', { width: 720, height: 200, deviceScaleFactor: 1, mobile: false })
await s('Page.navigate', { url: dataUrl })
await new Promise((r) => setTimeout(r, 400))

/** 钉住进度 → 截图 → 在页面里解码 → 返回两条列亮度剖面 */
async function sample(progress) {
  const pin = await s('Runtime.evaluate', {
    expression: `(async () => {
      const p = ${progress};
      document.body.classList.add('pinned');
      const delay = (-1.8 * p).toFixed(4) + 's';
      const oldEl = document.getElementById('oldEl');
      const newEl = document.getElementById('newEl');
      oldEl.style.animationDelay = delay;
      oldEl.style.animationPlayState = 'paused';
      let st = document.getElementById('pinStyle');
      if (!st) { st = document.createElement('style'); st.id = 'pinStyle'; document.head.appendChild(st); }
      st.textContent = '#newEl::before { animation-delay: ' + delay + '; animation-play-state: paused; }';
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const a = oldEl.getBoundingClientRect();
      const b = newEl.getBoundingClientRect();
      return JSON.stringify({
        rects: [
          { x: Math.round(a.x), y: Math.round(a.y), w: Math.round(a.width), h: Math.round(a.height) },
          { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) },
        ],
        bgPos: getComputedStyle(oldEl).backgroundPosition,
        transform: getComputedStyle(newEl, '::before').transform,
      });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (pin.exceptionDetails) throw new Error(JSON.stringify(pin.exceptionDetails))
  const meta = JSON.parse(pin.result.value)

  const shot = await s('Page.captureScreenshot', { format: 'png' })
  const png = shot.data

  // 回灌 PNG，用 canvas 解码，逐列取平均亮度
  const cmp = await s('Runtime.evaluate', {
    expression: `(async () => {
      const src = 'data:image/png;base64,' + ${JSON.stringify(png)};
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = src; });
      const cv = document.createElement('canvas');
      cv.width = img.width; cv.height = img.height;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const meta = ${JSON.stringify(JSON.stringify(meta.rects))};
      const rects = JSON.parse(meta);
      const profile = (r) => {
        // 只采样中间的竖直条带，避开圆角与描边
        const y0 = r.y + Math.round(r.h * 0.35);
        const h = Math.max(1, Math.round(r.h * 0.3));
        const data = ctx.getImageData(r.x, y0, r.w, h).data;
        const out = new Float64Array(r.w);
        for (let col = 0; col < r.w; col++) {
          let sum = 0;
          for (let row = 0; row < h; row++) {
            const i = (row * r.w + col) * 4;
            sum += 0.299 * data[i] + 0.587 * data[i+1] + 0.114 * data[i+2];
          }
          out[col] = sum / h;
        }
        return Array.from(out);
      };
      return JSON.stringify({ a: profile(rects[0]), b: profile(rects[1]), w: rects[0].w });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  })
  if (cmp.exceptionDetails) throw new Error(JSON.stringify(cmp.exceptionDetails))
  return { meta, ...JSON.parse(cmp.result.value), png }
}

const outDir = resolve(ROOT, 'deliverables/qa/shimmer')
mkdirSync(outDir, { recursive: true })

let worst = 0
let sumAbs = 0
let count = 0
console.log('\n  进度     剖面长度   最大偏差   平均偏差   旧bgPos / 新transform')
console.log('  ────────────────────────────────────────────────────────────────')
for (let i = 0; i < STEPS; i++) {
  const p = i / STEPS
  const r = await sample(p)
  let mx = 0
  let acc = 0
  const n = Math.min(r.a.length, r.b.length)
  for (let k = 0; k < n; k++) {
    const d = Math.abs(r.a[k] - r.b[k])
    if (d > mx) mx = d
    acc += d
  }
  const avg = acc / n
  if (mx > worst) worst = mx
  sumAbs += acc
  count += n
  console.log(
    `  ${p.toFixed(3)}   ${String(n).padStart(6)}   ${mx.toFixed(2).padStart(7)}   ${avg.toFixed(3).padStart(7)}   ${r.meta.bgPos} / ${r.meta.transform}`
  )
  if (i === 0 || i === STEPS - 1) {
    writeFileSync(resolve(outDir, `pinned-t${p.toFixed(2)}.png`), Buffer.from(r.png, 'base64'))
  }
}

console.log(
  `\n  全部采样：最大单列偏差 ${worst.toFixed(2)} / 255（${((worst / 255) * 100).toFixed(2)}%），平均偏差 ${(sumAbs / count).toFixed(4)} / 255`
)
console.log(`  参考：亮度差 < 1/255 视为肉眼不可分辨`)
console.log(`  截图已存 ${outDir}/`)

writeFileSync(
  resolve(outDir, 'shimmer-parity.json'),
  JSON.stringify({ steps: STEPS, maxAbsDiff: worst, meanAbsDiff: sumAbs / count }, null, 2)
)

await send('Target.closeTarget', { targetId })
ws.close()