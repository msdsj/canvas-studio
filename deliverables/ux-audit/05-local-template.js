const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:27180';
const SHOTS = path.join(__dirname, 'shots');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', storageState: path.join(__dirname, 'auth-state.json') });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console.error] ${m.text().slice(0, 200)}`); });

  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${SHOTS}/10-home-logged-in.png` });

  // 提交提示词（已有中转站阻断提示的会话在 workspace，这里从首页重新发一句）
  const editor = page.locator('textarea').first();
  await editor.click();
  await page.keyboard.type('画一只柴犬在春天的草地上奔跑，水彩风格', { delay: 15 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${SHOTS}/11-no-relay-again.png` });
  console.log('--- 再次未配置提交 ---\n' + (await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1800))));

  // 点「用本地模板先试一次」
  const localBtn = page.getByRole('button', { name: /本地模板/ });
  if (await localBtn.count()) {
    await localBtn.first().click();
    console.log('已点击本地模板按钮');
    await page.waitForTimeout(6000);
    await page.screenshot({ path: `${SHOTS}/12-local-template.png` });
    console.log('--- 本地模板结果 ---\n' + (await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2000))));
  } else {
    console.log('未找到本地模板按钮');
  }
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
