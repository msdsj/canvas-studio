const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:27180';
const SHOTS = path.join(__dirname, 'shots');
const TOKEN = 'xXMp1tANakOUOslZpSUlM5gqHnYhgZsExGBFLZ5eN-4';
const EMAIL = 'uxaudit1792297828789@test.com';
const PWD = 'Test@12345';

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 200)}`); });

  // 1. 打开邮箱验证链接（模拟用户点邮件）
  await page.goto(`${BASE}/verify-email?token=${TOKEN}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/07-verify-email.png` });
  console.log('--- 验证页文本 ---\n' + (await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 600))));

  // 2. 回首页，输入提示词，回车 → 弹窗；切到登录 tab
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);
  const editor = page.locator('textarea').first();
  await editor.click();
  await page.keyboard.type('画一只柴犬在春天的草地上奔跑，水彩风格', { delay: 15 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // 切到登录 tab
  await page.getByRole('button', { name: '登录', exact: true }).nth(-1).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${SHOTS}/08-login-tab.png` });

  // 3. 登录
  const inputs = page.locator('[role="dialog"] input');
  await inputs.nth(0).fill(EMAIL);
  await inputs.nth(1).fill(PWD);
  await page.getByRole('button', { name: /^登录$/ }).last().click();
  await page.waitForTimeout(4000);
  console.log('登录后 url:', page.url());
  await page.screenshot({ path: `${SHOTS}/09-logged-in-continue.png` });

  // 4. 观察是否自动进入工作区并自动提交
  const bodyText = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2500));
  console.log('--- 登录后页面文本 ---\n' + bodyText);

  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  console.log('已保存登录态');
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
