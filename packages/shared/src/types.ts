/** 前后端共享的领域类型。金额字段一律为「整数分」。 */

export const ACCOUNT_TYPES = ['cash', 'bank', 'alipay', 'wechat', 'receivable', 'payable', 'other'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: '现金',
  bank: '银行账户',
  alipay: '支付宝',
  wechat: '微信',
  receivable: '应收款',
  payable: '应付款',
  other: '其他'
};

export const TRANSACTION_TYPES = ['income', 'expense', 'transfer'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  income: '收入',
  expense: '支出',
  transfer: '转账'
};

export type TransactionStatus = 'normal' | 'voided';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  /** 期初余额（分） */
  openingBalance: number;
  /** 当前余额（分）= 期初 + 所有未作废分录之和，由后端实时计算 */
  balance: number;
  note: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  /** income / expense */
  kind: 'income' | 'expense';
  parentId: string | null;
}

export interface TransactionLine {
  id: string;
  accountId: string;
  accountName?: string;
  /** 正数=资金流入该账户，负数=流出 */
  amount: number;
}

export interface Transaction {
  id: string;
  /** 业务发生日期 YYYY-MM-DD */
  occurredOn: string;
  type: TransactionType;
  summary: string;
  categoryId: string | null;
  categoryName?: string | null;
  counterparty: string;
  note: string;
  status: TransactionStatus;
  importBatchId: string | null;
  lines: TransactionLine[];
  createdAt: string;
  updatedAt: string;
}

/** 创建交易的入参：收入/支出只需一个账户，转账需要 from/to */
export interface CreateTransactionInput {
  occurredOn: string;
  type: TransactionType;
  summary: string;
  /** 金额（分），必须 > 0 */
  amount: number;
  /** 收入：入账账户；支出：出账账户 */
  accountId?: string;
  fromAccountId?: string;
  toAccountId?: string;
  categoryId?: string | null;
  counterparty?: string;
  note?: string;
}

export interface OverviewSummary {
  totalBalance: number;
  accounts: Array<Pick<Account, 'id' | 'name' | 'type' | 'balance'>>;
  /** 本月收入/支出（分） */
  monthIncome: number;
  monthExpense: number;
  /** 最近 N 个月趋势 */
  trend: Array<{ month: string; income: number; expense: number }>;
  /** 本月支出分类占比 */
  expenseByCategory: Array<{ categoryId: string | null; categoryName: string; amount: number }>;
}

export interface ImportRowError {
  row: number;
  message: string;
}

export interface ImportPreviewResult {
  total: number;
  valid: number;
  duplicates: number;
  errors: ImportRowError[];
}

export interface ImportBatch {
  id: string;
  fileName: string;
  fileHash: string;
  rowCount: number;
  importedCount: number;
  status: 'committed' | 'reverted';
  createdAt: string;
}
