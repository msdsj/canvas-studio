const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:27180';
const SHOTS = path.join(__dirname, 'shots');
const SESSION = '9f4bb9c8-50fa-4fb9-af1c-e01f7cb1426f';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', storageState: path.join(__dirname, 'auth-state.json') });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/workspace?session=${SESSION}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  // 列出底部工具栏按钮的 title/aria
  const btns = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('button[title], button[aria-label]').forEach((b) => {
      const r = b.getBoundingClientRect();
      if (r.bottom > 820 && r.width > 0) out.push({ t: b.title || b.getAttribute('aria-label'), x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
    });
    return out;
  });
  console.log(JSON.stringify(btns, null, 1));
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
