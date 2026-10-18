import { useMemo } from 'react'
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Lock,
  LockOpen,
  Square,
  Trash2,
  Type as TypeIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { CanvasElement } from '@/types/models'
import type { ExcalidrawApiLike } from './canvas-helpers'

interface LayerPanelProps {
  api: ExcalidrawApiLike | null
  elements: CanvasElement[]
  selectedIds: string[]
  /** 选中某图层后的回调（用于与画布编辑模式联动：选中图片即进入编辑） */
  onElementSelected?: (element: CanvasElement) => void
  collapsed?: boolean
}

/** 元素在图层里的展示名（图片优先取自定义名，文本取内容）。 */
function layerName(element: CanvasElement, indexFromTop: number): string {
  const custom = (element.customData ?? {}) as Record<string, unknown>
  const customName = typeof custom.name === 'string' ? custom.name : ''
  if (customName) return customName
  if (element.type === 'image') return `图片 ${indexFromTop}`
  if (element.type === 'text') {
    const text = String((element as { text?: string }).text ?? '').trim()
    return text ? text.slice(0, 20) : '文本'
  }
  const labelMap: Record<string, string> = {
    rectangle: '矩形',
    ellipse: '椭圆',
    diamond: '菱形',
    arrow: '箭头',
    line: '线条',
    freedraw: '手绘',
    frame: '画框',
  }
  return labelMap[element.type] ?? element.type
}

function layerIcon(type: string) {
  if (type === 'image') return <ImageIcon size={13} />
  if (type === 'text') return <TypeIcon size={13} />
  return <Square size={13} />
}

/**
 * 类 Figma 图层面板：按层级（z-order，顶层在上）列出画布全部元素。
 * 支持查看、单击选中、显隐、锁定、上移/下移/置顶/置底、删除。
 */
export function LayerPanel({ api, elements, selectedIds, onElementSelected, collapsed }: LayerPanelProps) {
  // Excalidraw 数组顺序 = 绘制顺序（越靠后越靠上），图层面板倒序展示
  const ordered = useMemo(() => [...elements].reverse(), [elements])
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])

  const commit = (next: CanvasElement[], appState?: Record<string, unknown>) => {
    if (!api) return
    api.updateScene({ elements: next, ...(appState ? { appState } : {}) })
  }

  /**
   * 修改单个元素的属性。
   * 必须同时 bump `version`/`versionNonce`：Excalidraw 以版本号判定元素是否更新，
   * 只改 `opacity`/`locked` 而不升版本时，场景会被判为「无变化」而丢弃（面板看不到效果）。
   */
  const patch = (id: string, updater: (el: CanvasElement) => CanvasElement) => {
    commit(
      elements.map((el) =>
        el.id === id
          ? {
              ...updater(el),
              version: ((el as { version?: number }).version ?? 1) + 1,
              versionNonce: Math.floor(Math.random() * 1_000_000_000),
              updated: Date.now(),
            }
          : el
      )
    )
  }

  const select = (element: CanvasElement) => {
    if (!api) return
    api.updateScene({ appState: { selectedElementIds: { [element.id]: true } } })
    onElementSelected?.(element)
  }

  /** 层级调整：Excalidraw 里数组越靠后越在上层。 */
  const reorder = (id: string, direction: 'up' | 'down' | 'top' | 'bottom') => {
    const index = elements.findIndex((el) => el.id === id)
    if (index < 0) return
    const next = [...elements]
    const [item] = next.splice(index, 1)
    if (direction === 'up') next.splice(Math.min(elements.length - 1, index + 1), 0, item)
    else if (direction === 'down') next.splice(Math.max(0, index - 1), 0, item)
    else if (direction === 'top') next.push(item)
    else next.unshift(item)
    commit(next)
  }

  const toggleVisible = (element: CanvasElement) => {
    const custom = (element.customData ?? {}) as Record<string, unknown>
    const hidden = element.opacity === 0
    if (hidden) {
      const prev = typeof custom._prevOpacity === 'number' ? (custom._prevOpacity as number) : 100
      patch(element.id, (el) => ({
        ...el,
        opacity: prev,
        customData: { ...custom, _prevOpacity: undefined },
      }))
    } else {
      patch(element.id, (el) => ({
        ...el,
        opacity: 0,
        customData: { ...custom, _prevOpacity: el.opacity ?? 100 },
      }))
    }
  }

  const toggleLock = (element: CanvasElement) => {
    patch(element.id, (el) => ({ ...el, locked: !el.locked }))
  }

  const remove = (id: string) => {
    commit(elements.filter((el) => el.id !== id))
  }

  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 py-2" title="图层面板">
        <ImageIcon size={16} className="text-text-tertiary" />
        <span className="text-micro text-text-tertiary">{ordered.length}</span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="mb-1 flex items-center justify-between px-2">
        <span className="text-xs font-medium uppercase tracking-wide text-text-tertiary">图层</span>
        <span className="text-micro text-text-tertiary">{ordered.length} 个元素</span>
      </div>
      {ordered.length === 0 ? (
        <p className="mx-2 rounded-md border border-dashed border-border px-3 py-4 text-center text-micro leading-relaxed text-text-tertiary">
          画布还是空的
          <br />
          上传图片或让 AI 生成后会出现在这里
        </p>
      ) : (
        <ul className="flex min-h-0 flex-col gap-0.5 overflow-y-auto pr-1">
          {ordered.map((element, index) => {
            const selected = selectedSet.has(element.id)
            const hidden = element.opacity === 0
            return (
              <li key={element.id}>
                <div
                  role="button"
                  tabIndex={0}
                  data-layer-id={element.id}
                  data-layer-name={layerName(element, ordered.length - index)}
                  onClick={() => select(element)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      select(element)
                    }
                  }}
                  className={cn(
                    'group flex cursor-pointer items-center gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors',
                    selected
                      ? 'border-brand bg-brand-subtle text-brand-text'
                      : 'border-transparent text-text-secondary hover:bg-surface-hover'
                  )}
                >
                  <span className={cn('shrink-0', hidden && 'opacity-40')}>{layerIcon(element.type)}</span>
                  <span className={cn('min-w-0 flex-1 truncate', hidden && 'opacity-50 line-through')}>
                    {layerName(element, ordered.length - index)}
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                    <RowButton title="上移一层" onClick={() => reorder(element.id, 'up')}>
                      <ChevronUp size={12} />
                    </RowButton>
                    <RowButton title="下移一层" onClick={() => reorder(element.id, 'down')}>
                      <ChevronDown size={12} />
                    </RowButton>
                    <RowButton title={hidden ? '显示' : '隐藏'} onClick={() => toggleVisible(element)}>
                      {hidden ? <EyeOff size={12} /> : <Eye size={12} />}
                    </RowButton>
                    <RowButton title={element.locked ? '解锁' : '锁定'} onClick={() => toggleLock(element)}>
                      {element.locked ? <Lock size={12} /> : <LockOpen size={12} />}
                    </RowButton>
                    <RowButton title="删除" danger onClick={() => remove(element.id)}>
                      <Trash2 size={12} />
                    </RowButton>
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

function RowButton({
  title,
  onClick,
  danger,
  children,
}: {
  title: string
  onClick: () => void
  danger?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      className={cn(
        'flex h-5 w-5 items-center justify-center rounded transition-colors',
        danger ? 'hover:bg-danger-subtle hover:text-danger' : 'hover:bg-surface-active'
      )}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}
