import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  XCircle,
  Zap,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'
import {
  aiApi,
  type AIProvider,
  type ProviderKindPreset,
  type ProviderUpsert,
} from '@/lib/api/ai'
import { ApiError } from '@/lib/api/client'

interface AIConfigDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 保存 / 激活后通知父层刷新「是否已配置」 */
  onChanged?: () => void
}

interface FormState {
  name: string
  kind: string
  base_url: string
  api_key: string
  model: string
  temperature: number
  max_tokens: number
  supports_vision: boolean
  extraText: string
}

const EMPTY_FORM: FormState = {
  name: '',
  kind: 'compatible',
  base_url: '',
  api_key: '',
  model: '',
  temperature: 0.7,
  max_tokens: 2048,
  supports_vision: false,
  extraText: '',
}

/** 中转站配置面板：左侧列表 + 右侧表单。 */
export function AIConfigDialog({ open, onOpenChange, onChanged }: AIConfigDialogProps) {
  const toast = useToast()
  const [providers, setProviders] = useState<AIProvider[]>([])
  const [presets, setPresets] = useState<ProviderKindPreset[]>([])
  const [loading, setLoading] = useState(false)
  /** null = 未选中；'new' = 新建 */
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [advanced, setAdvanced] = useState(false)
  const [clearKey, setClearKey] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [list, presetData] = await Promise.all([aiApi.providers(), aiApi.presets()])
      setProviders(list)
      setPresets(presetData.kinds)
      if (list.length > 0 && editingId === null) {
        const active = list.find((item) => item.is_active) ?? list[0]
        selectProvider(active)
      }
    } catch (error) {
      toast.error('读取中转站配置失败', error instanceof ApiError ? error.message : undefined)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (open) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const selectProvider = (provider: AIProvider) => {
    setEditingId(provider.id)
    setClearKey(false)
    setTestResult(
      provider.last_test_message
        ? { ok: Boolean(provider.last_test_ok), message: provider.last_test_message }
        : null
    )
    setForm({
      name: provider.name,
      kind: provider.kind,
      base_url: provider.base_url,
      // 掩码值只做展示占位：保存时后端会识别 `*` 并跳过，不会覆盖真实 Key
      api_key: provider.key_hint,
      model: provider.model,
      temperature: provider.temperature,
      max_tokens: provider.max_tokens,
      supports_vision: provider.supports_vision,
      extraText: Object.keys(provider.extra || {}).length
        ? JSON.stringify(provider.extra, null, 2)
        : '',
    })
  }

  const startNew = () => {
    setEditingId('new')
    setTestResult(null)
    setClearKey(false)
    setForm(EMPTY_FORM)
  }

  const applyPreset = (kind: string) => {
    const preset = presets.find((item) => item.id === kind)
    setForm((prev) => ({
      ...prev,
      kind,
      // 只在用户还没填的时候预填建议值，不覆盖已输入内容
      base_url: prev.base_url || preset?.base_url || '',
      model: prev.model || preset?.model || '',
      name: prev.name || preset?.label || '',
    }))
  }

  const buildPayload = (): ProviderUpsert | null => {
    let extra: Record<string, unknown> = {}
    if (form.extraText.trim()) {
      try {
        const parsed = JSON.parse(form.extraText)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          extra = parsed as Record<string, unknown>
        } else {
          throw new Error('not object')
        }
      } catch {
        toast.error('额外参数必须是 JSON 对象', '例如 {"top_p": 0.9}')
        return null
      }
    }
    return {
      name: form.name.trim() || '我的中转站',
      kind: form.kind,
      base_url: form.base_url.trim(),
      api_key: form.api_key.trim(),
      model: form.model.trim(),
      temperature: form.temperature,
      max_tokens: form.max_tokens,
      extra,
      supports_vision: form.supports_vision,
      clear_api_key: clearKey,
    }
  }

  const save = async (): Promise<AIProvider | null> => {
    const payload = buildPayload()
    if (!payload) return null
    setSaving(true)
    try {
      const row =
        editingId && editingId !== 'new'
          ? await aiApi.updateProvider(editingId, payload)
          : await aiApi.createProvider(payload)
      setEditingId(row.id)
      setClearKey(false)
      setTestResult(
        row.last_test_message ? { ok: Boolean(row.last_test_ok), message: row.last_test_message } : null
      )
      toast.success('已保存', row.is_active ? '这条配置正在生效' : '点「设为当前」让它生效')
      await load()
      onChanged?.()
      return row
    } catch (error) {
      toast.error('保存失败', error instanceof ApiError ? error.message : undefined)
      return null
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    const payload = buildPayload()
    if (!payload) return
    setTesting(true)
    setTestResult(null)
    try {
      const result =
        editingId && editingId !== 'new'
          ? await aiApi.testProvider(editingId, payload)
          : await aiApi.testDraft(payload)
      setTestResult({ ok: result.ok, message: `${result.message} · ${result.elapsed_ms}ms` })
      if (result.ok) toast.success('连接正常', result.model || undefined)
      else toast.error('连不上这个中转站', result.message)
      await load()
      onChanged?.()
    } catch (error) {
      const message = error instanceof ApiError ? error.message : '测试失败'
      setTestResult({ ok: false, message })
      toast.error('测试失败', message)
    } finally {
      setTesting(false)
    }
  }

  const activate = async () => {
    if (!editingId || editingId === 'new') {
      toast.info('先保存这条配置', '保存后才能设为当前使用')
      return
    }
    try {
      await aiApi.activateProvider(editingId)
      toast.success('已切换', '之后的对话与生图都走这条中转站')
      await load()
      onChanged?.()
    } catch (error) {
      toast.error('切换失败', error instanceof ApiError ? error.message : undefined)
    }
  }

  const remove = async () => {
    if (!editingId || editingId === 'new') return
    try {
      await aiApi.deleteProvider(editingId)
      toast.success('已删除')
      setEditingId(null)
      setForm(EMPTY_FORM)
      await load()
      onChanged?.()
    } catch (error) {
      toast.error('删除失败', error instanceof ApiError ? error.message : undefined)
    }
  }

  const current = useMemo(
    () => providers.find((item) => item.id === editingId) ?? null,
    [providers, editingId]
  )
  const configured = providers.some((item) => item.is_active && item.base_url)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="lg" className="p-0">
        <div className="flex max-h-[min(720px,calc(100dvh-96px))] flex-col">
          <DialogHeader className="border-b border-border/60 px-6 py-4">
            <DialogTitle className="flex items-center gap-2 text-base">
              <Server size={16} className="text-brand" />
              AI 中转站
            </DialogTitle>
            <DialogDescription className="text-caption">
              Key 只存在你的账号下，接口不回显明文
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-0 md:flex-row">
            {/* 左：配置列表 */}
            <aside className="flex w-full shrink-0 flex-col gap-1 border-b border-border/60 p-3 md:w-[220px] md:border-b-0 md:border-r">
              <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-micro font-medium text-text-tertiary">
                  我的配置 · {providers.length}
                </span>
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded p-1 text-text-tertiary transition-colors hover:bg-surface-hover hover:text-text"
                  aria-label="刷新"
                >
                  <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
                </button>
              </div>

              {providers.length === 0 && !loading && (
                <p className="px-1 text-micro text-text-tertiary">还没有配置</p>
              )}

              {providers.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  onClick={() => selectProvider(provider)}
                  className={cn(
                    'flex flex-col gap-0.5 rounded-[10px] px-2.5 py-2 text-left transition-colors',
                    editingId === provider.id
                      ? 'bg-brand-subtle text-brand-text'
                      : 'text-text-secondary hover:bg-surface-hover'
                  )}
                >
                  <span className="flex items-center gap-1.5">
                    <span className="min-w-0 flex-1 truncate text-caption font-medium">
                      {provider.name || '未命名'}
                    </span>
                    {provider.is_active && (
                      <span className="shrink-0 rounded-full bg-brand px-1.5 py-0.5 text-[9px] font-semibold text-white">
                        当前
                      </span>
                    )}
                  </span>
                  <span className="truncate text-[10px] text-text-tertiary">
                    {provider.model || '模型未填'}
                  </span>
                </button>
              ))}

              <Button
                variant="ghost"
                size="sm"
                className="mt-1 justify-start gap-1.5 text-caption"
                onClick={startNew}
              >
                <Plus size={13} /> 新增配置
              </Button>
            </aside>

            {/* 右：表单 */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {editingId === null ? (
                <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 text-center">
                  <Server size={28} className="text-text-faint" />
                  <p className="text-caption text-text-secondary">左侧选一条配置，或新增一条</p>
                  <Button size="sm" variant="secondary" onClick={startNew}>
                    <Plus size={13} /> 新增中转站
                  </Button>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {!configured && (
                    <div className="flex items-start gap-1.5 rounded-[10px] bg-warning-subtle px-2.5 py-2 text-micro leading-relaxed text-warning">
                      <AlertCircle size={13} className="mt-[1px] shrink-0" />
                      <span>
                        还没有生效的中转站。填好地址、Key、模型后点「设为当前」，生图流程才能开始分析需求。
                      </span>
                    </div>
                  )}

                  <Field label="类型">
                    <div className="flex flex-wrap gap-1">
                      {(presets.length
                        ? presets
                        : [
                            { id: 'claude', label: 'Claude' },
                            { id: 'codex', label: 'Codex' },
                            { id: 'deepseek', label: 'DeepSeek' },
                            { id: 'openai', label: 'OpenAI' },
                            { id: 'compatible', label: '兼容' },
                          ]
                      ).map((preset) => (
                        <button
                          key={preset.id}
                          type="button"
                          onClick={() => applyPreset(preset.id)}
                          className={cn(
                            'rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                            form.kind === preset.id
                              ? 'border-brand bg-brand-subtle text-brand-text'
                              : 'border-border text-text-secondary hover:bg-surface-hover'
                          )}
                        >
                          {preset.label}
                        </button>
                      ))}
                    </div>
                  </Field>

                  <Field label="名称">
                    <input
                      value={form.name}
                      onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
                      placeholder="例如：我的 DeepSeek 中转"
                      className={INPUT_CLASS}
                    />
                  </Field>

                  <Field label="网关地址" hint="通常填到 /v1">
                    <input
                      value={form.base_url}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, base_url: event.target.value }))
                      }
                      placeholder="https://your-relay.example.com/v1"
                      spellCheck={false}
                      className={cn(INPUT_CLASS, 'font-mono text-[12px]')}
                    />
                  </Field>

                  <Field
                    label="API Key"
                    hint={
                      clearKey
                        ? '保存后会清空已存 Key'
                        : current?.has_key
                          ? `已保存：${current.key_hint}`
                          : '留空表示先占位，之后再填'
                    }
                  >
                    <input
                      value={form.api_key}
                      onChange={(event) => {
                        setClearKey(false)
                        setForm((prev) => ({ ...prev, api_key: event.target.value }))
                      }}
                      placeholder="sk-..."
                      spellCheck={false}
                      autoComplete="off"
                      className={cn(INPUT_CLASS, 'font-mono text-[12px]')}
                    />
                  </Field>
                  {current?.has_key && !clearKey && (
                    <button
                      type="button"
                      onClick={() => {
                        setClearKey(true)
                        setForm((prev) => ({ ...prev, api_key: '' }))
                      }}
                      className="-mt-2 self-start text-[10px] text-text-tertiary hover:text-danger"
                    >
                      清除已保存的 Key
                    </button>
                  )}

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="模型">
                      <input
                        value={form.model}
                        onChange={(event) =>
                          setForm((prev) => ({ ...prev, model: event.target.value }))
                        }
                        placeholder="deepseek-chat / claude-sonnet-4-5"
                        spellCheck={false}
                        className={cn(INPUT_CLASS, 'font-mono text-[12px]')}
                      />
                    </Field>
                    <Field label="最大输出 tokens">
                      <input
                        type="number"
                        min={64}
                        max={32000}
                        value={form.max_tokens}
                        onChange={(event) =>
                          setForm((prev) => ({
                            ...prev,
                            max_tokens: Number(event.target.value) || 2048,
                          }))
                        }
                        className={INPUT_CLASS}
                      />
                    </Field>
                  </div>

                  <Field label={`温度 · ${form.temperature.toFixed(1)}`} hint="分析类建议 0.2–0.5">
                    <input
                      type="range"
                      min={0}
                      max={2}
                      step={0.1}
                      value={form.temperature}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, temperature: Number(event.target.value) }))
                      }
                      className="w-full accent-[var(--color-brand)]"
                    />
                  </Field>

                  <label className="flex items-center justify-between gap-3 rounded-[10px] bg-bg-subtle px-2.5 py-2">
                    <span className="text-caption text-text">支持读图</span>
                    <Switch
                      checked={form.supports_vision}
                      onCheckedChange={(checked) =>
                        setForm((prev) => ({ ...prev, supports_vision: checked }))
                      }
                    />
                  </label>

                  <button
                    type="button"
                    onClick={() => setAdvanced((prev) => !prev)}
                    className="self-start text-micro text-text-tertiary hover:text-text"
                  >
                    {advanced ? '收起高级参数' : '高级参数'}
                  </button>
                  {advanced && (
                    <textarea
                      value={form.extraText}
                      onChange={(event) =>
                        setForm((prev) => ({ ...prev, extraText: event.target.value }))
                      }
                      rows={4}
                      placeholder={'{\n  "top_p": 0.9\n}'}
                      spellCheck={false}
                      className={cn(INPUT_CLASS, 'resize-y font-mono text-[11px] leading-relaxed')}
                    />
                  )}

                  {testResult && (
                    <div
                      className={cn(
                        'flex items-start gap-1.5 rounded-[10px] px-2.5 py-2 text-micro leading-relaxed',
                        testResult.ok
                          ? 'bg-success-subtle text-success'
                          : 'bg-danger-subtle text-danger'
                      )}
                    >
                      {testResult.ok ? (
                        <CheckCircle2 size={13} className="mt-[1px] shrink-0" />
                      ) : (
                        <XCircle size={13} className="mt-[1px] shrink-0" />
                      )}
                      <span className="min-w-0 [overflow-wrap:anywhere]">{testResult.message}</span>
                    </div>
                  )}

                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <Button size="sm" variant="primary" onClick={() => void save()} disabled={saving}>
                      {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                      保存
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void test()} disabled={testing}>
                      {testing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                      测试连接
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void activate()}
                      disabled={editingId === 'new' || current?.is_active}
                    >
                      {current?.is_active ? '正在使用' : '设为当前'}
                    </Button>
                    {editingId !== 'new' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto text-danger hover:bg-danger-subtle"
                        onClick={() => void remove()}
                      >
                        <Trash2 size={13} /> 删除
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

const INPUT_CLASS =
  'w-full rounded-[10px] border border-border bg-surface px-2.5 py-1.5 text-caption text-text placeholder:text-text-tertiary focus:border-brand focus:outline-none'

function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="flex items-baseline gap-2">
        <span className="text-micro font-medium text-text-secondary">{label}</span>
        {hint && <span className="min-w-0 truncate text-[10px] text-text-tertiary">{hint}</span>}
      </span>
      {children}
    </label>
  )
}
