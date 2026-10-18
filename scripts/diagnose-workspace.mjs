#!/usr/bin/env node
/**
 * 抓取 /workspace 页面的浏览器控制台报错与异常堆栈。
 * 零依赖：Node 22+ 内置 WebSocket 直连 CDP。
 *
 * 用法：node scripts/diagnose-workspace.mjs [url]
 * 前置：Chrome 以 --remote-debugging-port=9222 启动
 */
const TARGET = process.argv[2] || 'http://127.0.0.1:27180/workspace'
const TOKEN = process.argv[3] || ''
const CDP = 'http://127.0.0.1:9222'

async function http(path) {
  const r = await fetch(CDP + path)
  return r.json()
}

async function main() {
  const version = await http('/json/version')
  const ws = new WebSocket(version.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const errors = []
  const logs = []

  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const msgId = ++id
      pending.set(msgId, { resolve, reject })
      ws.send(JSON.stringify({ id: msgId, method, params, sessionId }))
    })

  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      return
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      errors.push({
        text: d.text,
        desc: d.exception?.description || '',
        url: d.url,
        line: d.lineNumber,
        col: d.columnNumber,
      })
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '))
    }
  }

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  const s = (m, p) => send(m, p, sessionId)

  await s('Runtime.enable')
  await s('Page.enable')
  await s('Log.enable')

  // 先落同源页面，注入登录 token，再进目标路由（避免被重定向到 /login）
  if (TOKEN) {
    await s('Page.navigate', { url: 'http://127.0.0.1:27180/login' })
    await new Promise((r) => setTimeout(r, 2000))
    await s('Runtime.evaluate', {
      expression: `localStorage.setItem('cs.token', ${JSON.stringify(TOKEN)})`,
    })
  }

  await s('Page.navigate', { url: TARGET })

  // 等页面稳定 + error boundary 渲染
  await new Promise((r) => setTimeout(r, 9000))

  // 抓 error boundary 上可见的文本
  const probe = await s('Runtime.evaluate', {
    expression: `(() => {
      const t = document.body?.innerText || ''
      return { text: t.slice(0, 400), title: document.title, href: location.href }
    })()`,
    returnByValue: true,
  })

  console.log('=== 页面信息 ===')
  console.log(JSON.stringify(probe.result.value, null, 2))

  console.log('\n=== 未捕获异常 ===')
  if (!errors.length) console.log('(无)')
  for (const e of errors) {
    console.log(`- ${e.text}`)
    if (e.desc) console.log(e.desc.split('\n').slice(0, 12).map((l) => '    ' + l).join('\n'))
    if (e.url) console.log(`    at ${e.url}:${e.line}:${e.col}`)
  }

  console.log('\n=== console.error ===')
  if (!logs.length) console.log('(无)')
  for (const l of logs.slice(0, 10)) console.log('- ' + l.slice(0, 500))

  await send('Target.closeTarget', { targetId })
  ws.close()
}

main().catch((e) => {
  console.error('诊断脚本失败:', e.message)
  process.exit(1)
})
