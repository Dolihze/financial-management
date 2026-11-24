import type {
  Account,
  ActiveAccountType,
  Batch,
  BatchAttachment,
  BatchInput,
  Category,
  Contract,
  ContractDetail,
  Counterparty,
  CreateContractInput,
  CreateProjectInput,
  CreateTransactionInput,
  ImportBatch,
  ImportPreviewResult,
  OverviewSummary,
  PeriodSummary,
  Project,
  ProjectImportPreview,
  ProjectImportResult,
  Transaction,
  TransactionAttachment,
  UpdateContractInput,
  UpdateProjectInput,
  TransactionType
} from '@fm/shared';
import { del, get, getBaseUrl, patch, post, upload } from './http';

import { openFileWithSystem, saveFileWithSystem } from './backend';

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

  batches: {
    list: () => get<Batch[]>('/api/batches'),
    get: (id: string) => get<Batch>(`/api/batches/${id}`),
    create: (body: BatchInput) => post<Batch>('/api/batches', body),
    update: (id: string, body: BatchInput) => patch<Batch>(`/api/batches/${id}`, body),
    /** 「删除」：后端只归档；批次下还有合同时会被拒绝 */
    remove: (id: string) => post<Batch>(`/api/batches/${id}/archive`),
    /** 给批次上传一个相关文件（图片/PDF/其他），单个不超过 20 MB */
    addAttachment: (batchId: string, file: File) => upload<BatchAttachment>(`/api/batches/${batchId}/attachments`, file),
    /** 「删除」文件：后端只做软删除（保留记录与磁盘文件），列表中不再出现 */
    removeAttachment: (id: string) => post<BatchAttachment>(`/api/batch-attachments/${id}/remove`),
    /** 用系统默认程序打开 */
    openAttachment: async (a: Pick<BatchAttachment, 'id' | 'fileName'>) => {
      const blob = await get<Blob>(`/api/batch-attachments/${a.id}/file`);
      await openFileWithSystem(blob, a.fileName, `${getBaseUrl()}/api/batch-attachments/${a.id}/file`);
    },
    /** 下载到用户选择的位置；返回 false 表示用户取消 */
    downloadAttachment: async (a: Pick<BatchAttachment, 'id' | 'fileName'>) =>
      saveFileWithSystem(await get<Blob>(`/api/batch-attachments/${a.id}/file`), a.fileName)
  },

  contracts: {
    /** 传 batchId 只取该批次下的合同 */
    list: (batchId?: string) => get<Contract[]>(batchId ? `/api/contracts?batchId=${encodeURIComponent(batchId)}` : '/api/contracts'),
    get: (id: string) => get<ContractDetail>(`/api/contracts/${id}`),
    create: (body: CreateContractInput) => post<ContractDetail>('/api/contracts', body),
    update: (id: string, body: UpdateContractInput) => patch<ContractDetail>(`/api/contracts/${id}`, body),
    archive: (id: string) => post<Contract>(`/api/contracts/${id}/archive`)
  },
  projects: {
    /**
     * 项目只有一张表，是否结算由「项目结算」字段区分：
     * settled = true → 已结算项目表（结算 = 是）；settled = false → 未结算项目表（结算 = 否）；省略 = 全部。
     * 传 contractId 只取该合同下的项目。
     */
    list: (opts: { contractId?: string; settled?: boolean } = {}) => {
      const q = new URLSearchParams();
      if (opts.contractId) q.set('contractId', opts.contractId);
      if (opts.settled !== undefined) q.set('settled', String(opts.settled));
      const qs = q.toString();
      return get<Project[]>(qs ? `/api/projects?${qs}` : '/api/projects');
    },
    /** 已有的区域（去重），供下拉选择 */
    regions: () => get<string[]>('/api/projects/regions'),
    get: (id: string) => get<Project>(`/api/projects/${id}`),
    /** 新建项目：项目结算 = 否、不归属合同，出现在未结算项目表 */
    create: (body: CreateProjectInput) => post<Project>('/api/projects', body),
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
    void: (id: string, reason?: string) => post<Transaction>(`/api/transactions/${id}/void`, { reason }),
    /** 给流水上传一个相关文件（图片/PDF/其他），单个不超过 20 MB */
    addAttachment: (txId: string, file: File) =>
      upload<TransactionAttachment>(`/api/transactions/${txId}/attachments`, file)
  },

  attachments: {
    /** 文件内容地址 */
    fileUrl: (id: string) => `${getBaseUrl()}/api/attachments/${id}/file`,
    /** 用系统默认程序打开（图片/PDF/Excel/Word 等都交给对应软件），不会触发下载 */
    open: async (a: Pick<TransactionAttachment, 'id' | 'fileName'>) => {
      const blob = await get<Blob>(`/api/attachments/${a.id}/file`);
      await openFileWithSystem(blob, a.fileName, `${getBaseUrl()}/api/attachments/${a.id}/file`);
    },
    /** 下载到用户选择的位置（系统「另存为」对话框）；返回 false 表示用户取消 */
    download: async (a: Pick<TransactionAttachment, 'id' | 'fileName'>) =>
      saveFileWithSystem(await get<Blob>(`/api/attachments/${a.id}/file`), a.fileName)
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
