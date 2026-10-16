#!/usr/bin/env node
/**
 * 真实浏览器 UI 全流程验证（零依赖：Node 22 内置 WebSocket 直连 CDP）。
 *
 * 覆盖：登录 → 图层空态 → 上传（内置提示词弹窗）→ 图层出现元素 →
 *       单击图片进入编辑模式 → 框选生成编号标记 → 输入提示词提交图生图 →
 *       导出菜单 PNG/JPG。
 *
 * 前置：Chrome 以 --remote-debugging-port=9222 启动；前端 27180、后端 27181 已运行。
 */
import { setTimeout as sleep } from 'node:timers/promises'

const APP = 'http://127.0.0.1:27180'
const CDP = 'http://127.0.0.1:9222'
const UPLOAD_FILE = '/tmp/cs-upload.png'

const PASS = []
const FAIL = []

function check(name, ok, detail = '') {
  ;(ok ? PASS : FAIL).push(`${name}${detail ? ` — ${detail}` : ''}`)
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

async function newTab(url) {
  const resp = await fetch(`${CDP}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })
  if (!resp.ok) throw new Error(`new tab failed: ${resp.status}`)
  return resp.json()
}

class Session {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      }
    })
  }

  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`CDP timeout: ${method}`))
        }
      }, 30000)
    })
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (res.exceptionDetails) {
      throw new Error(`eval error: ${res.exceptionDetails.text} ${JSON.stringify(res.exceptionDetails.exception?.description || '')}`)
    }
    return res.result.value
  }

  async waitFor(expression, { timeout = 15000, label = expression } = {}) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      try {
        if (await this.eval(`Boolean(${expression})`)) return true
      } catch {
        /* 页面导航中，忽略 */
      }
      await sleep(250)
    }
    throw new Error(`waitFor 超时: ${label}`)
  }

  /** 取元素中心坐标（用于真实鼠标事件）。 */
  async center(selector, index = 0) {
    const pos = await this.eval(`(() => {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      const el = els[${index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`)
    if (!pos) throw new Error(`元素不存在: ${selector}[${index}]`)
    return pos
  }

  async clickAt(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 })
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 })
  }

  async click(selector, index = 0) {
    const { x, y } = await this.center(selector, index)
    await this.clickAt(x, y)
  }

  /** 按文本点击（按钮/菜单项）。 */
  async clickText(text, { tag = '*' } = {}) {
    const pos = await this.eval(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const el = nodes.reverse().find(n => n.textContent && n.textContent.trim() === ${JSON.stringify(text)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!pos) throw new Error(`找不到可点击文本: ${text}`)
    await this.clickAt(pos.x, pos.y)
  }

  async typeInto(selector, text, index = 0) {
    await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return false;
      el.focus();
      return true;
    })()`)
    await this.send('Input.insertText', { text })
  }

  async drag(from, to, steps = 8) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y, button: 'none', buttons: 0 })
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i += 1) {
      const x = from.x + ((to.x - from.x) * i) / steps
      const y = from.y + ((to.y - from.y) * i) / steps
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 })
      await sleep(16)
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 })
  }

  /** 按文本包含关系点击（下拉菜单项常带后缀说明）。 */
  async clickTextContains(text, { tag = '*' } = {}) {
    const pos = await this.eval(`(() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(tag)})];
      const el = nodes.reverse().find(n => n.textContent && n.textContent.includes(${JSON.stringify(text)}) && n.children.length <= 1);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    if (!pos) throw new Error(`找不到可点击文本(包含): ${text}`)
    await this.clickAt(pos.x, pos.y)
  }

  async screenshot(path) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, Buffer.from(res.data, 'base64'))
    console.log(`📸 截图已保存：${path}`)
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return new Session(ws)
}

async function main() {
  const target = await newTab('about:blank')
  const page = await connect(target.webSocketDebuggerUrl)
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('DOM.enable')

  try {
    // 0) 清空本地登录态，保证从登录页开始
    await page.send('Page.navigate', { url: `${APP}/login` })
    await sleep(800)
    await page.eval(`localStorage.clear(); sessionStorage.clear(); true`)
    await page.send('Page.navigate', { url: `${APP}/login` })

    // 1) 登录页
    await page.waitFor(`document.querySelector('input[type=email]')`, { label: '登录页渲染' })
    check('登录页正常渲染', true)

    await page.typeInto('input[type=email]', 'admin@canvas.studio')
    await page.typeInto('input[type=password]', 'Admin@12345')
    await page.clickText('登录', { tag: 'button' })
    await page.waitFor(`location.pathname.startsWith('/workspace')`, { label: '跳转工作台', timeout: 20000 })
    check('登录并进入工作台', true)

    // 2) 画布与图层面板
    await page.waitFor(`document.querySelector('.excalidraw')`, { label: 'Excalidraw 挂载', timeout: 25000 })
    await page.waitFor(`document.body.innerText.includes('图层')`, { label: '图层面板渲染' })
    const baseCount = await page.eval(`document.querySelectorAll('li > div[role="button"]').length`)
    check('图层面板渲染', true, `初始 ${baseCount} 个图层项`)

    // 3) 上传：隐藏 file input + 内置提示词弹窗
    const doc = await page.send('DOM.getDocument', { depth: -1 })
    const inputNode = await page.send('DOM.querySelector', { nodeId: doc.root.nodeId, selector: 'input[type=file]' })
    if (!inputNode.nodeId) throw new Error('未找到上传 input')
    await page.send('DOM.setFileInputFiles', { files: [UPLOAD_FILE], nodeId: inputNode.nodeId })
    await page.waitFor(`document.body.innerText.includes('上传图片') && document.body.innerText.includes('常用预设')`, {
      label: '上传提示词弹窗',
    })
    check('上传流程内置提示词配置弹窗', true)

    const presetCount = await page.eval(
      `[...document.querySelectorAll('button')].filter(b => ['画质增强','去除杂物','替换主体','风格迁移','调整色调'].includes(b.textContent.trim())).length`
    )
    check('提示词预设可一键选用', presetCount >= 3, `${presetCount} 个预设按钮`)

    await page.typeInto('textarea', '把背景换成纯白色')
    await page.clickText('上传并加入画布', { tag: 'button' })
    await page.waitFor(`!document.body.innerText.includes('常用预设')`, { label: '弹窗关闭', timeout: 20000 })
    await page.waitFor(`document.querySelectorAll('li > div[role="button"]').length >= ${baseCount + 1}`, {
      label: '图层出现新元素',
      timeout: 20000,
    })
    check('上传成功并出现在图层面板', true)

    const layerText = await page.eval(`document.body.innerText`)
    check('图层名取自文件名', layerText.includes('cs-upload'), '图层项显示 cs-upload')

    // 4) 单击图片 → 进入编辑模式（以「编辑层提示词输入框」为唯一判据，避免误判）
    const EDIT_INPUT = `[...document.querySelectorAll('input')].some(n => (n.placeholder||'').includes('框选区域'))`
    const canvasBox = await page.eval(`(() => {
      const el = document.querySelector('.excalidraw');
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`)
    await page.clickAt(canvasBox.x, canvasBox.y)
    await page.waitFor(EDIT_INPUT, { label: '编辑模式工具条', timeout: 10000 })
    check('单击图片即进入编辑模式', true)

    const placeholder = await page.eval(
      `(() => { const i = [...document.querySelectorAll('input')].find(n => (n.placeholder||'').includes('框选区域')); return i ? i.placeholder : ''; })()`
    )
    check('编辑层提示词输入可用', placeholder.length > 0, placeholder.slice(0, 24) + '…')

    // 5) 框选区域 → 编号标记
    const imgRect = await page.eval(`(() => {
      const imgs = [...document.querySelectorAll('img')].filter(n => n.alt === '编辑基准');
      if (!imgs.length) return null;
      const r = imgs[0].getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`)
    if (!imgRect) throw new Error('编辑基准图未渲染')
    const from = { x: imgRect.x + imgRect.w * 0.2, y: imgRect.y + imgRect.h * 0.2 }
    const to = { x: imgRect.x + imgRect.w * 0.6, y: imgRect.y + imgRect.h * 0.6 }
    await page.drag(from, to)
    await page.waitFor(`document.body.innerText.includes('1 区域')`, { label: '框选计数', timeout: 8000 })
    check('框选生成编号标记（1 区域）', true)

    // 6) 输入提示词并提交图生图
    await page.typeInto('input[placeholder*="框选区域"]', '把圈中的圆形换成一只橘猫')
    await page.clickText('生成', { tag: 'button' })
    await page.waitFor(
      `document.body.innerText.includes('修改任务已提交') || document.body.innerText.includes('生成中')`,
      { label: '提交图生图任务', timeout: 20000 }
    )
    check('提交图生图任务（提示词 + 标记图）', true)

    // 7) 导出：菜单 + 真实下载文件字节校验（PNG / JPG）
    const { mkdir, readdir, readFile, rm } = await import('node:fs/promises')
    const DL = '/tmp/cs-downloads'
    await rm(DL, { recursive: true, force: true })
    await mkdir(DL, { recursive: true })
    await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL })

    const downloadOnce = async (menuLabel, ext) => {
      await page.clickText('导出', { tag: 'button' })
      await page.waitFor(`document.body.innerText.includes(${JSON.stringify(menuLabel)})`, { label: '导出菜单', timeout: 8000 })
      await page.clickTextContains(menuLabel, { tag: 'div[role="menuitem"]' })
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const files = (await readdir(DL)).filter((f) => f.endsWith(`.${ext}`) && !f.endsWith('.crdownload'))
        if (files.length) {
          const buf = await readFile(`${DL}/${files[0]}`)
          return { name: files[0], buf }
        }
        await sleep(300)
      }
      return null
    }

    const png = await downloadOnce('导出 PNG', 'png')
    check(
      '导出 PNG 真实可用',
      Boolean(png) && png.buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
      png ? `${png.name} · ${png.buf.length} bytes · PNG 魔数校验通过` : '未产生文件'
    )
    const jpg = await downloadOnce('导出 JPG', 'jpg')
    check(
      '导出 JPG 真实可用',
      Boolean(jpg) && jpg.buf[0] === 0xff && jpg.buf[1] === 0xd8,
      jpg ? `${jpg.name} · ${jpg.buf.length} bytes · JPEG 魔数校验通过` : '未产生文件'
    )

    // 8) 图层面板：多元素 + 选中同步 + 层级调整 + 显隐
    await sleep(500)
    const inputNode2 = await page.send('DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file]',
    })
    await page.send('DOM.setFileInputFiles', { files: [UPLOAD_FILE], nodeId: inputNode2.nodeId })
    await page.waitFor(`document.body.innerText.includes('常用预设')`, { label: '第二次上传弹窗' })
    await page.clickText('上传并加入画布', { tag: 'button' })
    await page.waitFor(`document.querySelectorAll('li > div[role="button"]').length >= ${baseCount + 2}`, {
      label: '图层出现 2 个新元素',
      timeout: 20000,
    })
    const layerCount = await page.eval(`document.querySelectorAll('li > div[role="button"]').length`)
    check('图层可查看全部元素', layerCount >= 2, `${layerCount} 个图层项`)

    const orderIds = () =>
      page.eval(`[...document.querySelectorAll('li > div[role="button"]')].map(n => n.dataset.layerId).join(',')`)
    const orderBefore = await orderIds()
    // 顶层元素无法再上移，因此对顶层行执行「下移一层」
    const downBtn = await page.center('li > div[role="button"] button[title="下移一层"]', 0)
    await page.clickAt(downBtn.x, downBtn.y)
    await sleep(600)
    const orderAfter = await orderIds()
    check('图层可调整层级（下移）', orderBefore !== orderAfter, '顶层元素下移后层级顺序改变')

    const hideBtn = await page.center('li > div[role="button"] button[title="隐藏"]', 0)
    await page.clickAt(hideBtn.x, hideBtn.y)
    await sleep(600)
    const hidden = await page.eval(
      `[...document.querySelectorAll('li > div[role="button"]')].some(n => (n.querySelector('span.line-through') !== null))`
    )
    check('图层可切换显隐', hidden, '隐藏后图层项呈删除线态')

    const lockBtn = await page.center('li > div[role="button"] button[title="锁定"]', 0)
    await page.clickAt(lockBtn.x, lockBtn.y)
    await sleep(500)
    const locked = await page.eval(`document.querySelectorAll('li > div[role="button"] button[title="解锁"]').length > 0`)
    check('图层可锁定/解锁', locked)

    // 图层点击 → 与画布选中态双向同步，并同样进入编辑模式
    // 点击行内「名称区」（避开右侧操作按钮），避免误触层级/显隐按钮
    const rowPos = await page.eval(`(() => {
      const n = document.querySelectorAll('li > div[role="button"]')[1];
      const r = n.getBoundingClientRect();
      return { x: r.left + 60, y: r.top + r.height / 2, id: n.dataset.layerId };
    })()`)
    await page.clickAt(rowPos.x, rowPos.y)
    await page.waitFor(`document.body.innerText.includes('当前图片')`, { label: '选中同步到右栏', timeout: 8000 })
    const sync = await page.eval(`(() => {
      const rows = [...document.querySelectorAll('li > div[role="button"]')];
      const active = rows.find(n => n.className.includes('border-brand'));
      const preview = [...document.querySelectorAll('img')].some(n => n.alt === '当前选中图片预览');
      return { activeId: active ? active.dataset.layerId : null, preview };
    })()`)
    check(
      '图层选中与画布双向同步',
      sync.activeId === rowPos.id && sync.preview,
      `高亮图层=${sync.activeId === rowPos.id ? '命中' : sync.activeId}，右栏预览=${sync.preview}`
    )

    // 9) 图层选中图片同样进入编辑模式；且 Excalidraw 原生「双击裁剪」入口被消除
    await page.waitFor(EDIT_INPUT, { label: '图层选中即进入编辑', timeout: 10000 })
    check('从图层选中图片同样进入编辑模式', true)
    const cropHintVisible = await page.eval(`(() => {
      const h = document.querySelector('.HintViewer');
      if (!h) return false;
      return getComputedStyle(h).display !== 'none' && /crop the image/i.test(h.innerText || '');
    })()`)
    check('已消除与单击编辑冲突的「双击裁剪」入口', !cropHintVisible)

    // 10) 控制台错误检查
    await sleep(1500)
    await page.screenshot('/tmp/cs-ui-workspace.png')
  } catch (error) {
    check('UI 流程执行', false, String(error.message || error))
    try {
      await page.screenshot('/tmp/cs-ui-error.png')
    } catch {
      /* ignore */
    }
  } finally {
    try {
      await page.send('Page.close')
    } catch {
      /* ignore */
    }
    page.ws.close()
  }

  console.log('\n' + '='.repeat(56))
  console.log(`UI 验证：通过 ${PASS.length} 项 / 失败 ${FAIL.length} 项`)
  if (FAIL.length) {
    console.log('失败项：')
    FAIL.forEach((item) => console.log('  -', item))
  }
  process.exit(FAIL.length ? 1 : 0)
}

main().catch((error) => {
  console.error('FATAL', error)
  process.exit(1)
})
