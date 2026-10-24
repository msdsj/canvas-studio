#!/usr/bin/env node
/**
 * 全站视觉巡检（可复用）
 *
 * 用法：
 *   node scripts/visual-audit.mjs                       # 亮色，输出 /tmp/cs-audit
 *   node scripts/visual-audit.mjs --theme both          # 亮 + 暗
 *   node scripts/visual-audit.mjs --mobile              # 追加 390×844
 *   node scripts/visual-audit.mjs --out deliverables/qa/shots-2026-10-24
 *   node scripts/visual-audit.mjs --only workspace,assets
 *
 * 它会做四件事：
 *   1. 登录拿 token（走真实 /api/auth/login，账号默认 admin@canvas.studio）
 *   2. 逐路由截图（视口图 + 可选整页图）
 *   3. 采集：console error / page error / 横向溢出 / 越界元素 / 无限动画清单
 *   4. 汇总成 report.json + 控制台表格，非零退出码表示有 error 或溢出
 *
 * playwright 解析顺序：项目 node_modules → WorkBuddy 托管 workspace。
 * 两者都没有时给出安装提示，不做静默降级。
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function resolvePlaywright() {
  const candidates = [
    path.join(ROOT, 'frontend/node_modules/playwright'),
    path.join(ROOT, 'node_modules/playwright'),
    '/Users/meishiduoshuijiao/.workbuddy/binaries/node/workspace/node_modules/playwright',
  ]
  for (const dir of candidates) {
    if (existsSync(dir)) return dir
  }
  console.error(
    '找不到 playwright。请在 frontend/ 下 npm i -D playwright，或确认托管 workspace 已安装。',
  )
  process.exit(2)
}

const pwDir = resolvePlaywright()
const { chromium } = await import(path.join(pwDir, 'index.mjs'))

/* ------------------------------- 参数 ------------------------------- */
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 ? argv[i + 1] : fallback
}
const has = (name) => argv.includes(`--${name}`)

const BASE = flag('base', process.env.CS_BASE || 'http://127.0.0.1:27180')
const API = flag('api', process.env.CS_API || 'http://127.0.0.1:27181')
const EMAIL = flag('email', process.env.CS_EMAIL || 'admin@canvas.studio')
const PASSWORD = flag('password', process.env.CS_PASSWORD || 'Admin@12345')
const OUT = path.resolve(flag('out', '/tmp/cs-audit'))
const THEME = flag('theme', 'light') // light | dark | both
const FULL = has('full')
const MOBILE = has('mobile')
const only = flag('only', '')
  ? flag('only', '').split(',').map((s) => s.trim())
  : null

const ROUTES = [
  ['home', '/'],
  ['workspace', '/workspace'],
  ['projects', '/projects'],
  ['assets', '/assets'],
  ['tasks', '/tasks'],
  ['skills', '/skills'],
  ['usage', '/usage'],
  ['settings', '/settings'],
  ['team', '/team'],
  ['team-members', '/team/members'],
  ['team-settings', '/team/settings'],
  ['team-audit', '/team/audit'],
  ['admin', '/admin'],
  ['admin-users', '/admin/users'],
  ['admin-pool', '/admin/pool'],
  ['admin-config', '/admin/config'],
  ['admin-invites', '/admin/invites'],
  ['admin-announcements', '/admin/announcements'],
  ['admin-logs', '/admin/logs'],
  ['admin-pro-codes', '/admin/pro-codes'],
  ['onboarding', '/onboarding'],
].filter(([name]) => !only || only.includes(name))

const themes = THEME === 'both' ? ['light', 'dark'] : [THEME]

/* ------------------------------- 登录 ------------------------------- */
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
if (!loginRes.ok) {
  console.error(`登录失败 ${loginRes.status}：${await loginRes.text()}`)
  process.exit(2)
}
const token = (await loginRes.json())?.data?.access_token
if (!token) {
  console.error('登录响应里没有 access_token')
  process.exit(2)
}

mkdirSync(OUT, { recursive: true })
const browser = await chromium.launch()

