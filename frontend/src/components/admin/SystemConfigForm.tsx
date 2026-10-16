import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, Plug } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import type { SystemConfigItem } from '@/types/models'

interface SystemConfigFormProps {
  items: SystemConfigItem[]
  onSave: (values: Record<string, unknown>) => Promise<void> | void
  onTest: (target: 'sub2api' | 'chatgpt2api' | 'proxy') => void
  testing?: 'sub2api' | 'chatgpt2api' | 'proxy' | null
  testResult?: { ok: boolean; message: string; latency_ms: number } | null
}

/** 系统配置表单（掩码 + 连通性测试 + 本地/线上切换 + Demo/代理）。 */
export function SystemConfigForm({ items, onSave, onTest, testing, testResult }: SystemConfigFormProps) {
  const { t } = useTranslation('admin')
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  const grouped = useMemo(() => {
    const map = new Map<string, SystemConfigItem[]>()
    for (const item of items) {
      const list = map.get(item.category) ?? []
      list.push(item)
      map.set(item.category, list)
    }
    return Array.from(map.entries())
  }, [items])

  const setValue = (key: string, value: string) => setDraft((prev) => ({ ...prev, [key]: value }))

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setDraft({})
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" onClick={() => onTest('sub2api')} loading={testing === 'sub2api'}>
          <Plug size={15} /> 测试 sub2api
        </Button>
        <Button variant="secondary" onClick={() => onTest('chatgpt2api')} loading={testing === 'chatgpt2api'}>
          <Plug size={15} /> 测试 chatgpt2api
        </Button>
        <Button variant="secondary" onClick={() => onTest('proxy')} loading={testing === 'proxy'}>
          <Plug size={15} /> 测试代理
        </Button>
        {testResult && (
          <Badge variant={testResult.ok ? 'success' : 'danger'}>
            {testResult.ok
              ? t('config.test_ok', { latency: testResult.latency_ms })
              : t('config.test_fail', { message: testResult.message })}
          </Badge>
        )}
      </div>

      {grouped.map(([category, list]) => (
        <Card key={category} className="flex flex-col gap-4">
          <h3 className="text-md font-semibold text-text">{t(`config.category.${category}`)}</h3>
          {list.map((item) => {
            const value = draft[item.key] ?? item.value
            return (
              <div key={item.key} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-text">{item.key}</span>
                    {item.is_secret && <Badge variant="soft">secret</Badge>}
                  </div>
                  <p className="text-xs text-text-tertiary">{item.description}</p>
                </div>
                <div className="w-64 shrink-0">
                  {item.value_type === 'bool' ? (
                    <Switch
                      checked={value === 'true'}
                      onCheckedChange={(checked) => setValue(item.key, checked ? 'true' : 'false')}
                    />
                  ) : (
                    <Input
                      type={item.is_secret ? 'password' : item.value_type === 'int' ? 'number' : 'text'}
                      value={value}
                      placeholder={item.is_secret ? t('config.secret_hint') : ''}
                      onChange={(e) => setValue(item.key, e.target.value)}
                    />
                  )}
                </div>
              </div>
            )
          })}
        </Card>
      ))}

      <div className="sticky bottom-0 flex justify-end border-t border-border bg-bg py-3">
        <Button loading={saving} disabled={Object.keys(draft).length === 0} onClick={handleSave}>
          <Save size={15} /> {t('config.save')}
        </Button>
      </div>
    </div>
  )
}
