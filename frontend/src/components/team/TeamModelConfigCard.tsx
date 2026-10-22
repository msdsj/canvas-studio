import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Loader2, Lock, Server } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { aiApi, type ProviderKindPreset } from '@/lib/api/ai'
import { teamsApi, type TeamModelConfig } from '@/lib/api/teams'
import { errorMessage } from '@/lib/errors'
import { cn } from '@/lib/utils'

interface TeamModelConfigCardProps {
  teamId: string
  /** 只有超级管理员能改；成员看到的是只读视图 */
  editable: boolean
  onSaved?: () => void
}

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-caption text-text placeholder:text-text-tertiary focus:border-brand focus:outline-none disabled:cursor-not-allowed disabled:bg-bg-subtle disabled:text-text-tertiary'

/**
 * 团队对话模型配置。
 *
 * 这是需求里最硬的一条规则：**只有超级管理员能配模型，成员全部用管理员配的那套**。
 * 前端这一层做两件事：
 * 1. 成员进来看到的是只读视图（不是「能点但保存会 403」——那是最糟的体验）；
 * 2. 把「为什么你改不了」写在界面上，避免用户以为是 bug。
 *
 * 后端的 `_guard_personal_config` 才是真正的门禁，这里只是让界面说真话。
 */
export function TeamModelConfigCard({ teamId, editable, onSaved }: TeamModelConfigCardProps) {
  const { t } = useTranslation('team')
  const toast = useToast()
  const [config, setConfig] = useState<TeamModelConfig | null>(null)
  const [presets, setPresets] = useState<ProviderKindPreset[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    name: '',
    kind: 'compatible',
    base_url: '',
    model: '',
    api_key: '',
    temperature: 0.7,
    max_tokens: 2048,
    supports_vision: false,
  })
  const [clearKey, setClearKey] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await teamsApi.modelConfig(teamId)
      setConfig(data)
      setForm({
        name: data.name || '',
        kind: data.kind || 'compatible',
        base_url: data.base_url || '',
        model: data.model || '',
        api_key: '',
        temperature: data.temperature ?? 0.7,
        max_tokens: data.max_tokens ?? 2048,
        supports_vision: data.supports_vision ?? false,
      })
    } catch (err) {
      if (import.meta.env.DEV) console.warn('[team] model-config', err)
    } finally {
      setLoading(false)
    }
  }, [teamId])

  useEffect(() => {
    void load()
    // 预设列表失败不影响主流程（只是少了下拉建议）
    void aiApi
      .presets()
      .then((data) => setPresets(data.kinds ?? []))
      .catch(() => setPresets([]))
  }, [load])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const data = await teamsApi.saveModelConfig(teamId, {
        name: form.name.trim() || '团队中转',
        kind: form.kind,
        base_url: form.base_url.trim(),
        model: form.model.trim(),
        api_key: form.api_key,
        temperature: form.temperature,
        max_tokens: form.max_tokens,
        supports_vision: form.supports_vision,
        clear_api_key: clearKey,
      })
      setConfig(data)
      setForm((prev) => ({ ...prev, api_key: '' }))
      setClearKey(false)
      toast.success(t('settings.saved'))
      onSaved?.()
    } catch (err) {
      toast.error(errorMessage(err))
    } finally {
      setSaving(false)
    }
  }, [teamId, form, clearKey, toast, t, onSaved])

  if (loading) {
    return (
      <Card className="flex items-center justify-center p-6">
        <Loader2 size={16} className="animate-spin text-text-tertiary" />
      </Card>
    )
  }

  // ---- 成员只读视图 ----
  if (!editable) {
    return (
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col">
            <CardTitle className="flex items-center gap-1.5 text-ui">
              <Server size={14} className="text-text-tertiary" />
              {t('settings.model')}
            </CardTitle>
            <CardDescription className="mt-1">{t('settings.model_managed_note')}</CardDescription>
          </div>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-bg-subtle px-2 py-1 text-[10px] text-text-tertiary">
            <Lock size={10} /> read-only
          </span>
        </div>

        {config?.configured ? (
          <dl className="grid gap-2 text-caption sm:grid-cols-2">
            <div className="flex flex-col">
              <dt className="text-[11px] text-text-tertiary">{t('settings.model')}</dt>
              <dd className="truncate font-mono text-[12px] text-text">{config.model || '—'}</dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-[11px] text-text-tertiary">base_url</dt>
              <dd className="truncate font-mono text-[12px] text-text-secondary">
                {config.base_url || '—'}
              </dd>
            </div>
            <div className="flex flex-col">
              <dt className="text-[11px] text-text-tertiary">API Key</dt>
              <dd className="truncate font-mono text-[12px] text-text-secondary">
                {config.has_key ? config.key_hint : '—'}
              </dd>
            </div>
          </dl>
        ) : (
          <p className="rounded-[10px] bg-warning-subtle px-3 py-2 text-caption text-warning">
            {t('settings.model_unconfigured')}
          </p>
        )}
      </Card>
    )
  }

  // ---- 超级管理员可编辑视图 ----
  return (
    <Card className="flex flex-col gap-3 p-4 sm:p-5">
      <div className="flex items-start gap-2.5">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-bg-subtle text-text-secondary ring-1 ring-inset ring-border/70">
          <Server size={15} />
        </span>
        <div className="flex flex-col">
          <CardTitle className="text-ui">{t('settings.model')}</CardTitle>
          <CardDescription className="mt-1 text-caption">{t('settings.model_hint')}</CardDescription>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-tertiary">名称</span>
          <input
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            placeholder="公司中转"
            className={INPUT_CLASS}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-tertiary">协议</span>
          <select
            value={form.kind}
            onChange={(event) => {
              const kind = event.target.value
              const preset = presets.find((item) => item.id === kind)
              setForm((prev) => ({
                ...prev,
                kind,
                // 切协议时把预设的地址/模型带进来，少让用户手敲
                base_url: prev.base_url || preset?.base_url || '',
                model: prev.model || preset?.model || '',
              }))
            }}
            className={INPUT_CLASS}
          >
            <option value="compatible">OpenAI 兼容</option>
            {presets
              .filter((item) => item.id !== 'compatible')
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
          </select>
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-tertiary">网关地址</span>
        <input
          value={form.base_url}
          onChange={(event) => setForm((prev) => ({ ...prev, base_url: event.target.value }))}
          placeholder="https://your-relay.example.com/v1"
          spellCheck={false}
          className={cn(INPUT_CLASS, 'font-mono text-[12px]')}
        />
      </label>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-tertiary">模型</span>
          <input
            value={form.model}
            onChange={(event) => setForm((prev) => ({ ...prev, model: event.target.value }))}
            placeholder="gpt-image-2"
            spellCheck={false}
            className={cn(INPUT_CLASS, 'font-mono text-[12px]')}
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-text-tertiary">
            API Key
            {config?.has_key && !clearKey && (
              <span className="ml-1 text-text-tertiary">（已存 {config.key_hint}）</span>
            )}
          </span>
          <input
            value={form.api_key}
            onChange={(event) => {
              setClearKey(false)
              setForm((prev) => ({ ...prev, api_key: event.target.value }))
            }}
            placeholder={config?.has_key ? '留空表示不修改' : 'sk-...'}
            spellCheck={false}
            autoComplete="off"
            className={cn(INPUT_CLASS, 'font-mono text-[12px]')}
          />
        </label>
      </div>

      {config?.has_key && !clearKey && (
        <button
          type="button"
          onClick={() => {
            setClearKey(true)
            setForm((prev) => ({ ...prev, api_key: '' }))
          }}
          className="self-start text-[10px] text-text-tertiary hover:text-danger"
        >
          清除已保存的 Key
        </button>
      )}

      <label className="flex items-center justify-between gap-3 rounded-[10px] bg-bg-subtle px-2.5 py-2">
        <span className="text-caption text-text">支持读图</span>
        <Switch
          checked={form.supports_vision}
          onCheckedChange={(checked) =>
            setForm((prev) => ({ ...prev, supports_vision: checked }))
          }
        />
      </label>

      <div className="flex items-center gap-2">
        <Button size="sm" loading={saving} onClick={() => void save()}>
          <Check size={13} /> {t('settings.save')}
        </Button>
        {config?.last_test_ok !== null && config?.last_test_ok !== undefined && (
          <span
            className={cn(
              'text-[11px]',
              config.last_test_ok ? 'text-success' : 'text-danger',
            )}
          >
            {config.last_test_message}
          </span>
        )}
      </div>
    </Card>
  )
}
