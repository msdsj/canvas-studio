import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Save, Plug } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import type { SystemConfigItem } from '@/types/models'

interface SystemConfigFormProps {
  items: SystemConfigItem[]
  onSave: (values: Record<string, unknown>) => Promise<void> | void
  onTest: (target: 'text' | 'image' | 'llm' | 'pool' | 'proxy') => void
  testing?: 'text' | 'image' | 'llm' | 'pool' | 'proxy' | null
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
        <Button variant="secondary" onClick={() => onTest('text')} loading={testing === 'text'}>
          <Plug size={15} /> 测试文本服务
        </Button>
        <Button variant="secondary" onClick={() => onTest('image')} loading={testing === 'image'}>
          <Plug size={15} /> 测试图片服务
        </Button>
        <Button variant="secondary" onClick={() => onTest('llm')} loading={testing === 'llm'}>
          <Plug size={15} /> 测试意图模型
        </Button>
        <Button variant="secondary" onClick={() => onTest('pool')} loading={testing === 'pool'}>
          <Plug size={15} /> 测试账号池
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
            const multiline = item.value_type === 'json' || item.key.startsWith('PROMPT_')
            return (
              <div key={item.key} className={multiline ? 'flex flex-col gap-2' : 'flex items-start justify-between gap-4'}>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-text">{item.key}</span>
                    {item.is_secret && <Badge variant="soft">secret</Badge>}
                  </div>
                  <p className="text-xs text-text-tertiary">{item.description}</p>
                </div>
                <div className={multiline ? 'w-full' : 'w-64 shrink-0'}>
                  {item.value_type === 'bool' ? (
                    <Switch
                      checked={value === 'true'}
                      onCheckedChange={(checked) => setValue(item.key, checked ? 'true' : 'false')}
                    />
                  ) : multiline ? (
                    <Textarea
                      value={value}
                      rows={item.value_type === 'json' ? 10 : 7}
                      spellCheck={false}
                      className="font-mono text-xs"
                      placeholder={item.is_secret ? t('config.secret_hint') : ''}
                      onChange={(e) => setValue(item.key, e.target.value)}
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
