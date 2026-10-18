const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:27180';
const SHOTS = path.join(__dirname, 'shots');

(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 1. 未登录直接输入并回车
  const editor = page.locator('textarea, [contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.type('画一只柴犬在春天的草地上奔跑，水彩风格', { delay: 20 });
  await page.screenshot({ path: `${SHOTS}/02-typing.png` });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/03-auth-dialog.png` });

  // 输出弹窗结构
  const dlg = await page.evaluate(() => {
    const el = document.querySelector('[role="dialog"], [data-state="open"]');
    return el ? el.innerText.replace(/\n{2,}/g, '\n').slice(0, 1200) : '(no dialog)';
  });
  console.log('--- 登录弹窗内容 ---\n' + dlg);

  // 找注册/login tab 切换
  const tabTexts = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"] button, [role="dialog"] a')).map((b) => b.innerText.trim()).filter(Boolean)
  );
  console.log('--- 弹窗按钮 ---', JSON.stringify(tabTexts));

  // 2. 关闭弹窗，检查输入内容是否保留
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  const kept = await page.evaluate(() => {
    const el = document.querySelector('textarea, [contenteditable="true"]');
    return el ? (el.value || el.innerText || '').trim() : '(not found)';
  });
  console.log('--- 关闭弹窗后输入框内容 ---\n' + kept);
  await page.screenshot({ path: `${SHOTS}/04-content-kept.png` });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
