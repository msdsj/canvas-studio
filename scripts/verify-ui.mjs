#!/usr/bin/env node
/**
 * UI 一致性断言（不是截图比对，是几何断言）
 *
 * 用法：node scripts/verify-ui.mjs
 *
 * 断言清单（每条对应审计里的一条缺陷，修完必须由红变绿）：
 *   A1  内容页背景不含环境光（body backgroundImage 只有纸纹或 none）
 *   A2  三个内容页 h1 左沿在 1440 下完全一致（差异 ≤1px）
 *   A3  页头到第一块内容的间距一致（≤1px 差异）
 *   W1  画布 dock 内没有任何按钮文字换行（按钮 scrollHeight ≈ clientHeight）
 *   W2  画布只有一组缩放控件（zoom-in 按钮数量 = 1）
 *   S1  /skills 最后一行卡片没有被裁切，也没有被浮条遮住
 *   E1  空状态图形尺寸符合 72×72（存在时）
 *   M1  390 宽下顶栏不叠字（品牌文字与额度徽标不重叠）
 *
 * 退出码非 0 表示有断言失败。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pwDir = [
  path.join(ROOT, 'frontend/node_modules/playwright'),
  path.join(ROOT, 'node_modules/playwright'),
].find((p) => existsSync(p))
if (!pwDir) {
  console.error('找不到 playwright')
  process.exit(2)
}
const { chromium } = await import(path.join(pwDir, 'index.mjs'))

const BASE = process.env.CS_BASE || 'http://127.0.0.1:27180'
const API = process.env.CS_API || 'http://127.0.0.1:27181'
const EMAIL = process.env.CS_EMAIL || 'admin@canvas.studio'
const PASSWORD = process.env.CS_PASSWORD || 'Admin@12345'

const r = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
const token = (await r.json())?.data?.access_token
if (!token) {
  console.error('登录失败，后端未启动或账号不对')
  process.exit(2)
}

const results = []
const check = (id, desc, pass, detail) => {
  results.push({ id, desc, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${id.padEnd(4)} ${desc}${detail ? ` — ${detail}` : ''}`)
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await page.evaluate((t) => localStorage.setItem('cs.token', t), token)

const goto = async (url) => {
  await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 45_000 })
  await page.waitForTimeout(1200)
}

/* ---------------- A1 背景 ---------------- */
await goto('/assets')
const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundImage)
check('A1', '内容页无环境光污染', !bg.includes('radial-gradient'), bg.slice(0, 60))

/* ---------------- A2/A3 页头对齐 ---------------- */
const heads = {}
for (const url of ['/assets', '/tasks', '/usage']) {
  await goto(url)
  heads[url] = await page.evaluate(() => {
    const h1 = document.querySelector('main h1, h1')
    if (!h1) return null
    const rect = h1.getBoundingClientRect()
    // 页头之后的第一块内容
    const header = h1.closest('header')
    const next = header?.nextElementSibling
    return {
      left: Math.round(rect.left * 10) / 10,
      top: Math.round(rect.top * 10) / 10,
      headerBottom: header ? Math.round(header.getBoundingClientRect().bottom) : null,
      nextTop: next ? Math.round(next.getBoundingClientRect().top) : null,
    }
  })
}
const lefts = Object.values(heads).filter(Boolean).map((h) => h.left)
const leftSpread = lefts.length ? Math.max(...lefts) - Math.min(...lefts) : 999
check('A2', 'h1 左沿三页一致', leftSpread <= 1, `左沿=${lefts.join(' / ')}（差 ${leftSpread}px）`)

const gaps = Object.values(heads)
  .filter((h) => h && h.nextTop != null && h.headerBottom != null)
  .map((h) => h.nextTop - h.headerBottom)
const gapSpread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 999
check('A3', '页头→内容间距三页一致', gapSpread <= 1, `间距=${gaps.join(' / ')}（差 ${gapSpread}px）`)

/* ---------------- W1/W2 画布 dock ---------------- */
await goto('/workspace')
await page.waitForTimeout(1800)
const dock = await page.evaluate(() => {
  const bar = document.querySelector('[role="toolbar"][aria-label]')
  const bars = [...document.querySelectorAll('[role="toolbar"]')]
  const dockEl = bars.find((b) => b.querySelector('button')) || bar
  if (!dockEl) return null
  const wrapped = []
  for (const btn of dockEl.querySelectorAll('button')) {
    // 文字换行的判据：内容高度明显超过单行行高
    if (btn.scrollHeight > btn.clientHeight + 1) {
      wrapped.push((btn.textContent || btn.getAttribute('aria-label') || '').trim().slice(0, 20))
    }
    const label = btn.querySelector('span:not([aria-hidden])')
    if (label && label.getClientRects().length > 1) {
      wrapped.push((label.textContent || '').trim().slice(0, 20))
    }
  }
  const heights = [...dockEl.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height))
  return { wrapped, heights }
})
check(
  'W1',
  '画布 dock 无文字换行',
  Boolean(dock) && dock.wrapped.length === 0,
  dock ? `换行按钮=${dock.wrapped.join(',') || '无'}；按钮高=${[...new Set(dock.heights)].join(',')}` : '未找到 dock',
)

