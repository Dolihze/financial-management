import type {
  Account,
  AccountType,
  Category,
  CreateTransactionInput,
  ImportBatch,
  ImportPreviewResult,
  OverviewSummary,
  Transaction,
  TransactionType
} from '@fm/shared';
import { get, getBaseUrl, patch, post, upload } from './http';

export { resolveBackendBase, waitBackendReady } from './backend';
export { setBaseUrl } from './http';

export interface TransactionFilter {
  accountId?: string;
  type?: TransactionType;
  categoryId?: string;
  from?: string;
  to?: string;
  keyword?: string;
  includeVoided?: boolean;
  limit?: number;
  offset?: number;
}

export const api = {
  health: () => get<{ ok: boolean }>('/api/health'),

  accounts: {
    list: () => get<Account[]>('/api/accounts'),
    create: (body: { name: string; type: AccountType; openingBalance: number; note?: string }) =>
      post<Account>('/api/accounts', body),
    update: (id: string, body: Partial<{ name: string; type: AccountType; note: string }>) =>
      patch<Account>(`/api/accounts/${id}`, body),
    archive: (id: string) => post<Account>(`/api/accounts/${id}/archive`)
  },

  categories: {
    list: () => get<Category[]>('/api/categories'),
    create: (body: { name: string; kind: 'income' | 'expense' }) => post<Category>('/api/categories', body)
  },

  transactions: {
    list: (filter: TransactionFilter = {}) =>
      get<{ items: Transaction[]; total: number }>('/api/transactions', {
        ...filter,
        includeVoided: filter.includeVoided ? 'true' : undefined
      }),
    create: (body: CreateTransactionInput) => post<Transaction>('/api/transactions', body),
    void: (id: string, reason?: string) => post<Transaction>(`/api/transactions/${id}/void`, { reason })
  },

  overview: {
    summary: () => get<OverviewSummary>('/api/overview'),
    integrity: () => get<{ ok: boolean; brokenTransfers: string[] }>('/api/overview/integrity')
  },

  imports: {
    templateUrl: () => `${getBaseUrl()}/api/imports/template`,
    list: () => get<ImportBatch[]>('/api/imports'),
    preview: (file: File) => upload<ImportPreviewResult>('/api/imports/preview', file),
    commit: (file: File, skipDuplicates: boolean) =>
      upload<ImportBatch>('/api/imports/commit', file, { skipDuplicates: String(skipDuplicates) }),
    revert: (id: string) => post<ImportBatch>(`/api/imports/${id}/revert`)
  }
};
