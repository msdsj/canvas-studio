import { useEffect } from 'react'
import { quotaApi } from '@/lib/api/quota'
import { events } from '@/lib/events'
import { useQuotaStore, canAfford as canAffordFn, quotaState } from '@/stores/quota'

/** 拉取并刷新额度账户，返回余额/预警态/可负担判断。 */
export function useQuota() {
  const store = useQuotaStore()

  const refresh = async () => {
    try {
      const account = await quotaApi.account()
      useQuotaStore.getState().setAccount(account)
    } catch {
      /* 静默失败，等待下次刷新 */
    }
  }

  useEffect(() => {
    void refresh()
    const handler = () => void refresh()
    events.on('quota:changed', handler)
    return () => {
      events.off('quota:changed', handler)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    balance: store.balance,
    thresholdPct: store.thresholdPct,
    totalGranted: store.totalGranted,
    prices: store.prices,
    loaded: store.loaded,
    state: quotaState(store.balance, store.thresholdPct, store.totalGranted),
    refresh,
    /**
     * 必须**现读** store，不能用上面解构出来的 `store.balance`。
     *
     * 解构值绑定在渲染闭包上：进入页面时额度还是 0，等 `refresh()` 把真实余额
     * 拉回来之后，闭包里的 balance 仍是首帧那个 0 —— 于是明明余额充足，
     * 每一次提交都被判成「额度不足」。只有 store 尚未 loaded 时才放行到后端，
     * 由后端做最终裁决（它才是额度账本的唯一真源）。
     */
    canAfford: (cost: number) => {
      const current = useQuotaStore.getState()
      if (!current.loaded) return true
      return canAffordFn(current.balance, cost)
    },
  }
}
