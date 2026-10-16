import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { AdminShell } from '@/components/layout/AdminShell'
import { SystemConfigForm } from '@/components/admin/SystemConfigForm'
import { adminApi } from '@/lib/api/admin'
import { useToast } from '@/hooks/use-toast'
import { errorMessage } from '@/lib/errors'
import type { SystemConfigItem } from '@/types/models'

export const Route = createFileRoute('/admin/config')({
  component: AdminConfigPage,
})

function AdminConfigPage() {
  const { t } = useTranslation('admin')
  const { t: te } = useTranslation()
  const toast = useToast()
  const [items, setItems] = useState<SystemConfigItem[]>([])
  const [testing, setTesting] = useState<'sub2api' | 'chatgpt2api' | 'proxy' | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latency_ms: number } | null>(null)

  const load = async () => {
    try {
      const result = await adminApi.getConfig()
      setItems(result.items)
    } catch (error) {
      toast.error(errorMessage(error, te))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleTest = async (target: 'sub2api' | 'chatgpt2api' | 'proxy') => {
    setTesting(target)
    setTestResult(null)
    try {
      const result = await adminApi.testConfig(target)
      setTestResult(result)
      if (result.ok) toast.success(t('config.test_ok', { latency: result.latency_ms }))
      else toast.error(t('config.test_fail', { message: result.message }))
    } catch (error) {
      toast.error(errorMessage(error, te))
    } finally {
      setTesting(null)
    }
  }

  return (
    <AdminShell title={t('sidebar.config')}>
      <SystemConfigForm
        items={items}
        testing={testing}
        testResult={testResult}
        onTest={handleTest}
        onSave={async (values) => {
          try {
            await adminApi.updateConfig(values)
            toast.success(t('config.saved'))
            void load()
          } catch (error) {
            toast.error(errorMessage(error, te))
          }
        }}
      />
    </AdminShell>
  )
}
