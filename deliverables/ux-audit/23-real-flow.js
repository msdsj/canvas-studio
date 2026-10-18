const { chromium } = require('playwright');
const path = require('path');
const BASE = 'http://127.0.0.1:27180';
const SHOTS = path.join(__dirname, 'shots');
(async () => {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', storageState: path.join(__dirname, 'auth-state.json') });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('[err]', m.text().slice(0, 150)); });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 新对话
  await page.getByText('新对话', { exact: true }).first().click();
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/49-new-session.png` });
  console.log('新对话 url:', page.url());

  // 输入明确需求
  const editor = page.locator('textarea').first();
  await editor.click();
  await page.keyboard.type('画一只橘猫坐在窗台上晒太阳，午后暖光，摄影感', { delay: 15 });
  await page.screenshot({ path: `${SHOTS}/50-typing-real.png` });
  await page.keyboard.press('Enter');

  // 观察 compose 过程
  for (let i = 0; i < 9; i++) {
    await page.waitForTimeout(5000);
    const t = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n'));
    const steps = (t.match(/\d\/\d · \d+s/g) || []).join(' | ');
    const phase = (t.match(/分析中|思考中|排版中|生成中|已完成|失败|歧义|澄清|clarify/g) || []).join(',');
    const quota = (t.match(/额度 (\d+)/) || [])[1];
    console.log(`t=${(i + 1) * 5}s 步骤:${steps || '-'} 阶段:${phase || '-'} 额度:${quota}`);
    if (/已完成|失败/.test(t) && i > 2) break;
  }
  await page.screenshot({ path: `${SHOTS}/51-real-result.png` });
  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2600));
  console.log('--- 真实流程结果 ---\n' + txt);
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
