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
  /** 当前余额（分）= 期初 + 所有分录之和，由后端实时计算 */
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
  /** 被多少笔流水使用（仅列表接口返回） */
  usageCount?: number;
}

export interface TransactionLine {
  id: string;
  accountId: string;
  accountName?: string;
  /** 正数=资金流入该账户，负数=流出 */
  amount: number;
}

/** 流水的相关文件（图片/PDF/其他文件）：文件存在本机磁盘，这里只是元数据 */
export interface TransactionAttachment {
  id: string;
  txId: string;
  /** 上传时的原始文件名 */
  fileName: string;
  mimeType: string;
  /** 字节数 */
  size: number;
  createdAt: string;
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
  importBatchId: string | null;
  /** 由项目入账自动生成（有未回退的项目入账关联）：不能单独编辑/删除，需在项目里回退 */
  linkedToProject: boolean;
  lines: TransactionLine[];
  /** 相关文件（按上传时间先后） */
  attachments: TransactionAttachment[];
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
  /** 被多少笔流水关联（仅列表接口返回） */
  usageCount?: number;
}

/**
 * 项目：通过 Excel 导入或「未结算项目」里新建，项目名称唯一（导入时的匹配键），合同编号可重复。金额字段一律为「整数分」。
 * 项目只有一张表，是否结算由「合同」字段（contractId）是否有值区分：
 * - 未结算项目表 = 没有归入合同的项目；已结算项目表（批次 → 合同 → 项目进度）= 已归入合同的项目；
 * - 项目归入合同不入账；企信实收的入账在编辑项目里把「上海院已支付」切换为是时才发生。
 */
export interface Project {
  id: string;
  /** 所属合同 id；未归入任何合同（未结算）为 null */
  contractId: string | null;
  /** 所属合同的编号（冗余文本，随合同同步；未归入合同为空字符串） */
  contractNo: string;
  /**
   * 批次号（只读，由所属合同的批次派生）：Excel 中写作「第15批」，这里存数字 15。
   * 未归入合同、或合同属于「未分批」兜底批次时为 null。不能通过项目接口修改，改批次请移动合同。
   */
  batchNo: number | null;
  /** 区域 */
  region: string;
  name: string;
  /** 合同价（分） */
  contractPrice: number;
  /** 企信实收（分） */
  qxReceived: number;
  /** 企信支付下家（分）（原「企信支付下家分包费」） */
  qxSubcontractFee: number;
  /** 陈沛（分） */
  chenPei: number;
  /** 企信利润（分） */
  qxProfit: number;
  /**
   * 上海院已支付。由否切到是时记一笔收入（金额取企信实收）；是切回否则删除该笔流水。
   */
  shPaid: boolean;
  /** 支付下家 */
  paidSubcontractor: boolean;
  /** 支付陈沛 */
  paidChenPei: boolean;
  /** 备注（Excel「备注」列；可为空字符串） */
  note: string;
  /** 当前已入账（有对应有效流水）的字段；导入不会覆盖这些字段及其金额 */
  postedKinds: ProjectPostingKind[];
  createdAt: string;
  updatedAt: string;
}

/** 项目三个会入账的「是/否」字段（qx_received 对应「上海院已支付」，收入，金额取企信实收），对应的记账方向与金额列 */
export const PROJECT_POSTING_KINDS = ['qx_received', 'paid_subcontractor', 'paid_chen_pei'] as const;
export type ProjectPostingKind = (typeof PROJECT_POSTING_KINDS)[number];

/**
 * 修改项目的入参：金额为整数分。所有字段必填（详情页表单整体保存）。
 * 批次号不能直接修改：它随所属合同派生，换合同时自动跟着变。
 */
