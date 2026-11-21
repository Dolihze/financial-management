import type {
  Account,
  ActiveAccountType,
  Category,
  Counterparty,
  CreateTransactionInput,
  ImportBatch,
  ImportPreviewResult,
  OverviewSummary,
  Project,
  ProjectImportPreview,
  ProjectImportResult,
  Transaction,
  TransactionType
} from '@fm/shared';
import { del, get, getBaseUrl, patch, post, upload } from './http';

export { resolveBackendBase, waitBackendReady } from './backend';
export { setBaseUrl } from './http';

export interface TransactionFilter {
  accountId?: string;
  type?: TransactionType;
  categoryId?: string;
  counterpartyId?: string;
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
    create: (body: {
      name: string;
      type: ActiveAccountType;
      openingBalance: number;
      bankName?: string;
      accountNo?: string;
      note?: string;
    }) =>
      post<Account>('/api/accounts', body),
    update: (id: string, body: Partial<{ name: string; type: ActiveAccountType; note: string }>) =>
      patch<Account>(`/api/accounts/${id}`, body),
    archive: (id: string) => post<Account>(`/api/accounts/${id}/archive`)
  },

  categories: {
    list: () => get<Category[]>('/api/categories'),
    create: (body: { name: string; kind: 'income' | 'expense' }) => post<Category>('/api/categories', body),
    update: (id: string, body: { name: string }) => patch<Category>(`/api/categories/${id}`, body),
    remove: (id: string) => del<{ movedTransactions: number }>(`/api/categories/${id}`)
  },

  counterparties: {
    list: () => get<Counterparty[]>('/api/counterparties'),
    create: (body: { name: string }) => post<Counterparty>('/api/counterparties', body),
    update: (id: string, body: { name: string }) => patch<Counterparty>(`/api/counterparties/${id}`, body),
    remove: (id: string) => del<{ unlinkedTransactions: number }>(`/api/counterparties/${id}`)
  },

  projects: {
    list: () => get<Project[]>('/api/projects'),
    get: (id: string) => get<Project>(`/api/projects/${id}`),
    importTemplateUrl: () => `${getBaseUrl()}/api/projects/import/template`,
    importPreview: (file: File) => upload<ProjectImportPreview>('/api/projects/import/preview', file),
    importCommit: (file: File) => upload<ProjectImportResult>('/api/projects/import/commit', file)
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
    integrity: () => get<{ ok: boolean; brokenTransactions: string[] }>('/api/overview/integrity')
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
