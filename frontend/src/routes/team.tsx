import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Building2, ChevronDown, Loader2, Plus, Sparkles, Users } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { teamsApi } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/team')({
  component: TeamLayout,
})

const TABS = [
  { to: '/team', labelKey: 'nav.overview', exact: true },
  { to: '/team/members', labelKey: 'nav.members', exact: false },
  { to: '/team/settings', labelKey: 'nav.settings', exact: false },
  { to: '/team/audit', labelKey: 'nav.audit', exact: false },
] as const

/**
 * 团队空间外壳：左侧团队列表 + 顶部标签页 + 子路由出口。
 *
 * 团队列表放在外壳而不是每个子页面里：用户在「成员」「设置」之间跳转时
 * 不该看到列表重新加载一遍（闪一下骨架屏），外壳持有它就只拉一次。
 */
function TeamLayout() {
  const { t } = useTranslation('team')
  const navigate = useNavigate()
  const toast = useToast()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const teams = useTeamStore((s) => s.teams)
  const activeId = useTeamStore((s) => s.activeId)
  const loading = useTeamStore((s) => s.loading)
  const load = useTeamStore((s) => s.load)
  const switchTo = useTeamStore((s) => s.switchTo)

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    void load(true)
  }, [load])

  const create = useCallback(async () => {
    const name = newName.trim()
    if (name.length < 2) {
      toast.error(t('list.name_label'))
      return
    }
    setSubmitting(true)
    try {
      const team = await teamsApi.create({ name })
      await load(true)
      await switchTo(team.id)
      setCreating(false)
      setNewName('')
      void navigate({ to: '/team' })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }, [newName, load, switchTo, navigate, toast, t])

  if (loading && teams.length === 0) {
    return (
      <ProtectedRoute>
        <AppShell>
          <div className="flex h-full items-center justify-center">
            <Loader2 className="animate-spin text-text-tertiary" size={20} />
          </div>
        </AppShell>
      </ProtectedRoute>
    )
  }

  return (
    <ProtectedRoute>
      <AppShell>
        <div className="flex h-full flex-col overflow-hidden">
          <header className="cs-team-hero relative flex flex-wrap items-center gap-3 px-4 py-4 sm:px-6 sm:py-5">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] bg-surface text-accent-ink shadow-xs ring-1 ring-inset ring-border/70">
                <Building2 size={18} />
              </span>
              <div className="flex min-w-0 flex-col">
                <h1 className="flex items-center gap-2 truncate text-h2 font-semibold tracking-[-0.01em] text-text">
                  {t('title')}
                </h1>
                <p className="truncate text-caption text-text-tertiary">{t('subtitle')}</p>
              </div>
            </div>
            <div className="ml-auto flex items-center gap-2">
              {teams.length > 0 && (
                <label className="relative flex items-center">
                  <span className="pointer-events-none absolute left-2.5 text-text-tertiary">
                    <Sparkles size={12} />
                  </span>
                  <select
                    aria-label={t('space.switch')}
                    value={activeId ?? ''}
                    onChange={(event) => void switchTo(event.target.value || null)}
                    className="h-9 max-w-[180px] appearance-none truncate rounded-full border border-border/70 bg-surface pl-7 pr-7 text-ui text-text shadow-xs transition-colors hover:border-border-strong focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/10"
                  >
                    {teams.map((team) => (
                      <option key={team.id} value={team.id}>
                        {team.name}
                      </option>
                    ))}
                  </select>
                  <ChevronDown
                    size={12}
                    className="pointer-events-none absolute right-2.5 text-text-tertiary"
                  />
                </label>
              )}
              <Button size="sm" className="shadow-xs" onClick={() => setCreating((value) => !value)}>
                <Plus size={14} /> {t('list.create')}
              </Button>
            </div>
          </header>

          {creating && (
            <div className="flex flex-wrap items-end gap-2 border-b border-border/70 bg-surface px-4 py-3 sm:px-6">
              <label className="flex min-w-[220px] flex-1 flex-col gap-1">
                <span className="text-[11px] font-medium text-text-tertiary">{t('list.name_label')}</span>
                <Input
                  autoFocus
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder={t('list.name_placeholder')}
                  maxLength={60}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void create()
                  }}
                />
              </label>
              <Button size="sm" loading={submitting} onClick={() => void create()}>
                {t('list.create')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                {t('action.cancel', { ns: 'common', defaultValue: '取消' })}
              </Button>
            </div>
          )}

          {teams.length === 0 ? (
            <EmptyState
              icon={Users}
              title={t('list.empty')}
              description={t('list.empty_hint')}
              action={{ label: t('list.create'), onClick: () => setCreating(true) }}
            />
          ) : (
            <>
              <nav className="mx-4 mt-3 flex w-fit max-w-[calc(100%-2rem)] items-center gap-1 overflow-x-auto rounded-full border border-border/70 bg-bg-subtle/70 p-1 sm:mx-6">
                {TABS.map((tab) => {
                  const active = tab.exact ? pathname === tab.to : pathname.startsWith(tab.to)
                  return (
                    <Link
                      key={tab.to}
                      to={tab.to}
                      className={cn(
                        'shrink-0 rounded-full px-3.5 py-1.5 text-caption transition-colors',
                        active
                          ? 'bg-surface text-text shadow-xs ring-1 ring-inset ring-border/60'
                          : 'text-text-tertiary hover:text-text-secondary',
                      )}
                    >
                      {t(tab.labelKey)}
                    </Link>
                  )
                })}
              </nav>
              <div className="mt-2 flex-1 overflow-auto">
                <div className="mx-auto w-full max-w-[1120px]">
                  <Outlet />
                </div>
              </div>
            </>
          )}
        </div>
      </AppShell>
    </ProtectedRoute>
  )
}
