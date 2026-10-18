import { connectExisting, login, authLogin, sleep, trace, APP } from './harness.mjs'
const page = await connectExisting()
const token = await authLogin()
for (const theme of ['dark', 'light']) {
  await page.eval(`localStorage.setItem('cs.theme','${theme}'); true`)
  await login(page, { token, url: `${APP}/workspace?session=ca59307c-c995-41ea-af63-74954bba1cbb`, waitCanvas: true })
  await sleep(3000)
  // 把会话区滚到顶部：让「分析卡 + 方案选择」完整入镜
  await page.eval(`(() => {
    const scrollers = [...document.querySelectorAll('div')].filter(d => {
      const st = getComputedStyle(d);
      return /(auto|scroll)/.test(st.overflowY) && d.scrollHeight > d.clientHeight + 50 && d.clientWidth < 500;
    });
    scrollers.forEach(d => { d.scrollTop = 0; });
    return scrollers.length;
  })()`)
  await sleep(900)
  await page.screenshot(`H-0${theme === 'dark' ? 4 : 5}-${theme}-full-card.png`)
  trace(`shot ${theme}`)
}
page.ws.close(); process.exit(0)
