import { useEffect, useMemo, useState } from 'react'
import { Sparkles, Upload } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import type { PromptPreset } from '@/lib/api/assets'

interface UploadPromptDialogProps {
  open: boolean
  file: File | null
  presets: PromptPreset[]
  uploading?: boolean
  onConfirm: (prompt: string) => void
  onCancel: () => void
}

/**
 * 上传流程内置提示词配置：选定图片后先确认「这张图要做什么」。
 * 提示词随资产保存，进入编辑模式时自动回填，避免每次重复输入。
 */
export function UploadPromptDialog({
  open,
  file,
  presets,
  uploading,
  onConfirm,
  onCancel,
}: UploadPromptDialogProps) {
  const [prompt, setPrompt] = useState('')
  const [activeId, setActiveId] = useState<string | null>(null)

  const previewUrl = useMemo(() => (file ? URL.createObjectURL(file) : null), [file])
  useEffect(
    () => () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    },
    [previewUrl]
  )

  useEffect(() => {
    if (open) {
      setPrompt('')
      setActiveId(null)
    }
  }, [open, file])

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
      title="上传图片"
      description="可选：为这张图预设提示词，进入编辑时会自动带上"
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={uploading}>
            取消
          </Button>
          <Button onClick={() => onConfirm(prompt.trim())} loading={uploading}>
            <Upload size={15} /> 上传并加入画布
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {previewUrl && (
          <div className="flex max-h-40 items-center justify-center overflow-hidden rounded-lg border border-border bg-bg-subtle">
            <img src={previewUrl} alt="待上传图片" className="max-h-40 w-auto object-contain" />
          </div>
        )}

        {presets.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] text-text-tertiary">
              <Sparkles size={12} /> 常用预设
            </span>
            {presets.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setPrompt(item.prompt)
                  setActiveId(item.id)
                }}
                className={
                  activeId === item.id
                    ? 'rounded-full border border-brand bg-brand-subtle px-2.5 py-0.5 text-[11px] text-brand-text'
                    : 'rounded-full border border-border px-2.5 py-0.5 text-[11px] text-text-secondary transition-colors hover:border-brand hover:text-brand-text'
                }
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        <textarea
          value={prompt}
          onChange={(e) => {
            setPrompt(e.target.value)
            setActiveId(null)
          }}
          rows={3}
          placeholder="例如：把主体抠出来放到纯白背景上（可留空，进入编辑时再写）"
          className="w-full resize-none rounded-lg border border-border bg-bg-subtle px-3 py-2 text-sm text-text placeholder:text-text-tertiary focus:border-brand focus:outline-none"
        />
      </div>
    </Modal>
  )
}
