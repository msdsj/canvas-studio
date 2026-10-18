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
  await page.waitForTimeout(2000);
  // 轮询等待任务完成（最多 150s）
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(10000);
    const t = await page.evaluate(() => document.body.innerText);
    const done = /生成完成|已生成|任务完成|失败/.test(t);
    const imgs = await page.evaluate(() => document.querySelectorAll('canvas, img').length);
    console.log(`t=${(i + 1) * 10}s 含完成关键词:${done} canvas/img元素:${imgs} 额度:${(t.match(/额度 (\d+)/) || [])[1]}`);
    if (done) break;
  }
  await page.screenshot({ path: `${SHOTS}/15-image-on-canvas.png` });
  const txt = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 2000));
  console.log('--- 生成后文本 ---\n' + txt);
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
