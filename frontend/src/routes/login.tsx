import { useEffect, useState } from 'react'
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Sparkles, MailCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import { Spinner } from '@/components/ui/spinner'
import { authApi } from '@/lib/api/auth'
import { errorMessage } from '@/lib/errors'
import { useAuthStore } from '@/stores/auth'
import { getToken } from '@/lib/api/client'

export const Route = createFileRoute('/login')({
  component: LoginPage,
})

type Mode = 'login' | 'register'

function LoginPage() {
  const { t } = useTranslation('auth')
  const { t: te } = useTranslation()
  const navigate = useNavigate()
  const setSession = useAuthStore((s) => s.setSession)

  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(0)

  useEffect(() => {
    if (getToken()) void navigate({ to: '/workspace' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (countdown <= 0) return
    const timer = setTimeout(() => setCountdown((c) => c - 1), 1000)
    return () => clearTimeout(timer)
  }, [countdown])

  const submit = async () => {
    setError('')
    if (!email) return setError(t('validation.email_required'))
    if (!password) return setError(t('validation.password_required'))
    if (mode === 'register') {
      if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
        return setError(t('validation.password_weak'))
      if (password !== confirm) return setError(t('validation.password_mismatch'))
    }
    setLoading(true)
    try {
      if (mode === 'login') {
        const result = await authApi.login(email, password)
        setSession(result.access_token, result.user)
        void navigate({ to: '/workspace' })
      } else {
        await authApi.register({
          email,
          password,
          display_name: displayName || undefined,
          invite_code: inviteCode || undefined,
        })
        setSent(email)
        setCountdown(60)
      }
    } catch (err) {
      setError(errorMessage(err, te))
    } finally {
      setLoading(false)
    }
  }

  const resend = async () => {
    try {
      await authApi.resendVerification(sent as string)
      setCountdown(60)
    } catch (err) {
      setError(errorMessage(err, te))
    }
  }

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-2/5 flex-col justify-between bg-brand-subtle p-10 lg:flex">
        <div className="flex items-center gap-2 text-brand-text">
          <span className="flex h-8 w-8 items-center justify-center rounded-md bg-brand text-text-inverse">
            <Sparkles size={18} />
          </span>
          <span className="text-md font-semibold">Canvas Studio</span>
        </div>
        <div>
          <h1 className="text-2xl font-semibold text-text">{t('brand.headline')}</h1>
          <p className="mt-3 max-w-sm text-text-secondary">{t('brand.desc')}</p>
        </div>
        <p className="text-xs text-text-tertiary">© {new Date().getFullYear()} Canvas Studio</p>
      </aside>

      <main className="flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[400px]">
          {sent ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <MailCheck size={48} className="text-brand" />
              <h2 className="text-xl font-semibold text-text">{t('verify.title')}</h2>
              <p className="text-sm text-text-secondary">{t('verify.desc', { email: sent })}</p>
              <Button variant="secondary" disabled={countdown > 0} onClick={resend}>
                {countdown > 0 ? t('verify.resend_in', { seconds: countdown }) : t('verify.resend')}
              </Button>
              <Link to="/login" className="text-sm text-brand-text hover:underline">
                {t('verify.done')}
              </Link>
            </div>
          ) : (
            <>
              <div className="mb-6 flex flex-col items-center gap-2 text-center">
                <h1 className="text-xl font-semibold text-text">{t('login.title')}</h1>
                <p className="text-sm text-text-secondary">{t('login.subtitle')}</p>
              </div>

              <div className="mb-5 flex rounded-md bg-bg-subtle p-1">
                {(['login', 'register'] as Mode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      setMode(m)
                      setError('')
                    }}
                    className={
                      'flex-1 rounded-sm py-1.5 text-sm font-medium transition-colors ' +
                      (mode === m ? 'bg-surface text-text shadow-xs' : 'text-text-secondary')
                    }
                  >
                    {m === 'login' ? t('login.tab_login') : t('login.tab_register')}
                  </button>
                ))}
              </div>

              <div className="flex flex-col gap-4">
                <FormField label={t('login.email')} required htmlFor="email">
                  <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
                </FormField>
                {mode === 'register' && (
                  <FormField label={t('login.display_name')} htmlFor="displayName">
                    <Input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                  </FormField>
                )}
                <FormField label={t('login.password')} required htmlFor="password">
                  <Input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  />
                </FormField>
                {mode === 'register' && (
                  <>
                    <FormField label={t('login.confirm_password')} required htmlFor="confirm">
                      <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                    </FormField>
                    <FormField label={t('login.invite_code')} htmlFor="invite">
                      <Input id="invite" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
                    </FormField>
                  </>
                )}

                {error && <p className="text-sm text-danger">{error}</p>}

                <Button loading={loading} onClick={submit}>
                  {mode === 'login' ? t('login.submit_login') : t('login.submit_register')}
                </Button>

                {mode === 'login' ? (
                  <div className="flex items-center justify-between text-sm">
                    <Link to="/reset-password" className="text-brand-text hover:underline">
                      {t('login.forgot')}
                    </Link>
                    <button type="button" className="text-text-secondary" onClick={() => setMode('register')}>
                      {t('login.no_account')} {t('login.register_now')}
                    </button>
                  </div>
                ) : (
                  <button type="button" className="text-sm text-text-secondary" onClick={() => setMode('login')}>
                    {t('login.has_account')} {t('login.login_now')}
                  </button>
                )}
              </div>
            </>
          )}

          {loading && (
            <div className="mt-4 flex justify-center">
              <Spinner size={16} />
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
