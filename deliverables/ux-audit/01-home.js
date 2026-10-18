// 公共启动器：真实用户视角走查 canvas-studio
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:27180';
const SHOTS = require('path').join(__dirname, 'shots');

async function launch() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
  });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' || m.type() === 'warning') console.log(`[console.${m.type()}] ${t.slice(0, 300)}`);
  });
  page.on('pageerror', (e) => console.log(`[pageerror] ${String(e).slice(0, 300)}`));
  return { browser, ctx, page };
}

(async () => {
  const { browser, ctx, page } = await launch();
  const t0 = Date.now();
  await page.goto(BASE, { waitUntil: 'networkidle', timeout: 30000 });
  console.log(`goto耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await page.waitForTimeout(1500); // 等待入场动效
  await page.screenshot({ path: `${SHOTS}/01-home.png` });
  console.log('title:', await page.title());
  console.log('url:', page.url());
  // 输出首屏关键文本
  const text = await page.evaluate(() => document.body.innerText.replace(/\n{2,}/g, '\n').slice(0, 1500));
  console.log('--- 首屏文本 ---\n' + text);
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
