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
  await page.getByText(/未连接中转站/).first().click();
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /新增配置/ }).first().click();
  await page.waitForTimeout(600);

  const inputs = page.locator('[role="dialog"] input');
  await inputs.nth(0).fill('我的中转站');
  await inputs.nth(1).fill('https://fast.msdsj.site/v1');
  await inputs.nth(2).fill('sk-7218a6b713972dc1839482857d25c307b47c64788dafc905f6beb9fac05c0122');
  await inputs.nth(3).fill('gpt-6');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/41-relay-filled.png` });

  // 测试连接
  await page.getByRole('button', { name: /测试连接/ }).click();
  await page.waitForTimeout(8000);
  await page.screenshot({ path: `${SHOTS}/42-relay-test.png` });
  const testTxt = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText.replace(/\n{2,}/g, '\n').slice(0, 900) : '';
  });
  console.log('--- 测试后弹窗 ---\n' + testTxt);

  // 保存 + 设为当前
  await page.getByRole('button', { name: /^保存$/ }).click();
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: /设为当前/ }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/43-relay-active.png` });
  const after = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText.replace(/\n{2,}/g, '\n').slice(0, 900) : '';
  });
  console.log('--- 设为当前后 ---\n' + after);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/44-relay-done.png` });
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
