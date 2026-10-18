const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:27180';
const SHOTS = path.join(__dirname, 'shots');
const SESSION = '9f4bb9c8-50fa-4fb9-af1c-e01f7cb1426f';
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', storageState: path.join(__dirname, 'auth-state.json') });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 150)); });
  await page.goto(`${BASE}/workspace?session=${SESSION}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);
  // JS 恢复视图（真实用户点不到，这里仅为继续走查）
  await page.evaluate(() => document.querySelector('.scroll-back-to-content')?.click());
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/29-view-recovered2.png` });

  // 点图进入编辑层
  await page.mouse.click(632, 407);
  await page.waitForFunction(() => document.body.innerText.includes('当前图片'), null, { timeout: 8000 });
  console.log('编辑层打开');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/30-edit-ready2.png` });

  // 框选（图内 drag）
  await page.mouse.move(520, 320);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.move(560, 350, { steps: 4 });
  await page.mouse.move(740, 520, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${SHOTS}/31-region-drawn3.png` });
  const cnt = await page.evaluate(() => (document.body.innerText.match(/(\d+) 区域 · (\d+) 标注/) || [])[0]);
  console.log('区域计数:', cnt || '(无)');

  // 填指令
  const ta = page.locator('[data-region-bubble] textarea, textarea').last();
  await ta.click();
  await page.keyboard.type('把这片草地换成秋天的金黄色落叶', { delay: 12 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/32-region-prompt2.png` });

  // 生成
  await page.getByRole('button', { name: /^生成$/ }).last().click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/33-edit-no-relay2.png` });
  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1200));
  console.log('--- 无中转站编辑 ---\n' + txt.slice(0, 1200));
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