export interface UpdateProjectInput {
  /**
   * 改归属合同（必须是已有的未归档合同）：省略保持不变。
   * 项目的合同编号文本、批次号会同步为新合同的值；不支持通过本接口把项目移出合同。
   */
  contractId?: string;
  region: string;
  name: string;
  contractPrice: number;
  qxReceived: number;
  qxSubcontractFee: number;
  chenPei: number;
  qxProfit: number;
  /**
   * 上海院已支付：省略时保持原值，且不触发入账/回退。
   * 否→是记一笔收入（金额取企信实收，需 postingAccountId）；是→否删除该笔流水。只有已归入合同的项目才能设为是。
   */
  shPaid?: boolean;
  paidSubcontractor: boolean;
  paidChenPei: boolean;
  /** 备注；省略时保持原值 */
  note?: string;
  /**
   * 本次保存中从「否」切到「是」的字段需要入账：指定入账账户（收入、支出都记到这个账户）。
   * 没有字段从否切到是时可省略。
   */
  postingAccountId?: string;
  /** 入账日期 YYYY-MM-DD（流水的业务发生日期）；同一次保存里的多笔入账共用。省略时用服务器当天 */
  postingDate?: string;
}

/** 批次的相关文件（图片/PDF/其他文件）：文件存在本机磁盘，这里只是元数据 */
export interface BatchAttachment {
  id: string;
  batchId: string;
  /** 上传时的原始文件名 */
  fileName: string;
  mimeType: string;
  /** 字节数 */
  size: number;
  createdAt: string;
}

/** 批次汇总金额：均为整数分之和（只统计未归档合同下未归档项目） */
export interface BatchTotals {
  /** 合同数 */
  contractCount: number;
  /** 项目数 */
  projectCount: number;
  /** 合同总价（分）= 其下项目合同价之和 */
  totalPrice: number;
  /** 企信实收（分） */
  qxReceived: number;
  /** 企信利润（分） */
  qxProfit: number;
}

/**
 * 批次：项目管理的第一层（批次 → 合同 → 项目）。批次号为正整数（>= 1），在未归档批次中唯一。
 * 「删除」批次 = 归档，只有其下没有任何合同时才允许；不物理删除。
 * 存档（sealedAt 有值）与「删除」无关：存档的批次出现在左侧菜单「存档」页，整批只读；没有存档的在「正在结算中」。
 */
