const { chromium } = require('playwright');
const path = require('path');
const BASE = process.env.CS_BASE_URL || 'http://127.0.0.1:27180';
const SHOTS = path.join(__dirname, 'shots');
const SESSION = process.env.CS_SESSION_ID;
const RELAY_NAME = process.env.CS_RELAY_NAME;
const RELAY_BASE_URL = process.env.CS_RELAY_BASE_URL;
const RELAY_MODEL = process.env.CS_RELAY_MODEL;
const RELAY_API_KEY = process.env.CS_RELAY_API_KEY;

for (const [name, value] of Object.entries({ CS_SESSION_ID: SESSION, CS_RELAY_NAME: RELAY_NAME, CS_RELAY_BASE_URL: RELAY_BASE_URL, CS_RELAY_MODEL: RELAY_MODEL, CS_RELAY_API_KEY: RELAY_API_KEY })) {
  if (!value) throw new Error(`Set ${name} before running this script.`);
}
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
  await inputs.nth(0).fill(RELAY_NAME);
  await inputs.nth(1).fill(RELAY_BASE_URL);
  await inputs.nth(2).fill(RELAY_API_KEY);
  await inputs.nth(3).fill(RELAY_MODEL);
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
