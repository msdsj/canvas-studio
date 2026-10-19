import { useUIStore } from '@/stores/ui'

/**
 * 画布 → Agent 输入框的桥。
 *
 * 画布上的引导（空画布灵感卡、「描述你想要的」）需要把光标送进左侧对话输入框，
 * 但对话面板是另一棵组件树，不该为了这一个动作把 setInput 层层透传进画布。
 * 输入框是受控 textarea：用原生 value setter + 冒泡 input 事件写值，
 * React 会把它当成一次真实输入走 onChange，草稿、润色等逻辑全部照常生效。
 */
export function focusAgentComposer(text?: string) {
  const ui = useUIStore.getState()
  ui.setAgentPanelOpen(true)
  ui.setMobileSegment('chat')

  // 面板可能刚从收起态展开 / 移动端刚切过去：等两帧布局稳定再聚焦
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>('[data-agent-composer] textarea')
      if (!textarea) return
      if (typeof text === 'string') {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
        setter?.call(textarea, text)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      }
      textarea.focus({ preventScroll: true })
      const end = textarea.value.length
      textarea.setSelectionRange(end, end)
    })
  )
}
