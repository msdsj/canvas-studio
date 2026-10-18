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
  // 用 JS 强制点击（绕过遮挡测试可恢复性）
  const r = await page.evaluate(() => {
    const btn = document.querySelector('.scroll-back-to-content');
    if (btn) { btn.click(); return 'clicked via JS'; }
    return 'not found';
  });
  console.log('强制点击:', r);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/24-recovered.png` });
  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 700));
  console.log('--- JS 恢复后 ---\n' + txt);
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
