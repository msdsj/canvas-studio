import { useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { authApi } from '@/lib/api/auth'
import { errorMessage } from '@/lib/errors'

export const Route = createFileRoute('/reset-password')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  component: ResetPasswordPage,
})

function ResetPasswordPage() {
  const { t } = useTranslation('auth')
  const { t: te } = useTranslation()
  const { token } = Route.useSearch()
  const navigate = useNavigate()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const hasToken = Boolean(token)

  const submit = async () => {
    setError('')
    setMessage('')
    setLoading(true)
    try {
      if (hasToken) {
        if (password.length < 8) throw new Error(t('validation.password_weak'))
        if (password !== confirm) throw new Error(t('validation.password_mismatch'))
        await authApi.resetPassword(token, password)
        setMessage(t('reset.success'))
        setTimeout(() => void navigate({ to: '/login' }), 1200)
      } else {
        if (!email) throw new Error(t('validation.email_required'))
        await authApi.forgotPassword(email)
        setMessage(t('reset.sent'))
      }
    } catch (err) {
      setError(errorMessage(err, te))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-text">
            {hasToken ? t('reset.title') : t('reset.forgot_title')}
          </h1>
          {!hasToken && <p className="mt-2 text-sm text-text-secondary">{t('reset.forgot_desc')}</p>}
        </div>
        <div className="flex flex-col gap-4">
          {hasToken ? (
            <>
              <FormField label={t('reset.new_password')} required htmlFor="new">
                <Input id="new" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </FormField>
              <FormField label={t('reset.confirm_password')} required htmlFor="confirm">
                <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </FormField>
            </>
          ) : (
            <FormField label={t('login.email')} required htmlFor="email">
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </FormField>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          {message && <p className="text-sm text-success">{message}</p>}
          <Button loading={loading} onClick={submit}>
            {hasToken ? t('reset.submit') : t('reset.send_link')}
          </Button>
          <Link to="/login" className="text-center text-sm text-brand-text hover:underline">
            {t('login.login_now')}
          </Link>
        </div>
      </div>
    </div>
  )
}
