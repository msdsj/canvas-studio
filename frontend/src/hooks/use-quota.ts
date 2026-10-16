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
    canAfford: (cost: number) => canAffordFn(store.balance, cost),
  }
}
