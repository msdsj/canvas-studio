import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AlertCircle, Check, Loader2, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { useAuth } from '@/hooks/use-auth'
import { teamsApi } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'

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
}

/**
 * 接受团队邀请。
 *
 * 邀请链接会直接落到这里（邮件里点进去）。如果用户还没登录，`ProtectedRoute`
 * 会把他引到首页登录——但**URL 里的 token 不能丢**，否则登录完回来链接已经没了，
 * 只能让管理员重发。所以这里在挂载时把 token 存进 sessionStorage，
 * 登录回来再取。
 */
function TeamJoinPage() {
  const { t } = useTranslation('team')
  const { token: searchToken } = Route.useSearch()
  const navigate = useNavigate()
  const { user } = useAuth()
  const loadTeams = useTeamStore((s) => s.load)
  const switchTo = useTeamStore((s) => s.switchTo)

  const [token, setToken] = useState(searchToken ?? '')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(true)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')

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
    if (!token || !user) {
      if (!token) setLoading(false)
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
  }, [token, user])

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

  return (
    <ProtectedRoute>
      <div className="flex min-h-screen items-center justify-center bg-bg p-6">
        <Card className="w-full max-w-md p-6">
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
              <Button loading={accepting} onClick={() => void accept()}>
                {accepting ? t('join.accepting') : t('join.accept')}
              </Button>
            </div>
          ) : (
            <p className="py-8 text-center text-caption text-text-tertiary">
              {t('join.invalid')}
            </p>
          )}
        </Card>
      </div>
    </ProtectedRoute>
  )
}
