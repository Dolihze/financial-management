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

/** 项目：仅通过 Excel 导入维护，项目名称唯一（导入时的匹配键），合同编号可重复。金额字段一律为「整数分」。 */
export interface Project {
  id: string;
  /** 合同编号（非唯一，同一合同下可有多个项目；可为空） */
  contractNo: string;
  /** 批次号：Excel 中写作「第15批」，这里存数字 15；未填写为 null */
  batchNo: number | null;
  /** 区域 */
  region: string;
  name: string;
  /** 合同价（分） */
  contractPrice: number;
  /** 企信实收（分） */
  qxReceived: number;
  /** 企信支付下家分包费（分） */
  qxSubcontractFee: number;
  /** 陈沛（分） */
  chenPei: number;
  /** 企信利润（分） */
  qxProfit: number;
  /** 企信是否收到钱 */
  qxMoneyReceived: boolean;
  /** 支付下家 */
  paidSubcontractor: boolean;
  /** 支付陈沛 */
  paidChenPei: boolean;
  /** 当前已入账（有对应有效流水）的字段；导入不会覆盖这些字段及其金额 */
  postedKinds: ProjectPostingKind[];
  createdAt: string;
  updatedAt: string;
}

/** 项目三个「是/否」字段，对应的记账方向与金额列 */
export const PROJECT_POSTING_KINDS = ['qx_received', 'paid_subcontractor', 'paid_chen_pei'] as const;
export type ProjectPostingKind = (typeof PROJECT_POSTING_KINDS)[number];

/** 修改项目的入参：金额为整数分。所有字段必填（详情页表单整体保存）。 */
export interface UpdateProjectInput {
  contractNo: string;
  batchNo: number | null;
  region: string;
  name: string;
  contractPrice: number;
  qxReceived: number;
  qxSubcontractFee: number;
  chenPei: number;
  qxProfit: number;
  qxMoneyReceived: boolean;
  paidSubcontractor: boolean;
  paidChenPei: boolean;
  /**
   * 本次保存中从「否」切到「是」的字段需要入账：指定入账账户（收入、支出都记到这个账户）。
   * 没有字段从否切到是时可省略。
   */
  postingAccountId?: string;
  /** 入账日期 YYYY-MM-DD（流水的业务发生日期）；同一次保存里的多笔入账共用。省略时用服务器当天 */
  postingDate?: string;
}

/** 项目 Excel 导入表头（第 1 行）。项目名称为「合计」的行与重复表头的说明行会被忽略。 */
export const PROJECT_IMPORT_HEADERS = [
  '合同编号',
  '批次',
  '区域',
  '项目名称',
  '合同价',
  '企信实收',
  '企信支付下家分包费',
  '陈沛',
  '企信利润',
  '企信是否收到钱',
  '支付下家',
  '支付陈沛'
] as const;

export interface ProjectImportPreview {
  /** 数据行数（不含表头和合计行；空行不计） */
  total: number;
  /** 项目名称不存在，将新增 */
  toCreate: number;
  /** 项目名称已存在，将更新 */
  toUpdate: number;
  /** 其中有字段已入账、导入时不会被覆盖（该字段及其金额保持不变）的项目数 */
  toUpdatePartially: number;
  errors: ImportRowError[];
}

export interface ProjectImportResult {
  total: number;
  created: number;
  updated: number;
  /** 因字段已入账而被保留（未被 Excel 覆盖）的项目数 */
  skippedPosted: number;
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