/* --------------------------- 采集单页 --------------------------- */
async function visit(page, name, url, theme, suffix) {
  const errors = []
  const onConsole = (m) => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 400))
  }
  const onPageError = (e) => errors.push(`PAGEERROR: ${String(e).slice(0, 400)}`)
  page.on('console', onConsole)
  page.on('pageerror', onPageError)

  await page.goto(BASE + url, { waitUntil: 'networkidle', timeout: 45_000 }).catch(() => {})
  await page.evaluate((t) => {
    localStorage.setItem('cs.theme', t)
    document.documentElement.setAttribute('data-theme', t)
  }, theme)
  await page.waitForTimeout(1500)

  const probe = await page.evaluate(() => {
    const de = document.documentElement
    const vw = de.clientWidth
    const offscreen = []
    for (const el of document.querySelectorAll('body *')) {
      const rect = el.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.right <= vw + 2) continue
      const cs = getComputedStyle(el)
      if (cs.position === 'fixed') continue
      if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') continue
      offscreen.push({
        tag: el.tagName.toLowerCase(),
        cls: String(el.className || '').slice(0, 90),
        right: Math.round(rect.right),
      })
    }
    const infinite = new Map()
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el)
      if (cs.animationName === 'none') continue
      if (Number(cs.animationIterationCount) !== Infinity) continue
      const key = cs.animationName
      infinite.set(key, (infinite.get(key) ?? 0) + 1)
    }
    return {
      overflow: de.scrollWidth - de.clientWidth,
      offscreen: offscreen.slice(0, 8),
      infiniteAnimations: [...infinite.entries()].map(([name, count]) => ({ name, count })),
      h1: document.querySelector('h1')?.textContent?.trim().slice(0, 80) ?? null,
      // 首屏「看起来空不空」：内容区文字总长度，作为信息密度参考
      textLength: (document.body.innerText || '').replace(/\s+/g, '').length,
    }
  })

  const file = path.join(OUT, `${theme}-${name}${suffix}.png`)
  await page.screenshot({ path: file, fullPage: FULL })
  page.off('console', onConsole)
  page.off('pageerror', onPageError)

  const uniqueErrors = [...new Set(errors)]
  return {
    theme,
    name,
    url,
    file,
    ...probe,
    errors: uniqueErrors.slice(0, 6),
    errorCount: uniqueErrors.length,
  }
}

const report = []

/* --------------------------- 桌面 --------------------------- */
for (const theme of themes) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
  })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((t) => {
    localStorage.setItem('cs.token', t)
    localStorage.setItem('cs.theme', 'light')
  }, token)

  for (const [name, url] of ROUTES) {
    const row = await visit(page, name, url, theme, '')
    report.push(row)
    const bad = row.errorCount > 0 || row.overflow > 0 || row.offscreen.length > 0
    console.log(
      `${bad ? '!' : '·'} ${theme.padEnd(5)} ${name.padEnd(22)} ` +
        `err=${row.errorCount} overflow=${row.overflow} off=${row.offscreen.length} ` +
        `anim=${row.infiniteAnimations.length} text=${row.textLength}`,
    )
  }
  await ctx.close()
}

/* --------------------------- 移动端 --------------------------- */
if (MOBILE) {
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
  await page.evaluate((t) => localStorage.setItem('cs.token', t), token)

  for (const [name, url] of ROUTES.filter(([n]) =>
    ['home', 'workspace', 'projects', 'assets', 'tasks', 'settings', 'usage'].includes(n),
  )) {
    const row = await visit(page, name, url, 'light', '-mobile')
    report.push(row)
    const bad = row.errorCount > 0 || row.overflow > 0
    console.log(
      `${bad ? '!' : '·'} mobile ${name.padEnd(22)} err=${row.errorCount} overflow=${row.overflow}`,
    )
  }
  await ctx.close()
}

await browser.close()

const failing = report.filter((r) => r.errorCount > 0 || r.overflow > 0)
writeFileSync(
  path.join(OUT, 'report.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, report }, null, 2),
)

console.log(`\n截图与报告：${OUT}`)
if (failing.length) {
  console.log(`\n有 ${failing.length} 个页面存在错误或溢出：`)
  for (const r of failing) {
    console.log(` - ${r.theme}/${r.name} errors=${r.errorCount} overflow=${r.overflow}`)
    for (const e of r.errors) console.log(`     ${e}`)
  }
  process.exit(1)
}
console.log('全部页面：0 控制台错误、0 横向溢出。')
