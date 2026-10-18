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
  await page.getByText(/未连接中转站|点此配置/).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/45-relay-state.png` });
  const t1 = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText.replace(/\n{2,}/g, '\n').slice(0, 600) : '';
  });
  console.log('--- 当前弹窗状态 ---\n' + t1);
  // 点左侧列表中的配置
  const item = page.getByText('我的中转站').first();
  if (await item.count()) { await item.click(); await page.waitForTimeout(1000); }
  await page.screenshot({ path: `${SHOTS}/46-relay-selected.png` });
  // 设为当前
  const setBtn = page.getByRole('button', { name: /设为当前/ });
  console.log('设为当前按钮数:', await setBtn.count(), '可用:', await setBtn.first().isEnabled().catch(() => '-'));
  if (await setBtn.count() && await setBtn.first().isEnabled()) {
    await setBtn.first().click();
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: `${SHOTS}/47-relay-activated.png` });
  const t2 = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText.replace(/\n{2,}/g, '\n').slice(0, 600) : '';
  });
  console.log('--- 激活后 ---\n' + t2);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/48-relay-final.png` });
  const status = await page.evaluate(() => (document.body.innerText.match(/[^\n]*中转站[^\n]*/) || [])[0]);
  console.log('对话面板中转站状态:', status);
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
