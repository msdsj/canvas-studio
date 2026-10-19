import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { ImageDown } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'

const ACCEPT = ['image/png', 'image/jpeg', 'image/webp']

function hasFiles(event: DragEvent) {
  return Array.from(event.dataTransfer?.types ?? []).includes('Files')
}

/**
 * 把图片直接拖进画布：整块画布变成放置区。
 *
 * 必须在**捕获阶段**截住 drop：Excalidraw 自己也接受拖入图片，但它只把像素塞进场景，
 * 不走平台的上传（没有资产记录、没有提示词配置、跨设备打不开）。
 * 所以这里抢先处理并 stopPropagation，把文件交给工作台已有的上传流程。
 *
 * dragleave 会在子元素之间来回触发，用计数器而不是布尔值判断「真的离开了」。
 */
export function CanvasDropZone({
  targetRef,
  onFile,
  onReject,
}: {
  targetRef: RefObject<HTMLElement | null>
  onFile: (file: File) => void
  onReject?: () => void
}) {
  const { t } = useTranslation('stage')
  const [active, setActive] = useState(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const onFileRef = useRef(onFile)
  const onRejectRef = useRef(onReject)
  onFileRef.current = onFile
  onRejectRef.current = onReject

  useEffect(() => {
    const target = targetRef.current
    if (!target) return
    let depth = 0
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth += 1
      setActive(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setActive(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      depth = 0
      setActive(false)
      const file = Array.from(event.dataTransfer?.files ?? []).find((item) => ACCEPT.includes(item.type))
      if (file) onFileRef.current(file)
      else onRejectRef.current?.()
    }
    target.addEventListener('dragenter', enter, true)
    target.addEventListener('dragover', over, true)
    target.addEventListener('dragleave', leave, true)
    target.addEventListener('drop', drop, true)
    return () => {
      target.removeEventListener('dragenter', enter, true)
      target.removeEventListener('dragover', over, true)
      target.removeEventListener('dragleave', leave, true)
      target.removeEventListener('drop', drop, true)
    }
  }, [targetRef])

  useLayoutEffect(() => {
    const overlay = overlayRef.current
    if (!overlay) return
    const frame = overlay.querySelector<HTMLElement>('[data-frame]')
    if (shouldReduceMotion()) {
      gsap.set(overlay, { autoAlpha: active ? 1 : 0 })
      return
    }
    gsap.to(overlay, { autoAlpha: active ? 1 : 0, duration: active ? 0.22 : 0.18, ease: 'power2.out' })
    if (frame)
      gsap.to(frame, {
        scale: active ? 1 : 0.97,
        duration: active ? 0.5 : 0.2,
        ease: active ? 'back.out(1.6)' : 'power2.in',
      })
  }, [active])

  return (
    <div
      ref={overlayRef}
      aria-hidden={!active}
      className="pointer-events-none invisible absolute inset-0 z-30 flex items-center justify-center bg-accent/10 p-4 opacity-0 backdrop-blur-[1.5px]"
    >
      <div
        data-frame
        className="cs-drop-frame flex h-full w-full flex-col items-center justify-center gap-2 rounded-[14px] text-center"
      >
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-on-accent shadow-glow">
          <ImageDown size={22} />
        </span>
        <p className="text-ui font-semibold text-text">{t('drop.title')}</p>
        <p className="text-caption text-text-secondary">{t('drop.desc')}</p>
      </div>
    </div>
  )
}
