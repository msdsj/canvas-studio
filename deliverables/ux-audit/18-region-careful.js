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
  // 1) JS 恢复
  await page.evaluate(() => document.querySelector('.scroll-back-to-content')?.click());
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${SHOTS}/36-recovered-final.png` });
  // 2) 点图
  await page.mouse.click(632, 407);
  await page.waitForTimeout(3000);
  const opened = await page.evaluate(() => document.body.innerText.includes('当前图片'));
  console.log('编辑层打开:', opened);
  await page.screenshot({ path: `${SHOTS}/37-edit-open-final.png` });
  if (!opened) { await browser.close(); return; }
  // 3) 框选
  await page.mouse.move(520, 320);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.move(560, 350, { steps: 4 });
  await page.mouse.move(740, 520, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/38-region-final.png` });
  const cnt = await page.evaluate(() => (document.body.innerText.match(/(\d+) 区域 · (\d+) 标注/) || [])[0]);
  console.log('区域计数:', cnt || '(无)');
  const pill = await page.evaluate(() => !!document.querySelector('.scroll-back-to-content'));
  console.log('拖后出现回到内容胶囊(被移出视野):', pill);
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
