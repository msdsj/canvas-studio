#!/usr/bin/env node
/**
 * 画布交互边界静态断言（不需要起服务）。
 *
 * 这条链路的回归成本很高：它是「点击=引用 / 框选=就地编辑」两条路径的闸门，
 * 一旦有人把判定条件放宽或收紧，用户就会看到"框选跑到对话里"或"点图没反应"。
 * 这里用源码级断言把这四条规则钉死。
 */
import { readFileSync } from 'node:fs'

const ROOT = process.argv[2] || '/Users/meishiduoshuijiao/Desktop/canvas-studio/frontend'
const read = (p) => readFileSync(`${ROOT}/${p}`, 'utf8')

const view = read('src/components/canvas/WorkspaceView.tsx')
const panel = read('src/components/chat/ChatPanel.tsx')
const layer = read('src/components/canvas/ImageEditLayer.tsx')

const checks = [
  [
    '规则1 点击图片 → 引用进输入框（未拖拽才触发）',
    /referenceCanvasImage\(element\)/.test(view) &&
      /CLICK_MOVE_TOLERANCE/.test(view) &&
      /Math\.hypot\(e\.clientX - start\.x, e\.clientY - start\.y\) > CLICK_MOVE_TOLERANCE\) return/.test(view),
  ],
  [
    '规则1 点击判定只认位移/时长，不依赖"是否已有选区"',
    !/if\s*\(\s*\(?selection|hasSelection\)?\s*\)\s*return[\s\S]{0,120}referenceCanvasImage/.test(view),
  ],
  [
    '规则1 点在编辑层 UI 上不算点图',
    /closest\('\[data-edit-layer-ui\]'\)/.test(view),
  ],
  [
    '规则2/4 没有区域 → 不上抛选区上下文（禁止把边栏拖进编辑链路）',
    /if \(!target \|\| regions\.length === 0\) \{[\s\S]{0,80}setSelectionCtx\(null\)/.test(view),
  ],
  [
    '规则2/4 侧栏只在"区域数>0 且每区都写了改法"时才走 analyze',
    /const hasSelection =[\s\S]{0,200}every\(\(region\) => \(region\.prompt \?\? ''\)\.trim\(\)\.length > 0\)/.test(panel),
  ],
  [
    '规则3 框选后气泡就地弹出并聚焦',
    /setActiveRegionId\(newId\)[\s\S]{0,60}setComposerOpen\(true\)/.test(layer),
  ],
  [
    '规则3 气泡内可直接输入（提示词变更写回区域）',
    /handleRegionPromptChange\(item\.id, event\.target\.value\)/.test(layer),
  ],
  [
    '规则4 编辑层 UI 已打标（区域编号 / 气泡按钮）',
    (layer.match(/data-edit-layer-ui/g) || []).length >= 2,
  ],
]

let failed = 0
for (const [name, ok] of checks) {
  if (!ok) failed += 1
  console.log(`${ok ? '✅' : '❌'} ${name}`)
}
console.log(failed === 0 ? '\n交互边界断言全部通过' : `\n${failed} 条断言未通过`)
process.exit(failed === 0 ? 0 : 1)
