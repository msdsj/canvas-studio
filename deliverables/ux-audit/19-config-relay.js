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

  // 打开中转站配置
  const cfg = page.getByText(/未连接中转站/);
  await cfg.first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/39-relay-dialog.png` });
  const dlgTxt = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return d ? d.innerText.replace(/\n{2,}/g, '\n').slice(0, 1500) : '(no dialog)';
  });
  console.log('--- 中转站配置弹窗 ---\n' + dlgTxt);

  // 点「新增配置」
  const add = page.getByRole('button', { name: /新增配置/ });
  await add.first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/40-relay-form.png` });

  // 填表单
  const inputs = page.locator('[role="dialog"] input, [role="dialog"] textarea');
  const n = await inputs.count();
  console.log('表单字段数:', n);
  const labels = await page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="dialog"] label, [role="dialog"] [data-slot="label"]')).map((l) => l.innerText.trim())
  );
  console.log('字段标签:', JSON.stringify(labels));
  for (let i = 0; i < n; i++) {
    const ph = await inputs.nth(i).getAttribute('placeholder');
    console.log(`  input[${i}] placeholder=${ph}`);
  }
  await ctx.storageState({ path: path.join(__dirname, 'auth-state.json') });
  await browser.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
