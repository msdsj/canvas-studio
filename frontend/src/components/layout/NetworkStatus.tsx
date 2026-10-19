import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CloudOff, Wifi } from 'lucide-react'
import { gsap } from '@/lib/gsap'
import { shouldReduceMotion } from '@/lib/motion'
import { SLOW_REQUEST_EVENT } from '@/lib/api/client'

type NetState = 'ok' | 'slow' | 'offline' | 'back'

/**
 * 全局网络状态胶囊（底部居中，不拦截操作）。
 *
 * 三种情况才出现：
 * - 离线：常驻，直到恢复；
 * - 有请求超过 6 秒还没回来：「网络有点慢，还在加载」——让等待有解释，
 *   用户不会以为是自己点错了、反复重点；
 * - 刚从离线恢复：亮 2 秒「已重新连接」后自己收起。
 *
 * 只是安心提示，不做重试决策：重试由各业务卡片自己给按钮（它们知道重试什么）。
 */
export function NetworkStatus() {
  const { t } = useTranslation('common')
  const [slowCount, setSlowCount] = useState(0)
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine
  )
  const [justBack, setJustBack] = useState(false)
  const pillRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onSlow = (event: Event) => {
      const delta = (event as CustomEvent<number>).detail
      setSlowCount((prev) => Math.max(0, prev + delta))
    }
    let backTimer = 0
    const onOnline = () => {
      setOnline(true)
      setJustBack(true)
      window.clearTimeout(backTimer)
      backTimer = window.setTimeout(() => setJustBack(false), 2200)
    }
    const onOffline = () => {
      setOnline(false)
      setJustBack(false)
    }
    window.addEventListener(SLOW_REQUEST_EVENT, onSlow)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.clearTimeout(backTimer)
      window.removeEventListener(SLOW_REQUEST_EVENT, onSlow)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const state: NetState = !online ? 'offline' : justBack ? 'back' : slowCount > 0 ? 'slow' : 'ok'
  const visible = state !== 'ok'

  useLayoutEffect(() => {
    const el = pillRef.current
    if (!el) return
    const vars = visible ? { autoAlpha: 1, y: 0, scale: 1 } : { autoAlpha: 0, y: 14, scale: 0.96 }
    if (shouldReduceMotion()) gsap.set(el, vars)
    else
      gsap.to(el, {
        ...vars,
        duration: visible ? 0.5 : 0.3,
        ease: visible ? 'back.out(1.6)' : 'power2.in',
        overwrite: 'auto',
      })
  }, [visible])

  return (
    <div
      ref={pillRef}
      role="status"
      aria-live="polite"
      className="pointer-events-none invisible fixed bottom-[max(16px,env(safe-area-inset-bottom))] left-1/2 z-[2500] -translate-x-1/2 opacity-0"
    >
      <div className="flex items-center gap-2 rounded-full bg-surface-raised/95 px-3.5 py-2 text-caption font-medium text-text shadow-float ring-1 ring-inset ring-border-faint backdrop-blur-md">
        {state === 'offline' ? (
          <CloudOff size={14} className="text-warning" />
        ) : state === 'back' ? (
          <Wifi size={14} className="text-success" />
        ) : (
          <span className="relative flex h-3.5 w-3.5 items-center justify-center" aria-hidden>
            <span className="absolute h-3.5 w-3.5 animate-spin rounded-full border-2 border-accent-strong/30 border-t-accent-strong" />
          </span>
        )}
        <span>
          {state === 'offline'
            ? t('network.offline')
            : state === 'back'
              ? t('network.back')
              : t('network.slow')}
        </span>
      </div>
    </div>
  )
}
