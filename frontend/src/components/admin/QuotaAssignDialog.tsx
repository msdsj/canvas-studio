import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@/components/ui/modal'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { AdminUser } from '@/types/models'

interface QuotaAssignDialogProps {
  user: AdminUser | null
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: { mode: 'increase' | 'decrease' | 'set'; amount: number; note: string }) => Promise<void> | void
}

/** 额度分配弹窗（增加 / 扣减 / 设置 + 备注）。 */
export function QuotaAssignDialog({ user, onOpenChange, onSubmit }: QuotaAssignDialogProps) {
  const { t } = useTranslation('admin')
  const [mode, setMode] = useState<'increase' | 'decrease' | 'set'>('increase')
  const [amount, setAmount] = useState('0')
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (user) {
      setMode('increase')
      setAmount('0')
      setNote('')
    }
  }, [user])

  return (
    <Modal
      open={Boolean(user)}
      onOpenChange={onOpenChange}
      title={t('quota_dialog.title')}
      description={user?.email}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button
            loading={loading}
            onClick={async () => {
              setLoading(true)
              try {
                await onSubmit({ mode, amount: Number(amount) || 0, note })
                onOpenChange(false)
              } finally {
                setLoading(false)
              }
            }}
          >
            {t('common:action.confirm', { defaultValue: '确认' })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t('quota_dialog.mode')}>
          <Select value={mode} onValueChange={(v) => setMode(v as 'increase' | 'decrease' | 'set')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="increase">{t('quota_dialog.increase')}</SelectItem>
              <SelectItem value="decrease">{t('quota_dialog.decrease')}</SelectItem>
              <SelectItem value="set">{t('quota_dialog.set')}</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        <FormField label={t('quota_dialog.amount')} helper={`当前余额：${user?.balance ?? 0}`}>
          <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label={t('quota_dialog.note')}>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  )
}
