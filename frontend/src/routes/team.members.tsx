import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Copy, Crown, Link2, Loader2, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { useAuth } from '@/hooks/use-auth'
import {
  teamsApi,
  type TeamInvitation,
  type TeamMember,
  type TeamRole,
} from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { useTeamStore } from '@/stores/team'
import { cn } from '@/lib/utils'

export const Route = createFileRoute('/team/members')({
  component: TeamMembersPage,
})

const ROLE_BADGE: Record<TeamRole, string> = {
  owner: 'bg-accent-soft text-accent-ink ring-accent-strong',
  admin: 'bg-bg-subtle text-text-secondary ring-border-strong',
  member: 'bg-bg-subtle text-text-tertiary ring-border/70',
}

function TeamMembersPage() {
  const { t } = useTranslation('team')
  const toast = useToast()
  const { user } = useAuth()
  const teams = useTeamStore((s) => s.teams)
  const activeId = useTeamStore((s) => s.activeId)
  const loadTeams = useTeamStore((s) => s.load)
  const team = teams.find((item) => item.id === activeId) ?? null

  const [members, setMembers] = useState<TeamMember[]>([])
  const [invites, setInvites] = useState<TeamInvitation[]>([])
  const [loading, setLoading] = useState(false)
  const [inviteLink, setInviteLink] = useState('')
  const [role, setRole] = useState<TeamRole>('member')
  const [inviting, setInviting] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const isOwner = team?.role === 'owner'
  const canManage = isOwner || Boolean(team?.permissions?.includes('member.manage'))

  const refresh = useCallback(async () => {
    if (!team) return
    setLoading(true)
    try {
      const [memberList, inviteList] = await Promise.all([
        teamsApi.members(team.id),
        canManage ? teamsApi.invitations(team.id).catch(() => [] as TeamInvitation[]) : Promise.resolve([]),
      ])
      setMembers(memberList)
      setInvites(inviteList)
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [team, canManage, toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const invite = useCallback(async () => {
    if (!team) return
    setInviting(true)
    try {
      const inviteData = await teamsApi.invite(team.id, { email: '', role })
      const link = new URL(`/team/join?token=${inviteData.token}`, window.location.origin).toString()
      setInviteLink(link)
      await refresh()
      await loadTeams(true)
      try {
        await navigator.clipboard.writeText(link)
        toast.success(t('members.invite_link_copied'))
      } catch {
        toast.info(t('members.copy_link_hint'))
      }
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setInviting(false)
    }
  }, [team, role, refresh, loadTeams, toast, t])

  const copyInvite = async (token: string) => {
    const link = new URL(`/team/join?token=${token}`, window.location.origin).toString()
    try {
      await navigator.clipboard.writeText(link)
      toast.success(t('members.invite_link_copied'))
    } catch {
      setInviteLink(link)
      toast.info(t('members.copy_link_hint'))
    }
  }

  const changeRole = useCallback(
    async (member: TeamMember) => {
      if (!team) return
      // 只在 admin / member 之间切换；owner 只能通过「转让」变更
      const next: TeamRole = member.role === 'admin' ? 'member' : 'admin'
      setBusyId(member.id)
      try {
        const updated = await teamsApi.updateMember(team.id, member.id, { role: next })
        setMembers(updated)
        await loadTeams(true)
      } catch (err) {
        toast.error(errorMessage(err))
      } finally {
        setBusyId(null)
      }
    },
    [team, loadTeams, toast],
  )

  const remove = useCallback(
    async (member: TeamMember) => {
      if (!team) return
      if (!window.confirm(t('members.remove_confirm'))) return
      setBusyId(member.id)
      try {
        await teamsApi.removeMember(team.id, member.id)
        await refresh()
        await loadTeams(true)
      } catch (err) {
        toast.error(errorMessage(err))
      } finally {
        setBusyId(null)
      }
    },
    [team, refresh, loadTeams, toast, t],
  )

  const transfer = useCallback(
    async (member: TeamMember) => {
      if (!team) return
      if (!window.confirm(t('members.transfer_confirm'))) return
      setBusyId(member.id)
      try {
        await teamsApi.transfer(team.id, member.id)
        await refresh()
        await loadTeams(true)
        toast.success(t('members.transfer_done'))
      } catch (err) {
        toast.error(errorMessage(err))
      } finally {
        setBusyId(null)
      }
    },
    [team, refresh, loadTeams, toast, t],
  )

  const revoke = useCallback(
    async (invitation: TeamInvitation) => {
      if (!team) return
      try {
        await teamsApi.revokeInvite(team.id, invitation.id)
        await refresh()
      } catch (err) {
        toast.error(errorMessage(err))
      }
    },
    [team, refresh, toast],
  )

  if (!team) return null

  const seatFull = team.seat_used >= team.seat_limit

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      {/* 邀请区：席位满了就直接说清楚，不要等提交后才报错 */}
      {canManage && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-start gap-2.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent-ink ring-1 ring-inset ring-accent-strong/20">
              <UserPlus size={15} />
            </span>
            <div className="flex min-w-0 flex-col">
              <CardTitle className="text-ui">{t('members.invite')}</CardTitle>
              <CardDescription className="mt-0.5 text-caption text-text-tertiary">
                {t('members.invite_hint')}
              </CardDescription>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-[132px_auto] sm:items-end">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-text-tertiary">{t('members.role_label')}</span>
              <select
                value={role}
                onChange={(event) => setRole(event.target.value as TeamRole)}
                disabled={seatFull}
                className="h-10 rounded-[10px] border border-border-strong bg-surface px-2.5 text-ui text-text transition-colors hover:border-border-strong focus:border-brand focus:outline-none focus:ring-4 focus:ring-brand/10 disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-text-tertiary"
              >
                <option value="member">{t('role.member')}</option>
                {isOwner && <option value="admin">{t('role.admin')}</option>}
              </select>
            </label>
            <Button className="sm:self-end" loading={inviting} disabled={seatFull} onClick={() => void invite()}>
              <UserPlus size={14} /> {t('members.invite_submit')}
            </Button>
          </div>

          {inviteLink && (
            <div className="flex flex-wrap items-center gap-2 rounded-[8px] border border-border bg-bg-subtle/60 p-2">
              <Input readOnly value={inviteLink} className="min-w-[220px] flex-1 font-mono text-[11px]" />
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(inviteLink)
                  toast.success(t('members.invite_link_copied'))
                }}
              >
                <Copy size={13} /> {t('members.copy_link')}
              </Button>
            </div>
          )}

          {seatFull && (
            <p className="text-[11px] text-danger">{t('members.seat_full')}</p>
          )}
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="flex items-center gap-2">
            <CardTitle className="text-ui">{t('members.title')}</CardTitle>
            <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] tabular-nums text-text-tertiary">
              {members.length}
            </span>
          </div>
          <span className="text-caption text-text-tertiary tabular-nums">
            {t('overview.seats_value', { used: team.seat_used, total: team.seat_limit })}
          </span>
        </div>

        {loading && members.length === 0 ? (
          <div className="flex items-center justify-center gap-2 px-4 py-10 text-caption text-text-tertiary">
            <Loader2 size={14} className="animate-spin" /> …
          </div>
        ) : members.length === 0 ? (
          <p className="px-4 py-10 text-center text-caption text-text-tertiary">
            {t('members.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border/50">
            {members.map((member) => {
              const self = member.user_id === user?.id
              const name = member.display_name || member.email || '?'
              return (
                <li
                  key={member.id}
                  className="group flex flex-wrap items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-hover/50"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[linear-gradient(140deg,var(--color-accent-soft),var(--color-brand-subtle))] text-[12px] font-semibold uppercase text-accent-ink ring-1 ring-inset ring-border/60">
                    {name.slice(0, 1)}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 truncate text-ui font-medium text-text">
                      {name}
                      {self && (
                        <span className="rounded-full bg-bg-subtle px-1.5 py-px text-[10px] font-normal text-text-tertiary">
                          {t('members.you')}
                        </span>
                      )}
                    </span>
                    <span className="truncate text-[11px] text-text-tertiary">
                      {member.display_name ? member.email : member.user_id}
                    </span>
                  </span>

                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset',
                      ROLE_BADGE[member.role],
                    )}
                  >
                    {member.role === 'owner' && <Crown size={10} className="mr-0.5 inline" />}
                    {t(`role.${member.role}`)}
                  </span>
                  {member.status !== 'active' && (
                    <span className="shrink-0 rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] text-text-tertiary">
                      {t(`status.${member.status}`)}
                    </span>
                  )}

                  {canManage && member.role !== 'owner' && !self && (
                    <span className="ml-auto flex shrink-0 items-center gap-0.5 transition-opacity sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      {isOwner && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          title={t('members.transfer')}
                          disabled={busyId === member.id}
                          onClick={() => void transfer(member)}
                        >
                          <Crown size={14} />
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busyId === member.id || (member.role === 'admin' && !isOwner)}
                        onClick={() => void changeRole(member)}
                      >
                        <ShieldCheck size={14} />
                        {member.role === 'admin' ? t('members.demote') : t('members.promote')}
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title={t('members.remove')}
                        disabled={busyId === member.id}
                        onClick={() => void remove(member)}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {canManage && (
        <Card className="overflow-hidden p-0">
          <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
            <CardTitle className="text-ui">{t('members.pending')}</CardTitle>
            {invites.length > 0 && (
              <span className="rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] tabular-nums text-text-tertiary">
                {invites.length}
              </span>
            )}
          </div>
          {invites.length === 0 ? (
            <p className="px-4 py-8 text-center text-caption text-text-tertiary">
              {t('members.no_invites')}
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {invites.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-surface-hover/50"
                >
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-text-tertiary">
                  <Link2 size={13} />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-ui text-text">
                    {invitation.email || t('members.link_invite')}
                  </span>
                  <span className="shrink-0 rounded-full bg-bg-subtle px-2 py-0.5 text-[10px] text-text-secondary">
                    {t(`role.${invitation.role}`)}
                  </span>
                  <div className="ml-auto flex shrink-0 items-center gap-1">
                    {invitation.token && (
                      <Button size="sm" variant="ghost" onClick={() => void copyInvite(invitation.token!)}>
                        <Copy size={13} /> {t('members.copy_link')}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => void revoke(invitation)}>
                      {t('members.revoke')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}
