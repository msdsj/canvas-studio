import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { teamsApi, type TeamAuditEntry } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'
import { useToast } from '@/hooks/use-toast'

export const Route = createFileRoute('/team/audit')({
  component: TeamAuditPage,
})

const PAGE_SIZE = 30

/**
 * 团队操作日志。
 *
 * 只对拥有 `member.manage` 权限的人可见（owner/admin）——日志里会有邮箱和
 * 具体操作对象，给普通成员看等于泄露同事的账号信息。
 */
function TeamAuditPage() {
  const { t, i18n } = useTranslation('team')
  const toast = useToast()
  const teams = useTeamStore((s) => s.teams)
  const activeId = useTeamStore((s) => s.activeId)
  const team = teams.find((item) => item.id === activeId) ?? null

  const [entries, setEntries] = useState<TeamAuditEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)

  const canView = team?.role === 'owner' || team?.role === 'admin'

  const load = useCallback(
    async (teamId: string, nextPage: number) => {
      setLoading(true)
      try {
        const data = await teamsApi.audit(teamId, { page: nextPage, size: PAGE_SIZE })
        setEntries(data.items)
        setTotal(data.total)
      } catch (err) {
        toast.error(errorMessage(err))
      } finally {
        setLoading(false)
      }
    },
    [toast],
  )

  useEffect(() => {
    if (!team || !canView) {
      setLoading(false)
      return
    }
    void load(team.id, page)
  }, [team, canView, page, load])

  if (!team) return null

  if (!canView) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
        <ShieldAlert size={22} className="text-text-faint" />
        <p className="text-caption text-text-secondary">{t('audit.forbidden')}</p>
      </div>
    )
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="flex flex-col gap-3 p-4 sm:p-6">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-ui font-semibold text-text">{t('audit.title')}</h2>
          <p className="text-[11px] text-text-tertiary">{t('audit.subtitle')}</p>
        </div>
        {total > 0 && (
          <span className="rounded-full bg-bg-subtle px-2.5 py-1 text-[10px] tabular-nums text-text-tertiary">
            {total}
          </span>
        )}
      </header>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={16} className="animate-spin text-text-tertiary" />
        </div>
      ) : entries.length === 0 ? (
        <p className="py-12 text-center text-caption text-text-tertiary">{t('audit.empty')}</p>
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-caption">
              <thead className="sticky top-0 bg-bg-subtle text-[10px] uppercase tracking-[0.06em] text-text-tertiary">
                <tr>
                  <th className="px-4 py-2.5 font-medium">{t('audit.time')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('audit.actor')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('audit.action')}</th>
                  <th className="px-4 py-2.5 font-medium">{t('audit.detail')}</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.id}
                    className="border-t border-border/50 transition-colors hover:bg-surface-hover/50"
                  >
                    <td className="whitespace-nowrap px-4 py-2.5 tabular-nums text-text-tertiary">
                      {entry.created_at
                        ? new Date(entry.created_at).toLocaleString(
                            i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US',
                            { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
                          )
                        : '—'}
                    </td>
                    <td className="max-w-[200px] truncate px-4 py-2.5 text-text-secondary">
                      {entry.actor_email || '—'}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="inline-flex items-center rounded-md bg-bg-subtle px-1.5 py-0.5 font-mono text-[10px] text-text-secondary ring-1 ring-inset ring-border/50">
                        {entry.action}
                      </span>
                    </td>
                    <td className="max-w-[360px] truncate px-4 py-2.5 text-text-tertiary">
                      {entry.detail ? String(entry.detail) : entry.target_id || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {pages > 1 && (
        <div className="mx-auto mt-1 flex w-fit items-center gap-1 rounded-full border border-border/70 bg-surface p-1 shadow-xs">
          <Button
            size="sm"
            variant="ghost"
            disabled={page <= 1}
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
          >
            {t('audit.prev')}
          </Button>
          <span className="px-1 text-[11px] tabular-nums text-text-tertiary">
            {page} / {pages}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={page >= pages}
            onClick={() => setPage((prev) => Math.min(pages, prev + 1))}
          >
            {t('audit.next')}
          </Button>
        </div>
      )}
    </div>
  )
}
