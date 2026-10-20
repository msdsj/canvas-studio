import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Crown, Loader2, Mail, ShieldCheck, Trash2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardTitle } from '@/components/ui/card'
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
  const [email, setEmail] = useState('')
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
    const clean = email.trim().toLowerCase()
    if (!clean.includes('@')) {
      toast.error(t('members.email_label'))
      return
    }
    setInviting(true)
    try {
      await teamsApi.invite(team.id, { email: clean, role })
      setEmail('')
      await refresh()
      await loadTeams(true)
      toast.success(t('members.invite_sent'))
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setInviting(false)
    }
  }, [team, email, role, refresh, loadTeams, toast, t])

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
    <div className="flex flex-col gap-4 p-6">
      {/* 邀请区：席位满了就直接说清楚，不要等提交后才报错 */}
      {canManage && (
        <Card className="flex flex-wrap items-end gap-2 p-4">
          <label className="flex min-w-[240px] flex-1 flex-col gap-1">
            <span className="text-[11px] text-text-tertiary">{t('members.email_label')}</span>
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="name@company.com"
              disabled={seatFull}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void invite()
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-text-tertiary">{t('members.role_label')}</span>
            <select
              value={role}
              onChange={(event) => setRole(event.target.value as TeamRole)}
              disabled={seatFull}
              className="h-10 rounded-[10px] border border-border-strong bg-surface px-2 text-ui text-text"
            >
              <option value="member">{t('role.member')}</option>
              {isOwner && <option value="admin">{t('role.admin')}</option>}
            </select>
          </label>
          <Button loading={inviting} disabled={seatFull} onClick={() => void invite()}>
            <UserPlus size={14} /> {t('members.invite_submit')}
          </Button>
          {seatFull && (
            <p className="w-full text-[11px] text-danger">{t('members.seat_full')}</p>
          )}
        </Card>
      )}

      <Card className="p-0">
        <div className="flex items-center justify-between border-b border-border/70 px-4 py-3">
          <CardTitle className="text-ui">{t('members.title')}</CardTitle>
          <span className="text-caption text-text-tertiary tabular-nums">
            {t('overview.seats_value', { used: team.seat_used, total: team.seat_limit })}
          </span>
        </div>

        {loading && members.length === 0 ? (
          <p className="flex items-center justify-center gap-2 px-4 py-8 text-caption text-text-tertiary">
            <Loader2 size={14} className="animate-spin" /> …
          </p>
        ) : members.length === 0 ? (
          <p className="px-4 py-8 text-center text-caption text-text-tertiary">
            {t('members.empty')}
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {members.map((member) => {
              const self = member.user_id === user?.id
              return (
                <li key={member.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-subtle text-[12px] font-medium text-text-secondary">
                    {(member.display_name || member.email || '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1.5 truncate text-ui text-text">
                      {member.display_name || member.email}
                      {self && (
                        <span className="text-[10px] text-text-tertiary">
                          ({t('members.you')})
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
                    <span className="ml-auto flex shrink-0 items-center gap-1">
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
        <Card className="p-0">
          <div className="border-b border-border/70 px-4 py-3">
            <CardTitle className="text-ui">{t('members.pending')}</CardTitle>
          </div>
          {invites.length === 0 ? (
            <p className="px-4 py-6 text-center text-caption text-text-tertiary">
              {t('members.no_invites')}
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {invites.map((invitation) => (
                <li key={invitation.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Mail size={14} className="shrink-0 text-text-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-ui text-text">
                    {invitation.email}
                  </span>
                  <span className="shrink-0 text-[11px] text-text-tertiary">
                    {t(`role.${invitation.role}`)}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void revoke(invitation)}>
                    {t('members.revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}
