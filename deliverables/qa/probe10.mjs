import { connectExisting, sleep, trace } from './harness.mjs'
const page = await connectExisting()
// 在页面里直接打 /api/chat/analyze（走 vite 代理），看是否流式返回
const r = await page.eval(`(async () => {
  const token = localStorage.getItem('cs.token');
  const t0 = Date.now();
  try {
    const res = await fetch('/api/chat/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ session_id: 'a57e0e61-1ddd-440f-ba64-9dc3bc4c2c8c', content: '把背景换成白色', selection: { asset_id: null, width: 600, height: 600, regions: [{ index: 1, region: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 }, prompt: '换成白色背景', handler: 'restyle' }] } }),
    });
    const head = { status: res.status, ctype: res.headers.get('content-type'), ms: Date.now() - t0, hasBody: Boolean(res.body) };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', events = 0, firstByteMs = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteMs === null) firstByteMs = Date.now() - t0;
      buf += dec.decode(value, { stream: true });
      events = (buf.match(/"event":/g) || []).length;
    }
    reader.cancel();
    return { ...head, firstByteMs, events, tail: buf.slice(-160) };
  } catch (e) { return { error: String(e), ms: Date.now() - t0 }; }
})()`)
console.log(JSON.stringify(r, null, 1))
page.ws.close(); process.exit(0)
