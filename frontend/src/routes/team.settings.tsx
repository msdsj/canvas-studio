import { useCallback, useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, Settings2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { TeamModelConfigCard } from '@/components/team/TeamModelConfigCard'
import { TeamSkillsCard } from '@/components/team/TeamSkillsCard'
import { useToast } from '@/hooks/use-toast'
import { teamsApi } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'

export const Route = createFileRoute('/team/settings')({
  component: TeamSettingsPage,
})

function TeamSettingsPage() {
  const { t } = useTranslation('team')
  const toast = useToast()
  const navigate = useNavigate()
  const teams = useTeamStore((s) => s.teams)
  const activeId = useTeamStore((s) => s.activeId)
  const loadTeams = useTeamStore((s) => s.load)
  const switchTo = useTeamStore((s) => s.switchTo)
  const team = teams.find((item) => item.id === activeId) ?? null

  const [name, setName] = useState('')
  const [seatLimit, setSeatLimit] = useState(5)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!team) return
    setName(team.name)
    setSeatLimit(team.seat_limit)
  }, [team])

  const isOwner = team?.role === 'owner'

  const save = useCallback(async () => {
    if (!team) return
    setSaving(true)
    try {
      await teamsApi.update(team.id, { name: name.trim(), seat_limit: seatLimit })
      await loadTeams(true)
      toast.success(t('settings.saved'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [team, name, seatLimit, loadTeams, toast, t])

  const toggle = useCallback(
    async (key: 'shared_quota', value: boolean) => {
      if (!team) return
      try {
        await teamsApi.update(team.id, { [key]: value })
        await loadTeams(true)
      } catch (err) {
        toast.error(errorMessage(err))
      }
    },
    [team, loadTeams, toast],
  )

  const remove = useCallback(async () => {
    if (!team) return
    if (!window.confirm(t('settings.delete_confirm'))) return
    setDeleting(true)
    try {
      await teamsApi.remove(team.id)
      await switchTo(null)
      await loadTeams(true)
      toast.success(t('settings.deleted'))
      void navigate({ to: '/workspace' })
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setDeleting(false)
    }
  }, [team, switchTo, loadTeams, navigate, toast, t])

  if (!team) {
    return (
      <div className="flex items-center justify-center p-10">
        <Loader2 size={16} className="animate-spin text-text-tertiary" />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <TeamModelConfigCard />

      <Card className="flex flex-col gap-4 p-4 sm:p-5">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-bg-subtle text-text-secondary ring-1 ring-inset ring-border/70">
            <Settings2 size={15} />
          </span>
          <div className="flex flex-col">
            <CardTitle className="text-ui">{t('settings.general')}</CardTitle>
            <CardDescription className="text-caption text-text-tertiary">
              {t('settings.name_label')} · {t('settings.seats_label')}
            </CardDescription>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-tertiary">{t('settings.name_label')}</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={!isOwner}
              maxLength={60}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-tertiary">
              {t('settings.seats_label')}
              <span className="ml-1">
                （{t('settings.seats_used', { used: team.seat_used })}）
              </span>
            </span>
            <Input
              type="number"
              min={Math.max(1, team.seat_used)}
              max={500}
              value={seatLimit}
              onChange={(event) => setSeatLimit(Number(event.target.value) || 1)}
              disabled={!isOwner}
            />
          </label>
        </div>

        {isOwner && (
          <Button size="sm" className="self-start" loading={saving} onClick={() => void save()}>
            {t('settings.save')}
          </Button>
        )}
      </Card>

      <Card className="flex flex-col gap-0 p-0">
        <div className="flex items-start justify-between gap-4 p-4 sm:p-5">
          <div className="flex flex-col">
            <CardTitle className="text-ui">{t('settings.shared_quota')}</CardTitle>
            <CardDescription className="mt-1 text-caption">{t('settings.shared_quota_hint')}</CardDescription>
          </div>
          <Switch
            checked={team.shared_quota}
            disabled={!isOwner}
            onCheckedChange={(checked) => void toggle('shared_quota', checked)}
          />
        </div>

      </Card>

      <TeamSkillsCard teamId={team.id} editable={isOwner} />

      {isOwner && (
        <Card className="flex flex-wrap items-center justify-between gap-3 border-danger/40 bg-danger/[0.03] p-4 sm:p-5">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-danger/10 text-danger">
              <AlertTriangle size={15} />
            </span>
            <div className="flex flex-col">
              <CardTitle className="text-ui text-danger">{t('settings.danger')}</CardTitle>
              <CardDescription className="mt-0.5 text-caption">{t('settings.delete_confirm')}</CardDescription>
            </div>
          </div>
          <Button variant="danger" size="sm" loading={deleting} onClick={() => void remove()}>
            <Trash2 size={13} /> {t('settings.delete')}
          </Button>
        </Card>
      )}
    </div>
  )
}
