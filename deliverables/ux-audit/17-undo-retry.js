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
  // 撤销误拖（点两次撤销）
  await page.mouse.click(463, 856);
  await page.waitForTimeout(800);
  await page.mouse.click(463, 856);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/34-after-undo.png` });
  const pill = await page.evaluate(() => !!document.querySelector('.scroll-back-to-content'));
  console.log('撤销后仍有回到内容胶囊:', pill);
  // 点图
  await page.mouse.click(632, 407);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/35-click-after-undo.png` });
  console.log('编辑层打开:', await page.evaluate(() => document.body.innerText.includes('当前图片')));
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