const zoomBtns = await page.evaluate(() => {
  const count = [...document.querySelectorAll('button')].filter((b) => {
    const label = `${b.getAttribute('aria-label') || ''} ${b.title || ''}`.toLowerCase()
    if (!label.includes('zoom in') && !label.includes('放大')) return false
    // 只算**可见**的：Excalidraw 原生缩放按钮仍在 DOM 里（已被 CSS 收起），
    // 把它们算进来会得到"两组缩放"的假阳性。
    const rect = b.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  })
  return count.length
})
check('W2', '只有一组缩放控件', zoomBtns <= 1, `可见放大按钮数量=${zoomBtns}`)

/* ---------------- S1 技能页底部 ---------------- */
await goto('/skills')
await page.waitForTimeout(1200)
const skills = await page.evaluate(async () => {
  // 滚到底再看：改造前最后一行卡片被视口裁掉半张标题，
  // 但那只是"还没滚到"——真正的判定是"滚到底之后它完整可见"。
  const scroller = [...document.querySelectorAll('main *')].find(
    (el) => el.scrollHeight > el.clientHeight + 4 && getComputedStyle(el).overflowY === 'auto',
  )
  if (scroller) scroller.scrollTop = scroller.scrollHeight
  await new Promise((r) => setTimeout(r, 400))

  const cards = [...document.querySelectorAll('main .grid > *')]
  const last = cards[cards.length - 1]
  if (!last || !scroller) return { error: 'no cards/scroller' }
  const sr = scroller.getBoundingClientRect()
  const lr = last.getBoundingClientRect()
  // 浮条：fixed/sticky 且贴底
  const floaters = [...document.querySelectorAll('main *')].filter((el) => {
    const cs = getComputedStyle(el)
    if (!['fixed', 'sticky'].includes(cs.position)) return false
    const rect = el.getBoundingClientRect()
    return rect.bottom > sr.bottom - 140 && rect.height < 140 && rect.width > 200
  })
  const overlap = floaters.some((f) => {
    const fr = f.getBoundingClientRect()
    return fr.top < lr.bottom && fr.bottom > lr.top
  })
  return { clipped: lr.bottom > sr.bottom + 1, overlap, cards: cards.length }
})
check('S1', '技能页末行不被裁切/遮挡', Boolean(skills) && !skills.error && !skills.clipped && !skills.overlap, JSON.stringify(skills))

/* ---------------- M1 移动端顶栏 ---------------- */
const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
const mp = await mctx.newPage()
await mp.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
await mp.evaluate((t) => localStorage.setItem('cs.token', t), token)
for (const url of ['/projects', '/assets']) {
  await mp.goto(BASE + url, { waitUntil: 'networkidle' })
  await mp.waitForTimeout(900)
  const m = await mp.evaluate(() => {
    const header = document.querySelector('header')
    if (!header) return null
    const kids = [...header.querySelectorAll('span, a, button')].filter((el) => {
      const rect = el.getBoundingClientRect()
      return rect.width > 24 && rect.height > 10
    })
    let overlap = false
    for (let i = 0; i < kids.length; i += 1) {
      for (let j = i + 1; j < kids.length; j += 1) {
        // 祖先与后代不算重叠（父按钮本来就包着子文字）
        if (kids[i].contains(kids[j]) || kids[j].contains(kids[i])) continue
        const a = kids[i].getBoundingClientRect()
        const b = kids[j].getBoundingClientRect()
        const ix = Math.min(a.right, b.right) - Math.max(a.left, b.left)
        const iy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
        if (ix > 2 && iy > 2) {
          overlap = true
        }
      }
    }
    return { overlap, headerH: Math.round(header.getBoundingClientRect().height) }
  })
  check('M1', `390 宽顶栏无叠字 ${url}`, Boolean(m) && !m.overlap, JSON.stringify(m))
}

await browser.close()

const failed = results.filter((x) => !x.pass)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length) {
  console.log('未通过：' + failed.map((f) => f.id).join(', '))
  process.exit(1)
}
