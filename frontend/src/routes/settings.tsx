import { useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
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
import { meApi } from '@/lib/api/me'
import { useAuth } from '@/hooks/use-auth'
import { useAuthStore } from '@/stores/auth'
import { useLanguage } from '@/hooks/use-language'
import { useTheme } from '@/hooks/use-theme'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { SupportedLanguage } from '@/i18n'
import type { ThemeMode } from '@/stores/theme'

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
})

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

  return (
    <ProtectedRoute>
      <AppShell>
          <PageShell
            title={t('title')}
            width="narrow"
          >
            <div className="flex flex-col gap-5">
              <Card className="flex flex-col gap-4">
                <h2 className="text-md font-semibold text-text">{t('profile.title')}</h2>
                <FormField label={t('profile.email')}>
                  <Input value={user?.email ?? ''} disabled />
                </FormField>
                <FormField label={t('profile.display_name')}>
                  <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </FormField>
                <FormField label={t('profile.locale')}>
                  <Select value={language} onValueChange={(v) => setLanguage(v as SupportedLanguage)}>
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
                    onValueChange={(v) => setMode(v as ThemeMode, themeTriggerRef.current)}
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
                  <Button loading={savingProfile} onClick={saveProfile}>
                    {te('common:action.save')}
                  </Button>
                </div>
              </Card>

              <Card className="flex flex-col gap-4">
                <h2 className="text-md font-semibold text-text">{t('password.title')}</h2>
                <FormField label={t('password.old')}>
                  <Input type="password" value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
                </FormField>
                <FormField label={t('password.new')}>
                  <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                </FormField>
                <FormField label={t('password.confirm')}>
                  <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </FormField>
                <div className="flex justify-end">
                  <Button loading={savingPassword} onClick={changePassword}>
                    {t('password.submit')}
                  </Button>
                </div>
              </Card>

              <Card className="flex flex-col gap-3">
                <h2 className="text-md font-semibold text-text">{t('sessions.title')}</h2>
                <p className="text-sm text-text-secondary">{t('sessions.desc')}</p>
                <div className="flex justify-end">
                  <Button variant="danger" onClick={logoutAll}>
                    {t('sessions.logout_all')}
                  </Button>
                </div>
              </Card>
            </div>
          </PageShell>
      </AppShell>
    </ProtectedRoute>
  )
}
