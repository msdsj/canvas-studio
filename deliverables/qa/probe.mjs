import { connect, login, APP, sleep } from './harness.mjs'

const page = await connect()
await page.init()
try {
  await login(page)
  const info = await page.eval(`(() => {
    const keys = Object.keys(localStorage);
    const tokenKey = keys.find(k => /token|auth/i.test(k));
    return {
      url: location.href,
      localStorageKeys: keys,
      tokenKey,
      tokenPreview: tokenKey ? String(localStorage.getItem(tokenKey)).slice(0, 30) : null,
      buttons: [...document.querySelectorAll('button')].slice(0, 40).map(b => ({
        t: (b.textContent || '').trim().slice(0, 20),
        aria: b.getAttribute('aria-label'),
        title: b.getAttribute('title'),
      })).filter(b => b.t || b.aria || b.title),
    };
  })()`)
  console.log(JSON.stringify(info, null, 2))
  console.log('--- innerText head ---')
  const text = await page.eval(`document.body.innerText.slice(0, 1200)`)
  console.log(text)
  await page.screenshot('probe-01-workspace.png')
} catch (e) {
  console.error('PROBE FAIL', e.message)
  await page.screenshot('probe-error.png').catch(() => {})
} finally {
  page.ws.close()
}
await sleep(100)
process.exit(0)
