import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { Cpu, LogOut, ShieldCheck, User } from 'lucide-react'
import { AppShell } from '@/components/layout/AppShell'
import { ProtectedRoute } from '@/components/layout/ProtectedRoute'
import { PageShell } from '@/components/layout/PageShell'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FormField } from '@/components/ui/form-field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AIConfigDialog } from '@/components/ai/AIConfigDialog'
import { meApi } from '@/lib/api/me'
import { aiApi, type RelayStatus } from '@/lib/api/ai'
import { useAuth } from '@/hooks/use-auth'
import { useAuthStore } from '@/stores/auth'
import { useLanguage } from '@/hooks/use-language'
import { useTheme } from '@/hooks/use-theme'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

/**
 * 账户设置。
 *
 * v3 改动：从「一列卡片堆叠」改成 **左分区导航 + 右内容**（左 184px / 列间距 32px /
 * 右列 ≤720px）。改造前四块内容（资料 / 密码 / 中转站 / 会话）平铺在一条窄列里，
 * 用户找不到"AI 中转站在哪"，而它恰恰是最需要被看见的一块。
 */
function SettingsPage() {
  const { t } = useTranslation('settings')
  const { t: te } = useTranslation()
  const toast = useToast()
  const navigate = useNavigate()
  const { user, logout } = useAuth()
  const setUser = useAuthStore((s) => s.setUser)
  const { language, setLanguage, options: languages } = useLanguage()
  const { mode, setMode } = useTheme()
  /** 主题下拉的触发器：扩散以它为圆心 */
  const themeTriggerRef = useRef<HTMLButtonElement>(null)

  const [displayName, setDisplayName] = useState(user?.display_name ?? '')
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [savingProfile, setSavingProfile] = useState(false)
  const [savingPassword, setSavingPassword] = useState(false)
  const [relay, setRelay] = useState<RelayStatus | null>(null)
  const [relayOpen, setRelayOpen] = useState(false)

  useEffect(() => {
    setDisplayName(user?.display_name ?? '')
  }, [user?.display_name])

  /*
   * AI 服务由平台超管统一配置，配置后所有用户共用一套；
   * 普通用户与团队管理员都不需要（也不应该）看到这个入口。
   */
  const isSuperAdmin = user?.role === 'admin'

  useEffect(() => {
    if (!isSuperAdmin) return
    void aiApi
      .status()
      .then(setRelay)
      .catch(() => setRelay(null))
  }, [isSuperAdmin])

  const saveProfile = async () => {
    setSavingProfile(true)
    try {
      const updated = await meApi.updateProfile({ display_name: displayName })
      setUser(updated)
      toast.success(t('profile.saved'))
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setSavingProfile(false)
    }
  }

  const changePassword = async () => {
    if (newPassword !== confirm) {
      toast.error(te('auth:validation.password_mismatch'))
      return
    }
    setSavingPassword(true)
    try {
      await meApi.changePassword(oldPassword, newPassword)
      toast.success(t('password.success'))
      await logout()
      void navigate({ to: '/login' })
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setSavingPassword(false)
    }
  }

  const logoutAll = async () => {
    try {
      await meApi.logoutAll()
      toast.success(t('sessions.logout_all_success'))
      await logout()
      void navigate({ to: '/login' })
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  const sections = [
    { id: 'profile', label: t('nav.profile'), icon: User },
    // 「AI 中转站」只对平台超管开放：配置是全站共用的，普通用户改了会直接影响所有人
    ...(isSuperAdmin ? [{ id: 'relay', label: t('nav.relay'), icon: Cpu }] : []),
    { id: 'security', label: t('nav.security'), icon: ShieldCheck },
    { id: 'danger', label: t('nav.danger'), icon: LogOut },
  ]

  return (
    <ProtectedRoute>
      <AppShell>
        <PageShell title={t('title')} description={t('subtitle')}>
          <div className="flex gap-8">
            <nav className="hidden w-[184px] shrink-0 flex-col gap-1 lg:flex">
              {sections.map((section) => {
                const Icon = section.icon
                return (
                  <a
                    key={section.id}
                    href={`#${section.id}`}
                    className="flex items-center gap-2.5 rounded-[10px] px-3 py-2 text-ui text-text-secondary transition-colors hover:bg-surface-hover hover:text-text"
                  >
                    <Icon size={16} />
                    {section.label}
                  </a>
                )
              })}
            </nav>

            <div className="flex min-w-0 flex-1 flex-col gap-5 lg:max-w-[720px]">
              {/* ---------- 账户资料 ---------- */}
              <Card id="profile" className="flex scroll-mt-24 flex-col gap-4">
                <div>
                  <h2 className="text-md font-semibold text-text">{t('profile.title')}</h2>
                  <p className="mt-1 text-caption text-text-tertiary">{t('profile.desc')}</p>
                </div>
                <FormField label={t('profile.email')}>
                  <Input value={user?.email ?? ''} disabled />
                </FormField>
                <FormField label={t('profile.display_name')}>
                  <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </FormField>
                <FormField label={t('profile.locale')}>
                  <Select value={language} onValueChange={(v) => setLanguage(v as never)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {languages.map((item) => (
                        <SelectItem key={item.code} value={item.code}>
                          {item.nativeName}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormField>
                <FormField label={t('profile.theme')}>
                  <Select
                    value={mode}
                    onValueChange={(v) => setMode(v as 'light' | 'dark' | 'system', themeTriggerRef.current)}
                  >
                    <SelectTrigger ref={themeTriggerRef}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="light">{te('common:theme.light')}</SelectItem>
                      <SelectItem value="dark">{te('common:theme.dark')}</SelectItem>
                      <SelectItem value="system">{te('common:theme.system')}</SelectItem>
                    </SelectContent>
                  </Select>
                </FormField>
                <div className="flex justify-end">
                  <Button loading={savingProfile} onClick={() => void saveProfile()}>
                    {te('common:action.save')}
                  </Button>
                </div>
              </Card>

              {/* ---------- AI 中转站（仅平台超管） ---------- */}
              {isSuperAdmin && (
                <Card id="relay" className="flex scroll-mt-24 flex-col gap-3">
                  <div>
                    <h2 className="text-md font-semibold text-text">{t('relay.title')}</h2>
                    <p className="mt-1 text-caption text-text-tertiary">{t('relay.desc')}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-[12px] bg-bg-subtle px-4 py-3">
                    <RelayFact
                      label={t('relay.status')}
                      value={relay?.configured ? t('relay.ready') : t('relay.not_ready')}
                      ok={relay?.configured}
                    />
                    <RelayFact label={t('relay.model')} value={relay?.model || '—'} />
                    <RelayFact label={t('relay.source')} value={relay?.provider_name || '—'} />
                  </div>
                  <div className="flex justify-end">
                    <Button variant="secondary" onClick={() => setRelayOpen(true)}>
                      {t('relay.manage')}
                    </Button>
                  </div>
                </Card>
              )}

              {/* ---------- 安全 ---------- */}
              <Card id="security" className="flex scroll-mt-24 flex-col gap-4">
                <div>
                  <h2 className="text-md font-semibold text-text">{t('password.title')}</h2>
                  <p className="mt-1 text-caption text-text-tertiary">{t('password.desc')}</p>
                </div>
                <FormField label={t('password.old')}>
                  <Input
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                  />
                </FormField>
                <FormField label={t('password.new')}>
                  <Input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                  />
                </FormField>
                <FormField label={t('password.confirm')}>
                  <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </FormField>
                <div className="flex justify-end">
                  <Button loading={savingPassword} onClick={() => void changePassword()}>
                    {t('password.submit')}
                  </Button>
                </div>
              </Card>

              {/* ---------- 危险操作 ---------- */}
              <Card id="danger" className="flex scroll-mt-24 flex-col gap-3 border-danger/30">
                <div>
                  <h2 className="text-md font-semibold text-danger">{t('danger.title')}</h2>
                  <p className="mt-1 text-caption text-text-tertiary">{t('sessions.desc')}</p>
                </div>
                <div className="flex justify-end">
                  <Button variant="danger" onClick={() => void logoutAll()}>
                    <LogOut size={15} /> {t('sessions.logout_all')}
                  </Button>
                </div>
              </Card>
            </div>
          </div>
        </PageShell>
      </AppShell>

      <AIConfigDialog open={relayOpen} onOpenChange={setRelayOpen} />
    </ProtectedRoute>
  )
}

function RelayFact({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-micro text-text-tertiary">{label}</span>
      <span className="flex items-center gap-1.5 truncate text-caption font-medium text-text">
        {ok !== undefined && (
          <span
            aria-hidden
            className={
              ok
                ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-success'
                : 'h-1.5 w-1.5 shrink-0 rounded-full bg-text-faint'
            }
          />
        )}
        {value}
      </span>
    </div>
  )
}
