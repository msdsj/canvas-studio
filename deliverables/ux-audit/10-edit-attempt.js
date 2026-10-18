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

  // 点图进入编辑层
  const canvasArea = await page.locator('.cs-canvas-shell').first().boundingBox();
  await page.mouse.click(canvasArea.x + canvasArea.width / 2, canvasArea.y + canvasArea.height / 2);
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/18-edit-open.png` });

  // 框选区域：从图内左上拖到右下
  await page.mouse.move(canvasArea.x + 140, canvasArea.y + 270);
  await page.mouse.down();
  await page.mouse.move(canvasArea.x + 300, canvasArea.y + 480, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(1800);
  await page.screenshot({ path: `${SHOTS}/19-region-drawn.png` });

  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 900));
  console.log('--- 框选后 ---\n' + txt);

  // 在区域气泡里填指令
  const ta = page.locator('textarea').last();
  await ta.click();
  await page.keyboard.type('把这片草地换成秋天的金黄色落叶', { delay: 12 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/20-region-prompt.png` });

  // 点生成
  await page.getByRole('button', { name: /^生成$/ }).last().click();
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${SHOTS}/21-edit-no-relay.png` });
  const txt2 = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1500));
  console.log('--- 无中转站编辑结果 ---\n' + txt2);
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
