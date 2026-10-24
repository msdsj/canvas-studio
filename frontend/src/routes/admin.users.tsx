import { useCallback, useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Search, UserPlus } from 'lucide-react'
import { AdminShell } from '@/components/layout/AdminShell'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { BulkBar } from '@/components/admin/BulkBar'
import { UserTable } from '@/components/admin/UserTable'
import { TableCard } from '@/components/ui/table'
import { QuotaAssignDialog } from '@/components/admin/QuotaAssignDialog'
import { CreateUserDialog } from '@/components/admin/CreateUserDialog'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import { ConfirmModal, Modal } from '@/components/ui/modal'
import { FormField } from '@/components/ui/form-field'
import type { AdminUser } from '@/types/models'

export const Route = createFileRoute('/admin/users')({
  component: AdminUsersPage,
})

function AdminUsersPage() {
  const { t } = useTranslation('admin')
  const { t: te } = useTranslation()
  const toast = useToast()

  const [users, setUsers] = useState<AdminUser[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [size, setSize] = useState(20)
  const [q, setQ] = useState('')
  const [role, setRole] = useState('')
  const [status, setStatus] = useState('')
  const [loading, setLoading] = useState(true)
  const [quotaTarget, setQuotaTarget] = useState<AdminUser | null>(null)
  const [banTarget, setBanTarget] = useState<AdminUser | null>(null)
  const [proTarget, setProTarget] = useState<AdminUser | null>(null)
  const [proDuration, setProDuration] = useState('720')
  const [createOpen, setCreateOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await adminApi.listUsers({ page, size, q: q || undefined, role: role || undefined, status: status || undefined })
      setUsers(result.items)
      setTotal(result.total)
      setSelected([])
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size, q, role, status])

  useEffect(() => {
    void load()
  }, [load])

  const resetPassword = async (user: AdminUser) => {
    try {
      const result = await adminApi.resetUserPassword(user.id)
      toast.success(t('users.reset_result', { password: result.temp_password }))
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const resend = async (user: AdminUser) => {
    try {
      await adminApi.resendVerification(user.id)
      toast.success(t('common:status.success', { defaultValue: '已发送' }))
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  /** 批量操作：逐个调用现有接口，统计成功/失败后再统一提示；失败不影响其余行 */
  const runBulk = async (ids: string[], task: (id: string) => Promise<unknown>) => {
    const results = await Promise.allSettled(ids.map(task))
    const ok = results.filter((r) => r.status === 'fulfilled').length
    const failed = results.length - ok
    if (failed === 0) toast.success(t('bulk.done', { count: ok }))
    else toast.error(t('bulk.partial', { ok, failed }))
    void load()
  }

  return (
    <AdminShell
      title={t('sidebar.users')}
      description={t('users.hint')}
    >
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative w-64">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            className="pl-9"
            placeholder={t('users.search')}
            value={q}
            onChange={(e) => {
              setQ(e.target.value)
              setPage(1)
            }}
          />
        </div>
        <Select value={role || 'all'} onValueChange={(v) => { setRole(v === 'all' ? '' : v); setPage(1) }}>
          <SelectTrigger className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('users.role_all')}</SelectItem>
            <SelectItem value="admin">admin</SelectItem>
            <SelectItem value="user">user</SelectItem>
          </SelectContent>
        </Select>
        <Select value={status || 'all'} onValueChange={(v) => { setStatus(v === 'all' ? '' : v); setPage(1) }}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('users.status_all')}</SelectItem>
            <SelectItem value="active">active</SelectItem>
            <SelectItem value="pending_verification">pending_verification</SelectItem>
            <SelectItem value="banned">banned</SelectItem>
          </SelectContent>
        </Select>
        <Button className="ml-auto" onClick={() => setCreateOpen(true)}>
          <UserPlus size={15} />
          {t('users.create')}
        </Button>
      </div>

      <BulkBar
        count={selected.length}
        onClear={() => setSelected([])}
        actions={[
          {
            label: t('bulk.ban'),
            danger: true,
            onClick: () => void runBulk(selected, (id) => adminApi.banUser(id, t('bulk.ban_reason'))),
          },
          {
            label: t('bulk.unban'),
            onClick: () => void runBulk(selected, (id) => adminApi.unbanUser(id)),
          },
          {
            label: t('bulk.resend'),
            onClick: () => void runBulk(selected, (id) => adminApi.resendVerification(id)),
          },
        ]}
      />

      {/* 表格包进卡片：改造前表头横条直接铺在页面底色上，看起来像"表没画完" */}
      <TableCard>
        <UserTable
          users={users}
          loading={loading}
          selected={selected}
          onToggleRow={(user) =>
            setSelected((prev) => (prev.includes(user.id) ? prev.filter((id) => id !== user.id) : [...prev, user.id]))
          }
          onToggleAll={() =>
            setSelected((prev) => (prev.length === users.length ? [] : users.map((user) => user.id)))
          }
          onAssignQuota={setQuotaTarget}
          onGrantPro={setProTarget}
          onBan={setBanTarget}
          onUnban={(user) =>
            adminApi.unbanUser(user.id).then(() => void load()).catch((e) => toast.error(errorMessage(e, te)))
          }
          onResetPassword={resetPassword}
          onResend={resend}
        />
      </TableCard>

      {/* 分页条是表格卡的兄弟节点：放进卡里会被 overflow-hidden 吃掉，长表时看不见 */}
      <Pagination
        page={page}
        size={size}
        total={total}
        onPageChange={setPage}
        onSizeChange={(s) => {
          setSize(s)
          setPage(1)
        }}
      />

      <QuotaAssignDialog
        user={quotaTarget}
        onOpenChange={(open) => !open && setQuotaTarget(null)}
        onSubmit={async (payload) => {
          if (!quotaTarget) return
          try {
            await adminApi.adjustQuota(quotaTarget.id, payload)
            toast.success(t('quota_dialog.success'))
            void load()
          } catch (error) {
            toast.error(errorMessage(error, te))
          }
        }}
      />

      <CreateUserDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={async (payload) => {
          try {
            await adminApi.createUser(payload)
            toast.success(
              t('create_user_dialog.success'),
              payload.team_name ? `${payload.email} · ${payload.team_name}` : payload.email,
            )
            void load()
          } catch (error) {
            toast.error(errorMessage(error, te))
          }
        }}
      />

      {/* 超管直接开通 Pro：按时长卖卡，到期由后端自动降级 */}
      <Modal
        open={Boolean(proTarget)}
        onOpenChange={(open) => !open && setProTarget(null)}
        title={t('pro_grant.title')}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setProTarget(null)}>
              {t('common:cancel', { defaultValue: '取消' })}
            </Button>
            <Button
              onClick={async () => {
                if (!proTarget) return
                try {
                  await adminApi.grantPro(proTarget.id, Number(proDuration))
                  toast.success(t('pro_grant.success', { email: proTarget.email }))
                  setProTarget(null)
                  void load()
                } catch (error) {
                  toast.error(errorMessage(error, te))
                }
              }}
            >
              {t('common:action.confirm', { defaultValue: '确定' })}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-caption text-text-secondary">
            {t('pro_grant.target')}：{proTarget?.email}
          </p>
          <FormField label={t('pro_grant.duration')}>
            <Select value={proDuration} onValueChange={setProDuration}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">{t('pro_codes.duration_hour')}</SelectItem>
                <SelectItem value="24">{t('pro_codes.duration_day')}</SelectItem>
                <SelectItem value="168">{t('pro_codes.duration_week')}</SelectItem>
                <SelectItem value="720">{t('pro_codes.duration_month')}</SelectItem>
                <SelectItem value="0">{t('pro_codes.duration_permanent')}</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <p className="text-caption leading-relaxed text-text-tertiary">{t('pro_grant.hint')}</p>
        </div>
      </Modal>

      <ConfirmModal
        open={Boolean(banTarget)}
        onOpenChange={(open) => !open && setBanTarget(null)}
        title={t('users.ban')}
        description={banTarget?.email}
        danger
        confirmLabel={t('users.ban')}
        onConfirm={async () => {
          if (!banTarget) return
          try {
            await adminApi.banUser(banTarget.id, t('users.ban_reason'))
            setBanTarget(null)
            void load()
          } catch (error) {
            toast.error(errorMessage(error, te))
          }
        }}
      />
    </AdminShell>
  )
}
