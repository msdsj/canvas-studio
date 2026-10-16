import { create } from 'zustand'
import { events } from '@/lib/events'
import type { Prices, QuotaAccount } from '@/types/models'

interface QuotaState {
  balance: number
  thresholdPct: number
  totalGranted: number
  prices: Prices
  loaded: boolean
  setAccount: (account: QuotaAccount) => void
  reset: () => void
}

const DEFAULT_PRICES: Prices = { image_standard: 10, image_hd: 16, edit: 8, chat: 2 }

export const useQuotaStore = create<QuotaState>((set) => ({
  balance: 0,
  thresholdPct: 20,
  totalGranted: 0,
  prices: DEFAULT_PRICES,
  loaded: false,
  setAccount: (account) =>
    set({
      balance: account.balance,
      thresholdPct: account.threshold_pct,
      totalGranted: account.total_granted,
      prices: account.prices,
      loaded: true,
    }),
  reset: () => set({ balance: 0, totalGranted: 0, loaded: false }),
}))

events.on('auth:unauthorized', () => {
  useQuotaStore.getState().reset()
})

/** 额度三态：normal | warning | exhausted（阈值 = 初始赠送 × 预警百分比）。 */
export function quotaState(
  balance: number,
  thresholdPct: number,
  totalGranted = 0
): 'normal' | 'warning' | 'exhausted' {
  if (balance <= 0) return 'exhausted'
  const base = totalGranted > 0 ? totalGranted : 100
  const threshold = Math.max(1, Math.floor((thresholdPct / 100) * base))
  return balance <= threshold ? 'warning' : 'normal'
}

/** 是否可负担某次消耗。 */
export function canAfford(balance: number, cost: number): boolean {
  return balance >= cost
}
