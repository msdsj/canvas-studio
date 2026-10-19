import { useCallback, useEffect, useState, type RefObject } from 'react'

const UNDO_SELECTOR = '[data-testid="button-undo"]'
const REDO_SELECTOR = '[data-testid="button-redo"]'

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent)

/**
 * 画布撤销 / 重做（接 Excalidraw 自己的历史栈）。
 *
 * Excalidraw 0.18 的命令式 API 不暴露 undo/redo，只能走它内部的 action。
 * 最稳的通道是它自己渲染的撤销/重做按钮（`data-testid="button-undo|redo"`）：
 * - 点它们走的就是 actionManager，和 ⌘Z 完全同一条路径，不会出现两套历史；
 * - 按钮的 `disabled` 属性就是历史栈是否为空，用 MutationObserver 同步过来，
 *   我们的按钮就能如实显示「现在能不能撤销」。
 * 原生按钮所在的左下角浮层被 stage.css 收起（视觉上由底部 dock 接管），但仍在 DOM 里可点击。
 * 找不到按钮时（例如 Excalidraw 切到移动端布局）退回到派发快捷键。
 */
export function useCanvasHistory(rootRef: RefObject<HTMLElement | null>, ready: boolean) {
  const [canUndo, setCanUndo] = useState(false)
  const [canRedo, setCanRedo] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    if (!root || !ready) return
    const sync = () => {
      const undo = root.querySelector<HTMLButtonElement>(UNDO_SELECTOR)
      const redo = root.querySelector<HTMLButtonElement>(REDO_SELECTOR)
      // 没渲染出原生按钮时无法得知栈状态：保持可点，交给快捷键兜底
      setCanUndo(undo ? !undo.disabled : true)
      setCanRedo(redo ? !redo.disabled : true)
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled'],
    })
    return () => observer.disconnect()
  }, [rootRef, ready])

  const run = useCallback(
    (kind: 'undo' | 'redo') => {
      const root = rootRef.current
      const button = root?.querySelector<HTMLButtonElement>(kind === 'undo' ? UNDO_SELECTOR : REDO_SELECTOR)
      if (button) {
        if (!button.disabled) button.click()
        return
      }
      const mac = isMac()
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: kind === 'undo' ? 'z' : mac ? 'z' : 'y',
          code: kind === 'undo' || mac ? 'KeyZ' : 'KeyY',
          metaKey: mac,
          ctrlKey: !mac,
          shiftKey: kind === 'redo' && mac,
          bubbles: true,
        })
      )
    },
    [rootRef]
  )

  return {
    canUndo,
    canRedo,
    undo: useCallback(() => run('undo'), [run]),
    redo: useCallback(() => run('redo'), [run]),
    shortcut: isMac() ? { undo: '⌘Z', redo: '⇧⌘Z' } : { undo: 'Ctrl+Z', redo: 'Ctrl+Y' },
  }
}
