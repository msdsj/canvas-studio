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

  const ca = await page.locator('.cs-canvas-shell').first().boundingBox();
  await page.mouse.click(ca.x + ca.width / 2, ca.y + ca.height / 2);
  // 等编辑层就绪
  await page.waitForFunction(() => document.body.innerText.includes('当前图片'), null, { timeout: 8000 });
  console.log('编辑层已就绪');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/25-edit-ready.png` });

  // 小步慢拖，先按下停顿再移动（模拟真人）
  await page.mouse.move(ca.x + 160, ca.y + 300);
  await page.mouse.down();
  await page.waitForTimeout(120);
  await page.mouse.move(ca.x + 200, ca.y + 330, { steps: 5 });
  await page.waitForTimeout(80);
  await page.mouse.move(ca.x + 320, ca.y + 490, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/26-region-drawn2.png` });
  const t = await page.evaluate(() => document.body.innerText.match(/\d+ 区域 · \d+ 标注/));
  console.log('区域计数:', t ? t[0] : '(未见计数，编辑层可能未开)');
  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 500));
  console.log('--- 拖后简文本 ---\n' + txt.slice(0, 500));
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
