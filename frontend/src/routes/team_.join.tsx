import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, Loader2, LogIn, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { useAuth } from '@/hooks/use-auth'
import { teamsApi } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'
import { useUIStore } from '@/stores/ui'

export const Route = createFileRoute('/team_/join')({
  validateSearch: (search: Record<string, unknown>): { token?: string } => ({
    token: typeof search.token === 'string' ? search.token : undefined,
  }),
  component: TeamJoinPage,
})

interface Preview {
  team_name: string
  inviter: string
  role: string
  expired: boolean
  email?: string | null
}

/**
 * 接受团队邀请。
 *
 * The invite token stays in the URL while the user signs in. Once authenticated,
 * opening the invite link is the consent to join and switch to that enterprise.
 */
function TeamJoinPage() {
  const { t } = useTranslation('team')
  const { token: searchToken } = Route.useSearch()
  const navigate = useNavigate()
  const { user } = useAuth()
  const loadTeams = useTeamStore((s) => s.load)
  const switchTo = useTeamStore((s) => s.switchTo)
  const openAuth = useUIStore((s) => s.openAuth)

  const [token, setToken] = useState(searchToken ?? '')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')
  const autoAcceptStarted = useRef(false)

  // 登录跳转回来后 URL 可能已经不带 token 了，从 sessionStorage 捞回来
  useEffect(() => {
    if (searchToken) {
      try {
        sessionStorage.setItem('cs.pendingInvite', searchToken)
      } catch {
        /* ignore */
      }
      setToken(searchToken)
      return
    }
    if (!token) {
      try {
        const saved = sessionStorage.getItem('cs.pendingInvite')
        if (saved) setToken(saved)
      } catch {
        /* ignore */
      }
    }
  }, [searchToken, token])

  useEffect(() => {
    if (!token) {
      setLoading(false)
      return
    }
    let alive = true
    void (async () => {
      try {
        const data = await teamsApi.previewInvite(token)
        if (alive) setPreview(data)
      } catch (err) {
        if (alive) setError(errorMessage(err))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [token])

  const accept = useCallback(async () => {
    if (!token) return
    setAccepting(true)
    try {
      const data = await teamsApi.acceptInvite(token)
      try {
        sessionStorage.removeItem('cs.pendingInvite')
      } catch {
        /* ignore */
      }
      await loadTeams(true)
      await switchTo(data.team_id)
      setAccepted(true)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setAccepting(false)
    }
  }, [token, loadTeams, switchTo])

  useEffect(() => {
    if (!user || !preview || preview.expired || accepted || autoAcceptStarted.current) return
    autoAcceptStarted.current = true
    void accept()
  }, [user, preview, accepted, accept])

  return (
      <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(120%_120%_at_50%_0%,var(--color-accent-soft),var(--color-bg)_58%)] p-4 sm:p-6">
        <Card className="w-full max-w-[420px] p-6 shadow-lift sm:p-7">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 size={18} className="animate-spin text-text-tertiary" />
            </div>
          ) : accepted ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                <Check size={26} strokeWidth={2.5} />
              </span>
              <h1 className="text-h2 font-semibold text-text">{t('join.accepted')}</h1>
              <Button size="sm" onClick={() => void navigate({ to: '/workspace' })}>
                {t('join.go_team')}
              </Button>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-danger-subtle text-danger">
                <AlertCircle size={24} />
              </span>
              <h1 className="text-h2 font-semibold text-text">{t('join.invalid')}</h1>
              {/*
               * 不把通用错误文案（「出了点小状况，重试一次」）铺在这里：
               * 邀请失效是个明确结论，不该让用户以为「再点一次就好」。
               * 只有真正的网络异常才额外说明，其它一律给「找管理员重发」的指引。
               */}
              <p className="max-w-[34ch] text-caption leading-relaxed text-text-secondary">
                {t('join.invalid_hint')}
              </p>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void navigate({ to: '/team' })}
              >
                {t('join.go_team')}
              </Button>
            </div>
          ) : preview?.expired ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-warning-subtle text-warning">
                <AlertCircle size={24} />
              </span>
              <h1 className="text-h2 font-semibold text-text">{t('join.expired')}</h1>
            </div>
          ) : preview ? (
            <div className="flex flex-col items-center gap-4 text-center">
              <span className="flex h-14 w-14 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                <Users size={24} />
              </span>
              <h1 className="text-h2 font-semibold text-text">
                {t('join.title', { team: preview.team_name })}
              </h1>
              <p className="text-caption text-text-secondary">
                {t('join.invited_by', {
                  inviter: preview.inviter || '—',
                  role: t(`role.${preview.role}` as never),
                })}
              </p>
              {accepting ? (
                <p className="flex items-center gap-2 text-caption text-text-tertiary">
                  <Loader2 size={14} className="animate-spin" /> {t('join.accepting')}
                </p>
              ) : user ? (
                <Button size="sm" onClick={() => void navigate({ to: '/workspace' })}>
                  {t('join.go_team')}
                </Button>
              ) : (
                <Button onClick={() => openAuth('login', t('join.login_hint'))}>
                  <LogIn size={15} /> {t('join.login_to_join')}
                </Button>
              )}
            </div>
          ) : (
            <p className="py-8 text-center text-caption text-text-tertiary">
              {t('join.invalid')}
            </p>
          )}
        </Card>
      </div>
  )
}
