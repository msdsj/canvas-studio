import { useEffect, useState } from 'react'
import { ImageIcon, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface ImagePreviewPanelProps {
  /** 当前编辑目标图（data URL） */
  imageUrl: string | null
  /** 已知的原图尺寸（可选，未传时自动读取） */
  width?: number
  height?: number
  onDoodle?: () => void
}

/** 右栏图片预览：实时展示当前提交图片的实际宽高尺寸。 */
export function ImagePreviewPanel({ imageUrl, width, height, onDoodle }: ImagePreviewPanelProps) {
  const [measured, setMeasured] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    if (!imageUrl) {
      setMeasured(null)
      return
    }
    if (width && height) {
      setMeasured({ w: width, h: height })
      return
    }
    let alive = true
    const img = new Image()
    img.onload = () => {
      if (alive) setMeasured({ w: img.naturalWidth, h: img.naturalHeight })
    }
    img.src = imageUrl
    return () => {
      alive = false
    }
  }, [imageUrl, width, height])

  return (
    <div className="border-b border-border px-3 py-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-medium text-text">
          <ImageIcon size={13} /> 当前图片
        </span>
        {imageUrl && (
          <Button variant="secondary" size="sm" className="h-7 px-2 text-xs" onClick={onDoodle}>
            <Pencil size={13} /> 涂鸦
          </Button>
        )}
      </div>
      {imageUrl ? (
        <div>
          <div className="flex max-h-32 items-center justify-center overflow-hidden rounded-md border border-border bg-bg-subtle">
            <img src={imageUrl} alt="当前编辑目标预览" className="max-h-32 w-auto object-contain" />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-[11px] text-text-tertiary">
            <span>提交尺寸</span>
            <span className="font-mono text-text-secondary">
              {measured ? `${measured.w} × ${measured.h} px` : '读取中…'}
            </span>
          </div>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-[11px] leading-relaxed text-text-tertiary">
          在画布上选中一张图片
          <br />
          即可在此查看尺寸并进入涂鸦
        </p>
      )}
    </div>
  )
}