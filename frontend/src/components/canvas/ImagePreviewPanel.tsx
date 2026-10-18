import { useEffect, useState } from 'react'
import { Download, ImageIcon, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface ImagePreviewPanelProps {
  /** 当前选中图（data URL） */
  imageUrl: string | null
  /** 已知的原图尺寸（可选，未传时自动读取） */
  width?: number
  height?: number
  onEdit?: () => void
  onDelete?: () => void
  onDownload?: (format: 'png' | 'jpg') => void
}

/**
 * 右栏图片面板：预览当前选中图片 + 尺寸 + 编辑/下载/删除入口。
 *
 * 预览只放图片本身：提示词属于生成时的中间信息，展示在预览里会把「看这张图」
 * 变成「读一段文字」；提示词仍然会在进入编辑时自动回填到输入框。
 */
export function ImagePreviewPanel({
  imageUrl,
  width,
  height,
  onEdit,
  onDelete,
  onDownload,
}: ImagePreviewPanelProps) {
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
    <div className="pb-1">
      <div className="mb-2 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-caption font-medium text-text">
          <ImageIcon size={13} /> 当前图片
        </span>
        {imageUrl && (
          <div className="flex items-center gap-1">
            <Button
              variant="secondary"
              size="icon-sm"
              aria-label="编辑"
              title="编辑"
              onClick={onEdit}
            >
              <Pencil size={13} />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label="下载">
                  <Download size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onDownload?.('png')}>下载 PNG</DropdownMenuItem>
                <DropdownMenuItem onClick={() => onDownload?.('jpg')}>下载 JPG</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="删除"
              className="hover:text-danger"
              onClick={onDelete}
            >
              <Trash2 size={14} />
            </Button>
          </div>
        )}
      </div>
      {imageUrl ? (
        <div>
          {/*
            预览缩略图 = 相纸：3px 近直角 + 白色衬边。
            画框给固定高度、图片用 max-w-full 收宽——只写 max-h 时宽图会横向溢出，
            被 overflow-hidden 裁掉两侧，看上去就是「图片偏移、没居中」。
          */}
          <div className="flex h-32 w-full items-center justify-center overflow-hidden rounded-[3px] bg-mat p-[3px] shadow-sheet">
            <img
              src={imageUrl}
              alt="当前选中图片预览"
              className="max-h-full max-w-full rounded-[3px] object-contain"
            />
          </div>
          <div className="mt-1.5 flex items-center justify-between text-caption text-text-tertiary">
            <span>尺寸</span>
            <span className="font-mono text-text-secondary">
              {measured ? `${measured.w} × ${measured.h} px` : '读取中…'}
            </span>
          </div>
        </div>
      ) : (
        <p className="rounded-[10px] bg-bg-subtle px-3 py-4 text-center text-caption leading-relaxed text-text-tertiary">
          在画布上单击一张图片
          <br />
          即可预览、编辑与导出
        </p>
      )}
    </div>
  )
}
