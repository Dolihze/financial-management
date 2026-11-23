import type {
  Account,
  ActiveAccountType,
  Category,
  Contract,
  ContractDetail,
  Counterparty,
  CreateContractInput,
  CreateTransactionInput,
  ImportBatch,
  ImportPreviewResult,
  OverviewSummary,
  PeriodSummary,
  Project,
  ProjectImportPreview,
  ProjectImportResult,
  Transaction,
  UpdateContractInput,
  UpdateProjectInput,
  TransactionType
} from '@fm/shared';
import { del, get, getBaseUrl, patch, post, upload } from './http';

export { getBackendError, getLogPath, resolveBackendBase, revealLog, waitBackendReady } from './backend';
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

export interface TransactionSummary {
  income: number;
  expense: number;
  profit: number;
  count: number;
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

  contracts: {
    list: () => get<Contract[]>('/api/contracts'),
    get: (id: string) => get<ContractDetail>(`/api/contracts/${id}`),
    create: (body: CreateContractInput) => post<ContractDetail>('/api/contracts', body),
    update: (id: string, body: UpdateContractInput) => patch<ContractDetail>(`/api/contracts/${id}`, body),
    archive: (id: string) => post<Contract>(`/api/contracts/${id}/archive`)
  },
  projects: {
    list: () => get<Project[]>('/api/projects'),
    get: (id: string) => get<Project>(`/api/projects/${id}`),
    update: (id: string, body: UpdateProjectInput) => patch<Project>(`/api/projects/${id}`, body),
    /** 「删除」：后端只归档，不物理删除 */
    archive: (id: string) => post<Project>(`/api/projects/${id}/archive`),
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
    /** 与 list 同样的筛选条件（忽略分页）下的收入/支出/盈亏合计，单位：分 */
    summary: (filter: TransactionFilter = {}) =>
      get<TransactionSummary>('/api/transactions/summary', {
        ...filter,
        limit: undefined,
        offset: undefined,
        includeVoided: filter.includeVoided ? 'true' : undefined
      }),
    create: (body: CreateTransactionInput) => post<Transaction>('/api/transactions', body),
    void: (id: string, reason?: string) => post<Transaction>(`/api/transactions/${id}/void`, { reason })
  },

  overview: {
    summary: () => get<OverviewSummary>('/api/overview'),
    /** 指定时间段（含首尾，缺省一端不限）的收支统计与去向 */
    period: (range: { from?: string; to?: string }) => get<PeriodSummary>('/api/overview/period', range),
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
