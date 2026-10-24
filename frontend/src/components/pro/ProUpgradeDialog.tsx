import { useEffect, useState } from 'react'
import { Check, KeyRound, Sparkles } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useToast } from '@/hooks/use-toast'
import { useUIStore } from '@/stores/ui'
import { useAuthStore } from '@/stores/auth'
import { useAuth } from '@/hooks/use-auth'
import { meApi } from '@/lib/api/me'
import { errorMessage } from '@/lib/errors'
import { events } from '@/lib/events'
import { formatDateTime } from '@/lib/utils'

/** Pro 解锁的能力清单（与后端 require_pro 门禁一一对应）。 */
const BENEFITS = [
  { name: '无限画布', desc: '把生成的图片随手拖进画布，自由编排、导出成稿' },
  { name: 'AI 对话创作', desc: '一句话说清需求，AI 拆解方案、澄清歧义再动手' },
  { name: '图片编辑与抠图', desc: '圈选任意区域改一处，抠图、去物、扩图一步到位' },
  { name: '提示词润色', desc: '需要时才润色，六种风格 × 多组变体，原文永不被动改写' },
  { name: '图生图', desc: '上传参考图，在它的基础上继续创作' },
]

/**
 * 升级 / 激活 Pro 弹窗。
 *
 * 产品上只有一个入口动作：**输入激活码激活**（当前没有支付通道）。
 * 因此这里不去做「套餐对比表」那种空架子，而是把「激活后能用什么」讲清楚，
 * 再把唯一的操作——粘贴激活码——放在最显眼的位置。
 */
export function ProUpgradeDialog() {
  const open = useUIStore((s) => s.proDialogOpen)
  const reason = useUIStore((s) => s.proDialogReason)
  const close = useUIStore((s) => s.closeProDialog)
  const setUser = useAuthStore((s) => s.setUser)
  const { isPro, user } = useAuth()
  /** 永久 Pro 才隐藏激活码输入；限时 Pro 仍然可以续期 */
  const permanentPro = isPro && !user?.pro_expires_at
  const toast = useToast()

  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次被唤起都归零：同一个弹窗会被多处复用，残留上一次的输入会让人以为"没清干净"
  useEffect(() => {
    if (open) setCode('')
  }, [open])

  const submit = async () => {
    const value = code.trim()
    if (!value || busy) return
    setBusy(true)
    try {
      const res = await meApi.redeemPro(value)
      setUser(res.user)
      close()
      const expires = res.user.pro_expires_at
      toast.success(
        res.already_pro ? '你已经是 Pro 了' : 'Pro 已激活',
        expires
          ? `有效期至 ${formatDateTime(expires)}`
          : res.already_pro
            ? '全部高级能力都可以直接使用'
            : '画布、抠图、对话、润色、图生图已全部解锁'
      )
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
      size="md"
      title={
        <span className="flex items-center gap-2">
          <Sparkles size={17} className="text-accent-ink" />
          {permanentPro ? '你已经是 Pro' : isPro ? '续期 Pro' : '激活 Pro，解锁全部能力'}
        </span>
      }
      description={
        reason ||
        (permanentPro
          ? '所有高级能力都已解锁，直接开始创作即可。'
          : isPro && user?.pro_expires_at
            ? `当前套餐有效期至 ${formatDateTime(user.pro_expires_at)}，输入新的激活码可继续顺延。`
            : '普通账号可以直接用文字生成图片；画布、抠图、AI 对话、润色、图生图属于 Pro 能力。')
      }
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            稍后再说
          </Button>
          <Button onClick={() => void submit()} loading={busy} disabled={!code.trim()}>
            激活
          </Button>
        </>
      }
    >
      {permanentPro ? (
        <ul className="flex flex-col gap-1.5">
          {BENEFITS.map((item) => (
            <li key={item.name} className="flex items-start gap-2 rounded-sm bg-surface p-2.5">
              <Check size={14} className="mt-0.5 shrink-0 text-success" />
              <span className="min-w-0">
                <span className="block text-caption font-medium text-text">{item.name}</span>
                <span className="block text-micro leading-snug text-text-tertiary">{item.desc}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-1.5">
            {BENEFITS.map((item) => (
              <li key={item.name} className="flex items-start gap-2">
                <Check size={14} className="mt-0.5 shrink-0 text-success" />
                <span className="min-w-0">
                  <span className="text-caption font-medium text-text">{item.name}</span>
                  <span className="ml-1.5 text-micro text-text-tertiary">{item.desc}</span>
                </span>
              </li>
            ))}
          </ul>

          <div className="rounded-sm bg-bg-subtle p-3">
            <label className="mb-1.5 flex items-center gap-1.5 text-micro text-text-tertiary">
              <KeyRound size={12} /> 激活码
            </label>
            <div className="flex items-center gap-2">
              <Input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit()
                }}
                placeholder="粘贴你的激活码"
                autoComplete="off"
                spellCheck={false}
                className="font-mono tracking-[0.08em] uppercase"
              />
            </div>
            <p className="mt-1.5 text-micro leading-snug text-text-tertiary">
              激活后立刻生效，无需重新登录。
            </p>
          </div>
        </div>
      )}
    </Modal>
  )
}

/** 挂载全局监听：任何请求被判为 PRO_REQUIRED 时，自动弹出上面这个弹窗。 */
export function useProRequiredListener() {
  const openProDialog = useUIStore((s) => s.openProDialog)
  useEffect(() => {
    const handler = () => openProDialog('刚才那一步需要 Pro 才能继续。')
    events.on('pro:required', handler)
    return () => events.off('pro:required', handler)
  }, [openProDialog])
}
