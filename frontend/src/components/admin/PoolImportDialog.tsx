import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@/components/ui/modal'
import { FormField } from '@/components/ui/form-field'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { PoolImportMethod } from '@/lib/api/admin'

interface PoolImportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (method: PoolImportMethod, raw: string) => Promise<void> | void
  result?: { added: number; skipped: number; errors: number } | null
}

const METHODS: PoolImportMethod[] = ['token', 'session', 'codex_auth', 'account_json', 'oauth']

function parseInput(method: PoolImportMethod, raw: string): { tokens: string[]; accounts: Record<string, unknown>[] } {
  const trimmed = raw.trim()
  if (!trimmed) return { tokens: [], accounts: [] }
  if (method === 'account_json') {
    try {
      const parsed = JSON.parse(trimmed)
      const arr = Array.isArray(parsed) ? parsed : [parsed]
      return { tokens: [], accounts: arr as Record<string, unknown>[] }
    } catch {
      return { tokens: [], accounts: [] }
    }
  }
  const tokens = trimmed
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  return { tokens, accounts: [] }
}

/** 五方式批量导入弹窗 + 回执。 */
export function PoolImportDialog({ open, onOpenChange, onSubmit, result }: PoolImportDialogProps) {
  const { t } = useTranslation('admin')
  const [method, setMethod] = useState<PoolImportMethod>('token')
  const [raw, setRaw] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = async () => {
    setLoading(true)
    try {
      // method 与原始文本一并交给页面解析
      await onSubmit(method, raw.trim())
      setRaw('')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('pool.import_title')}
      size="md"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button loading={loading} disabled={!raw.trim()} onClick={handleSubmit}>
            {t('common:action.confirm', { defaultValue: '导入' })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t('pool.method')}>
          <Select value={method} onValueChange={(v) => setMethod(v as PoolImportMethod)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {METHODS.map((m) => (
                <SelectItem key={m} value={m}>
                  {t(`pool.method_${m}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </FormField>
        <FormField
          label={t('pool.paste_hint')}
          helper={method === 'account_json' ? '粘贴 JSON 数组' : t('pool.paste_hint')}
        >
          <Textarea rows={6} value={raw} onChange={(e) => setRaw(e.target.value)} className="font-mono text-sm" />
        </FormField>
        {result && (
          <div className="rounded-md bg-bg-subtle px-3 py-2 text-sm text-text-secondary">
            {t('pool.import_result', { added: result.added, skipped: result.skipped, errors: result.errors })}
          </div>
        )}
      </div>
    </Modal>
  )
}

export { parseInput }
