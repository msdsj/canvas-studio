import { api } from './client'
import type { PageData, PageQuery } from '@/types/api'
import type { Prices, QuotaAccount, QuotaTransaction } from '@/types/models'

export interface TransactionQuery extends PageQuery {
  type?: string
}

export const quotaApi = {
  account: () => api.get<QuotaAccount>('/me/quota'),
  prices: () => api.get<Prices>('/quota/prices'),
  transactions: (query: TransactionQuery = {}) =>
    api.get<PageData<QuotaTransaction>>(
      `/me/quota/transactions?page=${query.page ?? 1}&size=${query.size ?? 20}${
        query.type ? `&type=${query.type}` : ''
      }`
    ),
}
