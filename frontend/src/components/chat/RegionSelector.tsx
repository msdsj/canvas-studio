import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import type { RegionSelection } from '@/types/models'

export type { RegionSelection }

interface RegionSelectorProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 底图（blob: / data: / http(s): 均可） */
  imageUrl: string | null
  onConfirm: (selection: RegionSelection) => void
}

interface DisplayRect {
  x: number
  y: number
  w: number
  h: number
}

/** 图片区域选择器：在图片上按住拖拽框选需要修改的区域，确认后输出「底图 + 高亮标记图」。 */
export function RegionSelector({ open, onOpenChange, imageUrl, onConfirm }: RegionSelectorProps) {
  const { t } = useTranslation('chat')
  const boxRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const [rect, setRect] = useState<DisplayRect | null>(null)
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null)
  const [busy, setBusy] = useState(false)

  // 每次打开重置选择状态
  useEffect(() => {
    if (open) {
      setRect(null)
      setBusy(false)
      dragStartRef.current = null
    }
  }, [open])

  // 换图重置
  useEffect(() => {
    setRect(null)
    setNatural(null)
  }, [imageUrl])

  const localPoint = (clientX: number, clientY: number) => {
    const el = boxRef.current
    if (!el) return { x: 0, y: 0 }
    const b = el.getBoundingClientRect()
    return {
      x: Math.min(Math.max(clientX - b.left, 0), b.width),
      y: Math.min(Math.max(clientY - b.top, 0), b.height),
    }
  }

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!natural || busy) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const p = localPoint(e.clientX, e.clientY)
    dragStartRef.current = p
    setRect({ x: p.x, y: p.y, w: 0, h: 0 })
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current
    if (!start) return
    const p = localPoint(e.clientX, e.clientY)
    setRect({
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    })
  }

  const handlePointerUp = () => {
    dragStartRef.current = null
  }

  const confirm = useCallback(async () => {
    const box = boxRef.current
    if (!imageUrl || !rect || !natural || !box || busy) return
    const bw = box.clientWidth
    const bh = box.clientHeight
    if (bw <= 0 || bh <= 0 || rect.w < 6 || rect.h < 6) return
    setBusy(true)
    try {
      const region = { x: rect.x / bw, y: rect.y / bh, w: rect.w / bw, h: rect.h / bh }
      // 读取底图字节
      const resp = await fetch(imageUrl)
      const baseBlob = await resp.blob()
      const bitmap = await createImageBitmap(baseBlob)
      const cw = bitmap.width || natural.w
      const ch = bitmap.height || natural.h
      // 生成"底图 + 高亮选区"标记图
      const canvas = document.createElement('canvas')
      canvas.width = cw
      canvas.height = ch
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas unsupported')
      ctx.drawImage(bitmap, 0, 0, cw, ch)
      const rx = Math.round(region.x * cw)
      const ry = Math.round(region.y * ch)
      const rw = Math.max(1, Math.round(region.w * cw))
      const rh = Math.max(1, Math.round(region.h * ch))
      ctx.fillStyle = 'rgba(255, 64, 64, 0.28)'
      ctx.fillRect(rx, ry, rw, rh)
      ctx.strokeStyle = 'rgba(255, 32, 32, 0.95)'
      ctx.lineWidth = Math.max(2, Math.round(Math.min(cw, ch) / 220))
      ctx.strokeRect(rx, ry, rw, rh)
      bitmap.close?.()
      const maskBlob: Blob | null = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!maskBlob) throw new Error('mask export failed')
      onConfirm({
        baseFile: new File([baseBlob], 'base.png', { type: baseBlob.type || 'image/png' }),
        baseUrl: imageUrl,
        maskFile: new File([maskBlob], 'region-mask.png', { type: 'image/png' }),
        region,
      })
      onOpenChange(false)
    } catch {
      /* 保留弹窗供用户重试 */
    } finally {
      setBusy(false)
    }
  }, [imageUrl, rect, natural, busy, onConfirm, onOpenChange])

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('region.title', { defaultValue: '选择编辑区域' })}
      description={t('region.hint', { defaultValue: '在图片上按住鼠标拖拽，框出需要修改或调整的区域' })}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={() => setRect(null)} disabled={!rect || busy}>
            {t('region.clear', { defaultValue: '清除选区' })}
          </Button>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('region.cancel', { defaultValue: '取消' })}
          </Button>
          <Button loading={busy} disabled={!rect || rect.w < 6 || rect.h < 6} onClick={() => void confirm()}>
            {t('region.confirm', { defaultValue: '确认选区' })}
          </Button>
        </>
      }
    >
      {imageUrl ? (
        <div className="flex justify-center">
          <div
            ref={boxRef}
            className="relative w-fit max-w-full touch-none overflow-hidden rounded-md border border-border"
            style={{ cursor: 'crosshair' }}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            <img
              ref={imgRef}
              src={imageUrl}
              alt="region-target"
              draggable={false}
              className="block max-h-[55vh] max-w-full select-none"
              onLoad={() => {
                const el = imgRef.current
                if (el) setNatural({ w: el.naturalWidth, h: el.naturalHeight })
              }}
            />
            {rect && rect.w > 1 && rect.h > 1 && (
              <div
                className="pointer-events-none absolute"
                style={{
                  left: rect.x,
                  top: rect.y,
                  width: rect.w,
                  height: rect.h,
                  border: '2px solid rgba(255, 32, 32, 0.95)',
                  background: 'rgba(255, 64, 64, 0.25)',
                }}
              />
            )}
          </div>
        </div>
      ) : (
        <p className="py-10 text-center text-sm text-text-tertiary">
          {t('region.empty', { defaultValue: '未找到可编辑的图片' })}
        </p>
      )}
    </Modal>
  )
}
