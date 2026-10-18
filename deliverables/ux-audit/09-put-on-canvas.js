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

  // 1. 放入画布
  const putBtn = page.getByRole('button', { name: /放入画布/ });
  console.log('放入画布按钮:', await putBtn.count());
  await putBtn.first().click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/16-put-on-canvas.png` });

  // 2. 点击画布上的图片 → 编辑层
  // 画布中央区域找图片元素
  const canvasArea = page.locator('.cs-canvas-shell, [data-canvas-root]').first();
  const box = await canvasArea.boundingBox().catch(() => null);
  console.log('画布区域:', JSON.stringify(box));
  // 直接点画布中心附近（图应在中心）
  if (box) {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOTS}/17-edit-layer.png` });
    const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1600));
    console.log('--- 点图后文本 ---\n' + txt);
  }
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
