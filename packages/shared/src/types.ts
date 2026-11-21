/** 前后端共享的领域类型。金额字段一律为「整数分」。 */

/** 允许新建/选择的账户类型 */
export const ACCOUNT_TYPES = ['bank', 'alipay', 'wechat'] as const;
/** 历史数据中可能存在的已停用类型（不再允许新建，仅用于读取/展示旧账户） */
export const LEGACY_ACCOUNT_TYPES = ['cash', 'receivable', 'payable', 'other'] as const;
export type ActiveAccountType = (typeof ACCOUNT_TYPES)[number];
export type AccountType = ActiveAccountType | (typeof LEGACY_ACCOUNT_TYPES)[number];

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: '现金',
  bank: '银行账户',
  alipay: '支付宝',
  wechat: '微信',
  receivable: '应收款',
  payable: '应付款',
  other: '其他'
};

/**
 * 交易类型：
 * - income 收入：入账账户 +amt
 * - expense 支出：出账账户 -amt
 * - borrow 借款：把钱借出去，出账账户 -amt
 * - loan 贷款：向外借入资金，入账账户 +amt
 */
export const TRANSACTION_TYPES = ['income', 'expense', 'borrow', 'loan'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const TRANSACTION_TYPE_LABELS: Record<TransactionType, string> = {
  income: '收入',
  expense: '支出',
  borrow: '借款',
  loan: '贷款'
};

/** 该类型的资金方向：true=流入账户，false=流出账户 */
export const TRANSACTION_TYPE_IS_INFLOW: Record<TransactionType, boolean> = {
  income: true,
  expense: false,
  borrow: false,
  loan: true
};

export type TransactionStatus = 'normal' | 'voided';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  /** 期初余额（分） */
  openingBalance: number;
  /** 开户银行（仅银行账户使用，其他类型为空串） */
  bankName: string;
  /** 银行卡号（仅银行账户使用，其他类型为空串） */
  accountNo: string;
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
  /** 内置分类（如「其他收入」）：不可编辑 */
  builtin: boolean;
  /** 被多少笔流水使用（仅列表接口返回，含已作废流水） */
  usageCount?: number;
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
  /** 历史数据遗留的摘要（已从录入中移除，新交易恒为空串） */
  summary: string;
  categoryId: string | null;
  categoryName?: string | null;
  /** 关联的往来单位（主数据）；单位被删除后为 null，但 counterparty 名称快照仍保留 */
  counterpartyId: string | null;
  /** 往来单位名称快照 */
  counterparty: string;
  note: string;
  status: TransactionStatus;
  importBatchId: string | null;
  lines: TransactionLine[];
  createdAt: string;
  updatedAt: string;
}

/** 创建交易的入参：每笔交易只涉及一个账户 */
export interface CreateTransactionInput {
  occurredOn: string;
  type: TransactionType;
  /** 金额（分），必须 > 0 */
  amount: number;
  /** 收入/贷款：入账账户；支出/借款：出账账户 */
  accountId?: string;
  categoryId?: string | null;
  /** 往来单位（主数据 id） */
  counterpartyId?: string | null;
  note?: string;
}

export interface Counterparty {
  id: string;
  name: string;
  /** 被多少笔流水关联（仅列表接口返回，含已作废流水） */
  usageCount?: number;
}

export const PROJECT_STATUSES = ['unsettled', 'settled'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  unsettled: '未结算',
  settled: '已结算'
};

export interface Project {
  id: string;
  /** 设计编号 */
  designNo: string;
  /** 合同编号 */
  contractNo: string;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
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
