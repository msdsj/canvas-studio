const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:27180';
const SHOTS = path.join(__dirname, 'shots');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 200)}`); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 输入并回车 → 弹窗
  const editor = page.locator('textarea').first();
  await editor.click();
  await page.keyboard.type('画一只柴犬在春天的草地上奔跑，水彩风格', { delay: 15 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);

  // 检查 tab 状态
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"] [role="tab"], [role="dialog"] button')).map((b) => ({
      text: b.innerText.trim(), selected: b.getAttribute('aria-selected') || b.getAttribute('data-state') || '',
    }))
  );
  console.log('--- tab 状态 ---', JSON.stringify(tabs));

  // 注册
  const email = 'uxaudit' + Date.now() + '@test.com';
  console.log('注册邮箱:', email);
  await page.locator('[role="dialog"] input').nth(0).fill(email);
  await page.locator('[role="dialog"] input').nth(1).fill('体验走查员');
  await page.locator('[role="dialog"] input').nth(2).fill('Test@12345');
  await page.locator('[role="dialog"] input').nth(3).fill('Test@12345');
  await page.screenshot({ path: `${SHOTS}/05-register-filled.png` });
  await page.getByRole('button', { name: /创建账号/ }).click();
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${SHOTS}/06-after-register.png` });
  console.log('注册后 url:', page.url());

  // 观察是否自动续跑：页面文本
  const bodyText = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2000));
  console.log('--- 注册后页面文本 ---\n' + bodyText);

  // 保存登录态供后续脚本使用
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  console.log('已保存登录态');
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
