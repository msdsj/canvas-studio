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
  await page.screenshot({ path: `${SHOTS}/27-before-click.png` });
  // 精确点图片中心（视口坐标 632, 407）
  await page.mouse.click(632, 407);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/28-after-click.png` });
  const has = await page.evaluate(() => document.body.innerText.includes('当前图片'));
  console.log('编辑层打开:', has);
  // 看一下画布上 excalidraw 的选中态
  const sel = await page.evaluate(() => {
    const c = document.querySelector('.excalidraw');
    return c ? c.getAttribute('data-selected') || 'no-attr' : 'no-excalidraw';
  });
  console.log('excalidraw:', sel);
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