export interface Batch extends BatchTotals {
  id: string;
  batchNo: number;
  /** 备注，可为空字符串 */
  note: string;
  /** 相关文件（按上传时间先后） */
  attachments: BatchAttachment[];
  /** 存档时间；null = 正在结算中（未存档） */
  sealedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 存档批次请求：手动挑选若干批次一起存档。存档时再校验一次：批次下所有项目的
 * 「上海院已支付 / 支付下家 / 支付陈沛」必须全部为是，任一批次不满足则整体拒绝、都不存档。
 */
export interface SealBatchesInput {
  batchIds: string[];
}

/** 新增/修改批次 */
export interface BatchInput {
  batchNo: number;
  note?: string;
}

/**
 * 新建项目（项目管理 → 未结算项目 →「新建项目」）：金额为整数分。
 * 项目只有一张表：新建的项目不归属合同（contractId 为空），因此出现在未结算项目表里；上海院已支付固定为否。
 */
export interface CreateProjectInput {
  region: string;
  name: string;
  contractPrice: number;
  qxReceived: number;
  qxSubcontractFee: number;
  chenPei: number;
  qxProfit: number;
  note?: string;
}

/**
 * 合同：独立创建/删除。合同总价不单独录入，等于其下各项目「合同价」之和（整数分求和）。
 * 每个合同必须属于一个批次。
 * 「删除」合同 = 归档，只有其下没有任何项目时才允许；不物理删除。
 */
export interface Contract {
  id: string;
  /** 所属批次 id */
  batchId: string;
  /** 所属批次号（0 表示迁移产生的「未分批」兜底批次） */
  batchNo: number;
  contractNo: string;
  /** 合同总价（分）= 其下项目合同价之和 */
  totalPrice: number;
  /** 企信实收（分）= 其下项目企信实收之和 */
  qxReceived: number;
  /** 企信利润（分）= 其下项目企信利润之和 */
  qxProfit: number;
  /** 其下项目数 */
  projectCount: number;
  /** 其下项目的区域（去重、非空、按名称排序） */
  regions: string[];
  /** 备注，可为空字符串 */
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** 合同详情：包含其下全部项目（用于合同详情页展示项目名称列表等） */
export interface ContractDetail extends Contract {
  projects: Array<Pick<Project, 'id' | 'name' | 'batchNo' | 'region' | 'contractPrice'>>;
}

/** 合同里的一个项目及其合同价（分） */
export interface ContractProjectInput {
  projectId: string;
  contractPrice: number;
}

/**
 * 新增合同：归属某个批次；从未结算项目里挑选项目，并给每个项目设置合同价；合同总价由此求和得到。
 * 项目归入合同 = 变为已结算项目，但不入账；入账在编辑项目里把「上海院已支付」切换为是时发生。
 */
export interface CreateContractInput {
  /** 所属批次 id（必填） */
  batchId: string;
  contractNo: string;
  /** 备注；省略 = 空 */
  note?: string;
  projects: ContractProjectInput[];
}

/**
 * 修改合同：合同编号、备注、所属批次，以及项目的合同价。
 * - note：省略保持原值（如在合同里新增项目时只改合同价，不会清掉备注）；传空字符串 = 清空；
 * - batchId：省略保持不变；指定其他批次即把合同（连同其下项目）移到该批次；
 * - 本合同已有的项目：只修改合同价；
 * - 不属于本合同的项目：必须是「未归入任何合同」的项目，会被加入本合同并设置合同价（不入账）；
 * - 请求里没出现的已有项目保持不变（这里不移除项目）。
 */
export interface UpdateContractInput {
  batchId?: string;
  contractNo: string;
  note?: string;
  projects: ContractProjectInput[];
}

/** 项目 Excel 导入表头（第 1 行）。项目名称为「合计」的行与重复表头的说明行会被忽略。 */
export const PROJECT_IMPORT_HEADERS = [
  '合同编号',
  '批次',
  '区域',
  '项目名称',
  '合同价',
  '企信实收',
  '企信支付下家',
  '陈沛',
  '企信利润',
  '上海院已支付',
  '支付下家',
  '支付陈沛',
  '备注'
] as const;

/**
 * 导入时表头里必须有的列；其余列都是可选的：缺列时，新增项目用默认值（文字为空、金额为 0、批次为空、是否类为否），
 * 更新已有项目时保持库里原值，不会被清零。
 */
export const PROJECT_IMPORT_REQUIRED_HEADERS = ['项目名称', '合同价'] as const;

/**
 * 旧版 Excel 的列名：导入时仍然认旧表头，避免用户手里的旧文件无法导入（该列被当成缺列会静默忽略）。
 * - 「企信支付下家」旧称「企信支付下家分包费」。
 */
export const PROJECT_IMPORT_LEGACY_HEADERS: Record<string, string> = {
  企信支付下家: '企信支付下家分包费'
};

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
  /** 借款（净借出额）：累计借款(借出) − 累计贷款(借入)，不受时间段影响；金额单位：分 */
  borrow: BorrowSummary;
}

/** 借款统计：按往来单位（借款对象）汇总净借出额；未填写往来单位的归为「未填写」 */
export interface BorrowSummary {
  /** 各对象净借出额之和（可为负：借入多于借出） */
  total: number;
  /** 净额不为 0 的对象，按净借出额从大到小 */
  items: Array<{ name: string; amount: number }>;
}

/** 指定时间段（含首尾日期）内的收支统计，只统计收入/支出；金额单位：分 */
export interface PeriodSummary {
  from: string | null;
  to: string | null;
  income: number;
  expense: number;
  /** 结余 = 收入 − 支出 */
  profit: number;
  /** 命中的收入/支出流水笔数 */
  count: number;
  /** 支出按分类（金额从大到小） */
  expenseByCategory: Array<{ categoryId: string | null; categoryName: string; amount: number; count: number }>;
  /** 收入按分类 */
  incomeByCategory: Array<{ categoryId: string | null; categoryName: string; amount: number; count: number }>;
  /** 支出按往来单位（钱付给了谁）；未填写往来单位的归为「未填写」 */
  expenseByCounterparty: Array<{ name: string; amount: number; count: number }>;
  /** 收入按往来单位（钱来自谁） */
  incomeByCounterparty: Array<{ name: string; amount: number; count: number }>;
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
