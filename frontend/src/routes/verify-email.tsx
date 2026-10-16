import { useEffect, useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { authApi } from '@/lib/api/auth'

export const Route = createFileRoute('/verify-email')({
  validateSearch: (search: Record<string, unknown>) => ({
    token: typeof search.token === 'string' ? search.token : '',
  }),
  component: VerifyEmailPage,
})

function VerifyEmailPage() {
  const { t } = useTranslation('auth')
  const { token } = Route.useSearch()
  const [state, setState] = useState<'verifying' | 'success' | 'failed'>('verifying')

  useEffect(() => {
    if (!token) {
      setState('failed')
      return
    }
    authApi
      .verifyEmail(token)
      .then(() => setState('success'))
      .catch(() => setState('failed'))
  }, [token])

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      {state === 'verifying' && (
        <>
          <Spinner size={32} />
          <p className="text-text-secondary">{t('verify.verifying')}</p>
        </>
      )}
      {state === 'success' && (
        <>
          <CheckCircle2 size={48} className="text-success" />
          <h1 className="text-xl font-semibold text-text">{t('verify.success')}</h1>
          <Link to="/login">
            <Button>{t('login.submit_login')}</Button>
          </Link>
        </>
      )}
      {state === 'failed' && (
        <>
          <XCircle size={48} className="text-danger" />
          <h1 className="text-xl font-semibold text-text">{t('verify.failed')}</h1>
          <Link to="/login">
            <Button variant="secondary">{t('login.login_now')}</Button>
          </Link>
        </>
      )}
    </div>
  )
}
