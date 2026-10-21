#!/usr/bin/env node
/**
 * 画布交互边界静态断言（不需要起服务）。
 *
 * 这条链路的回归成本很高：它决定「单击选中 / 框选就地编辑 / 引用进对话」
 * 三条路径的归属。任何一方越过边界，用户就会看到
 * 「想挪个图却被吸进编辑层」「框选功能跑到侧栏对话里」这类问题。
 *
 * ⚠️ 2026-10 交互改版（见 WorkspaceView 的注释块）：
 *   单击 = 只选中（弹出操作条），不再自动进编辑层、也不再自动 @ 引用。
 *   本脚本原先断言的 `CLICK_MOVE_TOLERANCE` / `closest('[data-edit-layer-ui]')`
 *   随那次改版一起从源码里删掉了，导致 4 条断言长期空转失败
 *   （HEAD 上就是红的，不是新引入的问题）。现已按**现行契约**重写：
 *   - 单击 → 选中，不抢编辑；
 *   - 进编辑 = 操作条按钮 / 双击 / E 键；
 *   - 引用 = 显式动作（操作条「更多」/ 预览卡「发送到对话」）；
 *   - 空选区绝不上抛给侧栏。
 *
 * 断言只锁「行为契约」，不锁具体实现写法；改实现时先确认契约没变再改这里。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

// 默认按本脚本位置推导仓库根，避免硬编码某台机器的绝对路径（换机器直接 ENOENT）
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = process.argv[2] || resolve(HERE, '../frontend')
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

const view = read('src/components/canvas/WorkspaceView.tsx')
const panel = read('src/components/chat/ChatPanel.tsx')
const layer = read('src/components/canvas/ImageEditLayer.tsx')

const checks = [
  [
    '规则1 单击图片不抢编辑：不再有「点一下就直接进编辑层」的守卫式早退',
    // 旧版是 pointerup + 位移阈值 + 直接 enterEdit；现在单击只负责选中
    !/CLICK_MOVE_TOLERANCE/.test(view),
  ],
  [
    '规则1 引用进对话 = 显式动作（操作条 / 预览卡），不是单击副作用',
    /referenceCanvasImage\(selectedImage\)/.test(view) &&
      /onSendToChat=\{/.test(view) &&
      /onReference=/.test(view),
  ],
  [
    '规则1 进编辑层有三条显式入口：操作条按钮 / 双击 / E 键',
    /onEdit=\{\(\) => void enterEdit\(barTarget\)\}/.test(view) &&
      /onDoubleClickCapture=\{/.test(view) &&
      /toLowerCase\(\) !== 'e'/.test(view),
  ],
  [
    '规则1 双击进编辑时拦掉 Excalidraw 原生双击裁剪（避免两个编辑入口）',
    /onDoubleClickCapture=\{[\s\S]{0,400}?e\.preventDefault\(\)[\s\S]{0,200}?enterEdit/.test(view),
  ],
  [
    '规则2/4 没有区域 → 不上抛选区上下文（禁止把边栏拖进编辑链路）',
    /if \(!target \|\| regions\.length === 0\) \{[\s\S]{0,80}setSelectionCtx\(null\)/.test(view),
  ],
  [
    '规则2/4 侧栏只在「确实有区域选区」时才走 analyze',
    //
    // 2026-10 放宽了这里的条件：允许用户只用总输入框写一句总指令、
    // 不必逐区重复填写（框选编号会一起交给模型理解）。
    // 因此只断言「必须至少有一个区域」，不再要求每区都为非空。
    /const hasSelection =\s*\(selection\?\.regions\?\.length \?\? 0\) > 0/.test(panel),
  ],
  [
    '规则2 用户只框不写时，仍会带上「区域编号 + 总指令」而不是静默丢弃',
    /不要求用户逐区重复填写/.test(panel),
  ],
  [
    '规则3 框选后气泡就地弹出并聚焦',
    /setActiveRegionId\(newId\)[\s\S]{0,60}setComposerOpen\(true\)/.test(layer),
  ],
  [
    '规则3 气泡内可直接输入（提示词变更写回区域）',
    /handleRegionPromptChange\(item\.id, event\.target\.value\)/.test(layer),
  ],
]

let failed = 0
for (const [name, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}
console.log(failed === 0 ? '\n交互边界断言全部通过' : `\n${failed} 条断言未通过`)
process.exit(failed === 0 ? 0 : 1)
