import { api } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { Prices, QuotaAccount, QuotaSummary, QuotaTransaction } from '@/types/models'

export interface TransactionQuery extends PageQuery {
  type?: string
}

export const quotaApi = {
  account: () => api.get<QuotaAccount>('/me/quota'),
  prices: () => api.get<Prices>('/quota/prices'),
  /** 额度汇总：余额 / 累计获得 / 累计消耗 / 14 天趋势 / 按类型分布 */
  summary: () => api.get<QuotaSummary>('/quota/summary'),
  transactions: (query: TransactionQuery = {}) =>
    api.get<PageData<QuotaTransaction>>(
      `/me/quota/transactions?page=${query.page ?? 1}&size=${query.size ?? 20}${
        query.type ? `&type=${query.type}` : ''
      }`
    ),
}
