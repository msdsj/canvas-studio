import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Lock, Server } from 'lucide-react'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { aiApi, type RelayStatus } from '@/lib/api/ai'

/** Shows the platform-managed conversation model used by this enterprise. */
export function TeamModelConfigCard() {
  const { t } = useTranslation('team')
  const [status, setStatus] = useState<RelayStatus | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    void aiApi.status()
      .then((model) => { if (active) setStatus(model) })
      .catch(() => { if (active) setStatus(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])

  return (
    <Card className="flex flex-col gap-3 p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <CardTitle className="flex items-center gap-1.5 text-ui">
            <Server size={14} className="text-text-tertiary" /> {t('settings.model')}
          </CardTitle>
          <CardDescription className="mt-1">{t('settings.model_managed_note')}</CardDescription>
        </div>
        <span className="flex shrink-0 items-center gap-1 rounded-[6px] bg-bg-subtle px-2 py-1 text-[10px] text-text-tertiary">
          <Lock size={10} /> {t('settings.platform_managed')}
        </span>
      </div>
      {loading ? (
        <p className="text-caption text-text-tertiary">{t('settings.model_loading')}</p>
      ) : status?.configured ? (
        <dl className="grid gap-2 text-caption sm:grid-cols-2">
          <div className="flex flex-col">
            <dt className="text-[11px] text-text-tertiary">{t('settings.model')}</dt>
            <dd className="truncate font-mono text-[12px] text-text">{status.model}</dd>
          </div>
          <div className="flex flex-col">
            <dt className="text-[11px] text-text-tertiary">{t('settings.provider')}</dt>
            <dd className="truncate text-[12px] text-text-secondary">{status.provider_name}</dd>
          </div>
        </dl>
      ) : (
        <p className="rounded-[8px] bg-warning-subtle px-3 py-2 text-caption text-warning">
          {t('settings.platform_model_unconfigured')}
        </p>
      )}
    </Card>
  )
}
