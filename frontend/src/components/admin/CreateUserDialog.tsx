import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Modal } from '@/components/ui/modal'
import { FormField } from '@/components/ui/form-field'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

export interface CreateUserPayload {
  email: string
  password: string
  role: string
}

interface CreateUserDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (payload: CreateUserPayload) => Promise<void> | void
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** 后台新建用户弹窗：邮箱 + 初始密码 + 角色（默认普通用户，创建后可直接登录）。 */
export function CreateUserDialog({ open, onOpenChange, onSubmit }: CreateUserDialogProps) {
  const { t } = useTranslation('admin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState('user')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  // 每次打开都清空：避免把上一次输入（尤其是密码）带进新的一条
  useEffect(() => {
    if (!open) return
    setEmail('')
    setPassword('')
    setRole('user')
    setError('')
  }, [open])

  const submit = async () => {
    const mail = email.trim()
    if (!mail) return setError(t('create_user_dialog.email_required'))
    if (!EMAIL_RE.test(mail)) return setError(t('create_user_dialog.email_invalid'))
    if (!password) return setError(t('create_user_dialog.password_required'))
    if (password.length < 8) return setError(t('create_user_dialog.password_weak'))
    setError('')
    setLoading(true)
    try {
      await onSubmit({ email: mail, password, role })
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={t('create_user_dialog.title')}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            {t('common:cancel', { defaultValue: '取消' })}
          </Button>
          <Button loading={loading} onClick={() => void submit()}>
            {t('common:action.confirm', { defaultValue: '确认' })}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label={t('create_user_dialog.email')} required>
          <Input
            type="email"
            value={email}
            autoComplete="off"
            placeholder="user@studio.com"
            onChange={(e) => setEmail(e.target.value)}
          />
        </FormField>
        <FormField label={t('create_user_dialog.password')} required helper="至少 8 位">
          <Input
            type="text"
            value={password}
            autoComplete="off"
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit()
            }}
          />
        </FormField>
        <FormField label={t('create_user_dialog.role')}>
          <Select value={role} onValueChange={setRole}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="user">user</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
            </SelectContent>
          </Select>
        </FormField>
        {error && <p className="text-caption leading-snug text-danger">{error}</p>}
      </div>
    </Modal>
  )
}
