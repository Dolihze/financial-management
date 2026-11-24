import ExcelJS from 'exceljs';
import {
  PROJECT_IMPORT_HEADERS,
  PROJECT_IMPORT_LEGACY_HEADERS,
  PROJECT_IMPORT_REQUIRED_HEADERS,
  toCents,
  type ImportRowError,
  type Project,
  type ProjectImportPreview,
  type ProjectImportResult,
  type CreateProjectInput,
  type ProjectPostingKind,
  type UpdateProjectInput
} from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';
import { MAX_BATCH_NO, UNBATCHED_NO } from './batchService';
import { CategoryService, PROJECT_INCOME_CATEGORY_NAME } from './categoryService';
import { TransactionService } from './transactionService';

/**
 * 三个「是/否」字段 与 记账流水 的对应关系：
 * - 项目结算（原企信是否收到钱） -> 收入，金额取「企信实收」
 * - 支付下家       -> 支出，金额取「企信支付下家」
 * - 支付陈沛       -> 支出，金额取「陈沛」
 * 入账流水统一带内置分类（category），往来单位与备注置空。
 */
const POSTING_RULES: Record<
  ProjectPostingKind,
  {
    label: string;
    txType: 'income' | 'expense';
    flag: 'qxMoneyReceived' | 'paidSubcontractor' | 'paidChenPei';
    amount: 'qxReceived' | 'qxSubcontractFee' | 'chenPei';
    /** 入账流水使用的内置分类名称（与 category.kind = txType 对应） */
    category: string;
  }
> = {
  qx_received: { label: '项目结算', txType: 'income', flag: 'qxMoneyReceived', amount: 'qxReceived', category: PROJECT_INCOME_CATEGORY_NAME },
  paid_subcontractor: { label: '支付下家', txType: 'expense', flag: 'paidSubcontractor', amount: 'qxSubcontractFee', category: '企信支付下家分包费' },
  paid_chen_pei: { label: '支付陈沛', txType: 'expense', flag: 'paidChenPei', amount: 'chenPei', category: '企信支付陈沛' }
};
const POSTING_KINDS = Object.keys(POSTING_RULES) as ProjectPostingKind[];

interface ProjectRow {
  id: string;
  contract_id: string | null;
  contract_no: string;
  batch_no: number | null;
  region: string;
  name: string;
  contract_price: number;
  qx_received: number;
  qx_subcontract_fee: number;
  chen_pei: number;
  qx_profit: number;
  qx_money_received: number;
  paid_subcontractor: number;
  paid_chen_pei: number;
  note: string;
  created_at: string;
  updated_at: string;
}

const toProject = (r: ProjectRow, postedKinds: ProjectPostingKind[] = []): Project => ({
  id: r.id,
  contractId: r.contract_id,
  contractNo: r.contract_no,
  batchNo: r.batch_no,
  region: r.region,
  name: r.name,
  contractPrice: r.contract_price,
  qxReceived: r.qx_received,
  qxSubcontractFee: r.qx_subcontract_fee,
  chenPei: r.chen_pei,
  qxProfit: r.qx_profit,
  qxMoneyReceived: r.qx_money_received === 1,
  paidSubcontractor: r.paid_subcontractor === 1,
  paidChenPei: r.paid_chen_pei === 1,
  note: r.note,
  postedKinds,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

/**
 * 一行已校验的导入数据。
 * 除 name / contractPrice（必填列）外，其余字段为 null 表示「Excel 里没有这一列」：
 * 新增项目时取默认值，更新已有项目时保留库里的原值（不覆盖）。
 * 注意区分「没有这一列」(null) 和「有这一列但单元格为空」(空字符串 / 0 / false)，后者是明确的「置空」。
 */
export interface ParsedProjectRow {
  row: number;
  name: string;
  contractPrice: number;
  contractNo: string | null;
  /**
   * Excel「批次」列：undefined = 没有这一列；null = 有这一列但单元格为空。
   * 只用于「新建合同」时决定合同归属的批次；已存在合同的批次不会被改动。
   */
  batchNo: number | null | undefined;
  region: string | null;
  qxReceived: number | null;
  qxSubcontractFee: number | null;
  chenPei: number | null;
  qxProfit: number | null;
  qxMoneyReceived: boolean | null;
  paidSubcontractor: boolean | null;
  paidChenPei: boolean | null;
  note: string | null;
}

interface ParseOutcome {
  rows: ParsedProjectRow[];
  errors: ImportRowError[];
  total: number;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('').trim();
    if ('text' in v) return String(v.text).trim();
    if ('result' in v) return String(v.result ?? '').trim();
    if ('error' in v) return '';
  }
  return String(v).trim();
}

/** 金额单元格：空视为 0；公式单元格取计算结果；其余必须是合法金额。返回整数分。 */
function parseMoney(v: ExcelJS.CellValue, label: string): number {
  if (v != null && typeof v === 'object' && !(v instanceof Date) && 'result' in v) v = v.result as ExcelJS.CellValue;
  if (v == null || (typeof v === 'string' && v.trim() === '')) return 0;
  if (typeof v === 'number') return toCents(v);
  try {
    return toCents(cellText(v));
  } catch {
    throw new Error(`${label}不是有效金额: ${cellText(v)}`);
  }
}

/**
 * 批次：Excel 里写作「第15批」，导入后只保留数字 15（批次号）。
 * 接受「第15批」「15」（含数字单元格、首尾/中间空白）；空值返回 null；其他写法报错，不做猜测。
 */
function parseBatchNo(v: ExcelJS.CellValue): number | null {
  const raw = typeof v === 'number' ? String(v) : cellText(v);
  const text = raw.replace(/\s+/g, '');
  if (text === '') return null;
  const m = /^(?:第(\d+)批|(\d+))$/.exec(text);
  if (!m) throw new Error(`批次格式无法识别: ${raw}（应为「第15批」或数字 15）`);
  const n = Number(m[1] ?? m[2]);
  if (!Number.isSafeInteger(n) || n > MAX_BATCH_NO) throw new Error(`批次号超出范围: ${raw}`);
  if (n < 1) throw new Error(`批次号必须从 1 开始: ${raw}`); // 0 号保留给「未分批」兜底批次
  return n;
}

/** 「是否」字段：只有明确写「是」才为真，其他任何内容（含空）一律按「否」 */
const parseYesNo = (v: ExcelJS.CellValue): boolean => cellText(v) === '是';

export class ProjectService {
  private readonly txService: TransactionService;
  private readonly categories: CategoryService;

  constructor(
    private readonly db: Db,
    private readonly deviceId: string,
    attachmentsDir?: string
  ) {
    this.txService = new TransactionService(db, deviceId, attachmentsDir);
    this.categories = new CategoryService(db, deviceId);
  }

  /** 入账流水的内置分类 id；分类不存在（极端情况，如被手工改库）返回 null，入账仍可进行但不带分类 */
  private postingCategoryId(kind: ProjectPostingKind): string | null {
    const rule = POSTING_RULES[kind];
    return this.categories.findByName(rule.txType, rule.category)?.id ?? null;
  }

  /** 各项目当前「有效入账」的字段（有对应流水；流水被删除时入账关联一并删除） */
  private postedKindsOf(ids: string[]): Map<string, ProjectPostingKind[]> {
    const map = new Map<string, ProjectPostingKind[]>();
    if (ids.length === 0) return map;
    const rows = this.db
      .prepare(
        `SELECT p.project_id AS projectId, p.kind AS kind FROM project_posting p
         WHERE p.active = 1 AND p.project_id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as Array<{ projectId: string; kind: ProjectPostingKind }>;
    for (const r of rows) map.set(r.projectId, [...(map.get(r.projectId) ?? []), r.kind]);
    return map;
  }

  /**
   * 项目列表（项目只有一张表，是否结算由「项目结算」字段 qx_money_received 区分）：
   * - 传 contractId 时只返回该合同下的项目（合同必须存在）；
   * - 传 settled 时按「项目结算」筛选：true = 已结算项目表（结算 = 是），false = 未结算项目表（结算 = 否）。
   */
  list(contractId?: string, settled?: boolean): Project[] {
    if (contractId !== undefined) {
      const hit = this.db.prepare('SELECT 1 FROM contract WHERE id = ? AND archived = 0').get(contractId);
      if (!hit) throw new AppError('合同不存在', 404, 'NOT_FOUND');
    }
    const where = ['archived = 0'];
    const args: unknown[] = [];
    if (contractId !== undefined) {
      where.push('contract_id = ?');
      args.push(contractId);
    }
    if (settled !== undefined) {
      where.push('qx_money_received = ?');
      args.push(settled ? 1 : 0);
    }
    const rows = this.db
      .prepare(`SELECT * FROM project WHERE ${where.join(' AND ')} ORDER BY created_at DESC, rowid DESC`)
      .all(...args) as ProjectRow[];
    const posted = this.postedKindsOf(rows.map((r) => r.id));
    return rows.map((r) => toProject(r, posted.get(r.id) ?? []));
  }

  /**
   * 新建项目（未结算项目表的「新建项目」）：项目结算 = 否、不归属合同、支付下家/支付陈沛 = 否，不入账。
   * 项目名称在未归档项目中唯一（Excel 导入以名称匹配）。
   */
  create(input: CreateProjectInput): Project {
    const name = input.name.trim();
    if (!name) throw new AppError('项目名称不能为空', 400, 'VALIDATION');
    const clash = this.db.prepare('SELECT 1 FROM project WHERE name = ? AND archived = 0').get(name);
    if (clash) throw new AppError(`项目名称「${name}」已存在，请换一个名称`, 409, 'DUPLICATE_NAME');
    const id = newId();
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO project (id,contract_id,contract_no,batch_no,region,name,contract_price,qx_received,qx_subcontract_fee,chen_pei,qx_profit,
                                qx_money_received,paid_subcontractor,paid_chen_pei,note,archived,created_at,updated_at,device_id)
           VALUES (?,NULL,'',NULL,?,?,?,?,?,?,?,0,0,0,?,0,?,?,?)`
        )
        .run(
          id, input.region.trim(), name,
          input.contractPrice, input.qxReceived, input.qxSubcontractFee, input.chenPei, input.qxProfit,
          (input.note ?? '').trim(), now, now, this.deviceId
        );
      writeAudit(this.db, this.deviceId, 'project', id, 'create', { name, region: input.region.trim(), contractPrice: input.contractPrice });
    })();
    return this.get(id);
  }

  /**
   * 结算项目（在调用方的事务内执行）：把「项目结算」由否置为是，并记一笔收入（金额取企信实收）、写入入账关联。
   * 项目归入合同 = 结算，所以合同服务在归入项目时调用它。
   * 已结算的项目直接跳过（返回 null）；企信实收必须大于 0 才能入账，否则拒绝（与详情页切换为「是」同一规则）。
   * 返回入账的流水 id。
   */
  settleWithinTx(
    project: { id: string; name: string; qxReceived: number },
    posting: { accountId: string; date: string }
  ): string {
    const rule = POSTING_RULES.qx_received;
    if (project.qxReceived <= 0) {
      throw new AppError(`项目「${project.name}」企信实收为 0，无法结算入账，请先填写企信实收`, 400, 'SETTLE_AMOUNT_REQUIRED');
    }
    const now = nowIso();
    const txId = this.txService.insertWithinTx({
      occurredOn: posting.date,
      type: rule.txType,
      amount: project.qxReceived,
      accountId: posting.accountId,
      categoryId: this.postingCategoryId('qx_received'), // 内置「项目收入」；往来单位、备注置空
      note: ''
    });
    this.db.prepare('UPDATE project SET qx_money_received = 1, updated_at = ? WHERE id = ?').run(now, project.id);
    this.db
      .prepare('INSERT INTO project_posting (id, project_id, kind, tx_id, active, created_at) VALUES (?,?,?,?,1,?)')
      .run(newId(), project.id, 'qx_received', txId, now);
    writeAudit(this.db, this.deviceId, 'project', project.id, 'settle', {
      name: project.name, amount: project.qxReceived, txId, date: posting.date
    });
    return txId;
  }

  /** 已有的区域（未归档项目里出现过的非空区域，去重，按名称排序），供下拉选择 */
  regions(): string[] {
    const rows = this.db
      .prepare("SELECT DISTINCT region FROM project WHERE archived = 0 AND region <> '' ORDER BY region")
      .all() as Array<{ region: string }>;
    return rows.map((r) => r.region);
  }

  get(id: string): Project {
    const row = this.db.prepare('SELECT * FROM project WHERE id = ? AND archived = 0').get(id) as ProjectRow | undefined;
    if (!row) throw new AppError('项目不存在', 404, 'NOT_FOUND');
    return toProject(row, this.postedKindsOf([id]).get(id) ?? []);
  }

  /**
   * 修改项目（详情页整体保存），并在同一个数据库事务内完成入账/回退：
   * - 字段从「否」切到「是」：按规则生成一笔流水（需 postingAccountId），记录关联；
   * - 字段从「是」切到「否」：删除之前生成的那笔流水（物理删除，写审计），解除关联；
   * - 字段保持「是」且已入账：对应金额不能直接修改（先切回「否」回退，再改金额再入账）；
   * 任何一步失败整体回滚，项目与流水不会出现只改了一半。
   * 项目名称是 Excel 导入的匹配键，不能与其他未归档项目重名。
   */
  update(id: string, input: UpdateProjectInput): Project {
    const current = this.get(id);
    const name = input.name.trim();
    if (!name) throw new AppError('项目名称不能为空', 400, 'VALIDATION');
    const clash = this.db.prepare('SELECT 1 FROM project WHERE name = ? AND archived = 0 AND id <> ?').get(name, id);
    if (clash) throw new AppError(`项目名称「${name}」已存在，请换一个名称`, 409, 'DUPLICATE_NAME');

    // 换合同：只能换到已有的未归档合同；批次号随新合同派生。不支持通过此接口把未归合同的项目归入合同、或移出合同。
    let moveTo: { id: string; contractNo: string; batchNo: number | null } | null = null;
    if (input.contractId !== undefined && input.contractId !== current.contractId) {
      if (!current.contractId) {
        throw new AppError('项目尚未归入合同，请在合同管理中把它加入合同', 409, 'PROJECT_NOT_IN_CONTRACT');
      }
      const c = this.db
        .prepare(
          `SELECT c.id, c.contract_no AS contractNo, b.batch_no AS batchNo
           FROM contract c JOIN batch b ON b.id = c.batch_id WHERE c.id = ? AND c.archived = 0`
        )
        .get(input.contractId) as { id: string; contractNo: string; batchNo: number } | undefined;
      if (!c) throw new AppError('所选合同不存在', 404, 'NOT_FOUND');
      moveTo = { id: c.id, contractNo: c.contractNo, batchNo: c.batchNo === UNBATCHED_NO ? null : c.batchNo };
    }

    // 先算出需要入账/回退的字段并做业务校验（还没写库）
    const toPost: ProjectPostingKind[] = [];
    const toRevert: ProjectPostingKind[] = [];
    for (const kind of POSTING_KINDS) {
      const rule = POSTING_RULES[kind];
      const wasYes = current[rule.flag];
      // 该字段在入参里省略时，视为保持当前值：既不入账也不回退（例如详情页不再提供「项目结算」）
      const isYes = input[rule.flag] ?? wasYes;
      const posted = current.postedKinds.includes(kind);
      if (!wasYes && isYes) toPost.push(kind);
      else if (wasYes && !isYes && posted) toRevert.push(kind);
      else if (wasYes && isYes && posted && input[rule.amount] !== current[rule.amount]) {
        throw new AppError(
          `「${rule.label}」已入账，不能直接修改对应金额。请先切换为「否」回退入账，修改金额后再切换为「是」`,
          409,
          'POSTED_AMOUNT_LOCKED'
        );
      }
      // wasYes && !isYes && !posted：历史标记（Excel 导入的「是」，没有流水），只改标记，不报错
    }
    for (const kind of toPost) {
      const rule = POSTING_RULES[kind];
      if (input[rule.amount] <= 0) throw new AppError(`「${rule.label}」切换为「是」需要入账，但对应金额必须大于 0`, 400, 'VALIDATION');
    }
    if (toPost.length > 0 && !input.postingAccountId) {
      throw new AppError('切换为「是」会入账，请选择入账账户', 400, 'POSTING_ACCOUNT_REQUIRED');
    }

    const revertedFiles: string[] = [];
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE project SET region=?, name=?, contract_price=?, qx_received=?, qx_subcontract_fee=?,
                  chen_pei=?, qx_profit=?, qx_money_received=?, paid_subcontractor=?, paid_chen_pei=?, note=?, updated_at=? WHERE id=?`
        )
        .run(
          input.region.trim(), name,
          input.contractPrice, input.qxReceived, input.qxSubcontractFee, input.chenPei, input.qxProfit,
          (input.qxMoneyReceived ?? current.qxMoneyReceived) ? 1 : 0, input.paidSubcontractor ? 1 : 0, input.paidChenPei ? 1 : 0,
          input.note === undefined ? current.note : input.note.trim(), nowIso(), id
        );
      if (moveTo) {
        this.db
          .prepare('UPDATE project SET contract_id = ?, contract_no = ?, batch_no = ?, updated_at = ? WHERE id = ?')
          .run(moveTo.id, moveTo.contractNo, moveTo.batchNo, nowIso(), id);
      }

      const now = nowIso();
      // 未指定时用服务器本地日期（不能用 toISOString，UTC 与本地时区会差一天）
      const localToday = (() => {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      })();
      const postingDate = input.postingDate ?? localToday;
      const postings: Array<{ kind: ProjectPostingKind; action: 'post' | 'revert'; txId: string; amount: number; date?: string }> = [];

      for (const kind of toRevert) {
        const link = this.db
          .prepare('SELECT id, tx_id AS txId FROM project_posting WHERE project_id = ? AND kind = ? AND active = 1')
          .get(id, kind) as { id: string; txId: string };
        // 删除入账流水（物理删除，连带 project_posting 关联一并删除；回退记录保留在本次项目审计的 postings 里）
        const tx = this.txService.get(link.txId);
        const amount = Math.abs(tx.lines.reduce((s, l) => s + l.amount, 0));
        revertedFiles.push(...this.txService.removeWithinTx(link.txId));
        postings.push({ kind, action: 'revert', txId: link.txId, amount });
      }

      for (const kind of toPost) {
        const rule = POSTING_RULES[kind];
        const amount = input[rule.amount];
        const txId = this.db.transaction(() =>
          this.txService.insertWithinTx({
            occurredOn: postingDate,
            type: rule.txType,
            amount,
            accountId: input.postingAccountId,
            categoryId: this.postingCategoryId(kind), // 内置分类；往来单位、备注置空
            note: ''
          })
        )();
        this.db
          .prepare('INSERT INTO project_posting (id, project_id, kind, tx_id, active, created_at) VALUES (?,?,?,?,1,?)')
          .run(newId(), id, kind, txId, now);
        postings.push({ kind, action: 'post', txId, amount, date: postingDate });
      }

      writeAudit(this.db, this.deviceId, 'project', id, 'update', {
        before: current,
        after: { ...input, name, ...(moveTo ? { contractNo: moveTo.contractNo, batchNo: moveTo.batchNo } : {}) },
        postings
      });
    })();
    this.txService.deleteFiles(revertedFiles); // 事务提交后清理被删流水的附件文件
    return this.get(id);
  }
  /**
   * 「删除」项目：按规则不物理删除，只归档（列表与详情不再可见，名称可被新项目复用）。
   * 已入账（有对应有效流水）的项目不能删除：否则流水会失去来源。需先把对应字段切回「否」回退入账。
   */
  archive(id: string): Project {
    const current = this.get(id);
    if (current.postedKinds.length > 0) {
      const labels = current.postedKinds.map((k) => POSTING_RULES[k].label).join('、');
      throw new AppError(`项目已入账（${labels}），不能直接删除。请先将这些字段切换为「否」回退入账后再删除`, 409, 'PROJECT_HAS_POSTINGS');
    }
    this.db.transaction(() => {
      this.db.prepare('UPDATE project SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
      writeAudit(this.db, this.deviceId, 'project', id, 'archive', { name: current.name, contractNo: current.contractNo });
    })();
    return current; // 返回被归档的项目（与其他接口一致，始终返回 JSON）
  }

  /** 生成导入模板：第 1 行表头，第 2 行合计（项目名称为「合计」，导入时忽略），之后为数据 */
  async buildTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('项目导入');
    ws.addRow([...PROJECT_IMPORT_HEADERS]);
    ws.addRow(['', '', '', '合计', 1500000, 1000000, 600000, 100000, 300000, '', '', '', '']);
    ws.addRow(['HT-2026-001', '第1批', '华东', '示例项目A', 1000000, 800000, 400000, 50000, 200000, '是', '是', '否', '']);
    // 未结算项目：合同编号留空、项目结算为否（填了合同编号就视为已结算，项目结算必须为是）
    ws.addRow(['', '', '华南', '示例项目B', 500000, 200000, 200000, 50000, 100000, '否', '否', '否', '示例备注']);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 18));
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  private async parse(buffer: Buffer): Promise<ParseOutcome> {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as unknown as ArrayBuffer);
    } catch {
      throw new AppError('无法解析 Excel 文件，请确认是 .xlsx 格式');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new AppError('Excel 中没有工作表');

    // 按表头名称定位列，不依赖列顺序；缺列直接报错
    const headerRow = ws.getRow(1);
    const colOf = new Map<string, number>();
    headerRow.eachCell((cell, col) => {
      const t = cellText(cell.value).replace(/\s+/g, '');
      if (t && !colOf.has(t)) colOf.set(t, col);
    });
    // 新表头缺失时，回退到旧表头（如「项目结算」缺失则找「企信是否收到钱」，「企信支付下家」缺失则找「企信支付下家分包费」）
    for (const [now, legacy] of Object.entries(PROJECT_IMPORT_LEGACY_HEADERS)) {
      if (!colOf.has(now) && colOf.has(legacy)) colOf.set(now, colOf.get(legacy)!);
    }
    // 只有「项目名称」「合同价」必须有；其余列都可以整列缺失
    const missing = PROJECT_IMPORT_REQUIRED_HEADERS.filter((h) => !colOf.has(h));
    if (missing.length > 0) throw new AppError(`Excel 第一行缺少必填表头: ${missing.join('、')}`, 422, 'IMPORT_HEADER_MISSING');
    type Header = (typeof PROJECT_IMPORT_HEADERS)[number];
    const has = (h: Header) => colOf.has(h);
    const cell = (row: ExcelJS.Row, h: Header) => (has(h) ? row.getCell(colOf.get(h)!).value : null);
    const knownCols = PROJECT_IMPORT_HEADERS.filter((h) => has(h));

    const rows: ParsedProjectRow[] = [];
    const errors: ImportRowError[] = [];
    const seen = new Map<string, number>(); // 项目名称 -> 首次出现的行号（项目名称是唯一键）
    let total = 0;

    ws.eachRow((excelRow, rowNumber) => {
      if (rowNumber <= 1) return; // 第 1 行表头
      if (knownCols.every((h) => cellText(cell(excelRow, h)) === '')) return; // 空行（只看表里存在的列）
      // 非数据行：合计行（项目名称为「合计」），以及重复表头的说明行（项目名称与表头同名）。
      // 不按固定行号跳过，这样「第 2 行合计」和「第 2 行说明 + 第 3 行合计」两种 Excel 结构都能导入。
      const rowName = cellText(cell(excelRow, '项目名称')).replace(/\s+/g, '');
      if (rowName === '合计' || rowName === '项目名称') return;
      total += 1;
      try {
        const name = cellText(cell(excelRow, '项目名称'));
        if (!name) throw new Error('项目名称不能为空');
        if (name.length > 100) throw new Error('项目名称不能超过 100 个字符');
        const dupRow = seen.get(name);
        if (dupRow !== undefined) throw new Error(`项目名称「${name}」与第 ${dupRow} 行重复`);

        // 没有这一列 -> null / undefined（表示「不涉及」）；有这一列 -> 按单元格内容解析（空单元格也是明确的值）
        const text = (h: Header, max: number, label: string): string | null => {
          if (!has(h)) return null;
          const v = cellText(cell(excelRow, h));
          if (v.length > max) throw new Error(`${label}不能超过 ${max} 个字符`);
          return v;
        };
        const money = (h: Header): number | null => (has(h) ? parseMoney(cell(excelRow, h), h) : null);
        const yesNo = (h: Header): boolean | null => (has(h) ? parseYesNo(cell(excelRow, h)) : null);

        rows.push({
          row: rowNumber,
          name,
          contractPrice: parseMoney(cell(excelRow, '合同价'), '合同价'),
          contractNo: text('合同编号', 50, '合同编号'),
          batchNo: has('批次') ? parseBatchNo(cell(excelRow, '批次')) : undefined,
          region: text('区域', 50, '区域'),
          qxReceived: money('企信实收'),
          qxSubcontractFee: money('企信支付下家'),
          chenPei: money('陈沛'),
          qxProfit: money('企信利润'),
          qxMoneyReceived: yesNo('项目结算'),
          paidSubcontractor: yesNo('支付下家'),
          paidChenPei: yesNo('支付陈沛'),
          note: text('备注', 500, '备注')
        });
        seen.set(name, rowNumber);
      } catch (e) {
        errors.push({ row: rowNumber, message: e instanceof Error ? e.message : String(e) });
      }
    });
    this.checkSettledWhenInContract(rows, errors);
    return { rows, errors, total };
  }

  /**
   * 项目归入合同即结算：导入后「在合同里」的项目，「项目结算」必须为是；否则整批拒绝（按行报错，预览与确认导入一致）。
   * 按导入后的最终状态判断，而不是只看单元格：
   * - 合同编号不为空（含新增项目）而项目结算为否 / 空白 / 没有这一列（新增项目默认否）→ 拒绝；
   * - 更新已有项目时，Excel 缺列的字段沿用库里原值；没有「合同编号」列时合同归属也沿用库里原值；
   * - 项目结算已入账（有有效收入流水）时，导入不会覆盖该标记，一律视为已结算，不拦。
   * 注意：错误信息里的行号是 Excel 的行号。
   */
  private checkSettledWhenInContract(rows: ParsedProjectRow[], errors: ImportRowError[]): void {
    if (rows.length === 0) return;
    const existing = this.existingByName(rows.map((r) => r.name));
    const find = this.db.prepare('SELECT contract_id, qx_money_received FROM project WHERE id = ?');
    for (const r of rows) {
      const hit = existing.get(r.name);
      const cur = hit ? (find.get(hit.id) as { contract_id: string | null; qx_money_received: number }) : undefined;

      // 导入后是否在合同里：有「合同编号」列按单元格（空 = 不在合同）；没有该列则新增项目不在、已有项目沿用原归属
      const inContract = r.contractNo !== null ? r.contractNo !== '' : Boolean(cur?.contract_id);
      if (!inContract) continue;

      // 导入后项目结算的最终值：已入账的保持是；否则按 Excel（缺列时：新增为否、已有沿用原值）
      const posted = hit?.posted.includes('qx_received') ?? false;
      const settled = posted ? true : r.qxMoneyReceived !== null ? r.qxMoneyReceived : cur ? cur.qx_money_received === 1 : false;
      if (settled) continue;

      const where = r.contractNo ? `合同编号为「${r.contractNo}」` : '项目已在合同中';
      errors.push({
        row: r.row,
        message: `项目「${r.name}」${where}，但「项目结算」不是「是」：项目归入合同即视为已结算，请将项目结算改为「是」，或清空合同编号`
      });
    }
  }

  /** 库中已存在（未归档）的项目：名称 -> id 及其已入账字段 */
  private existingByName(names: string[]): Map<string, { id: string; posted: ProjectPostingKind[] }> {
    const found = new Map<string, { id: string; posted: ProjectPostingKind[] }>();
    const stmt = this.db.prepare('SELECT id FROM project WHERE name = ? AND archived = 0');
    for (const n of names) {
      const hit = stmt.get(n) as { id: string } | undefined;
      if (hit) found.set(n, { id: hit.id, posted: [] });
    }
    const posted = this.postedKindsOf([...found.values()].map((v) => v.id));
    for (const v of found.values()) v.posted = posted.get(v.id) ?? [];
    return found;
  }

  /** 预览：不写库 */
  async preview(buffer: Buffer): Promise<ProjectImportPreview> {
    const { rows, errors, total } = await this.parse(buffer);
    const existing = this.existingByName(rows.map((r) => r.name));
    const partially = [...existing.values()].filter((v) => v.posted.length > 0).length;
    return { total, toCreate: rows.length - existing.size, toUpdate: existing.size, toUpdatePartially: partially, errors };
  }

  /**
   * 确认导入：整批一个事务；有错误行时拒绝导入。以项目名称匹配：已存在则更新，否则新增。
   * 已入账（有对应有效流水）的字段，其「是」标记和对应金额不会被 Excel 覆盖，以保证流水与项目账实一致；
   * 导入本身不生成任何流水（Excel 里的「是」只是标记）。
   */
  async commit(buffer: Buffer, fileName: string): Promise<ProjectImportResult> {
    const { rows, errors, total } = await this.parse(buffer);
    if (errors.length > 0) throw new AppError(`存在 ${errors.length} 行错误，请修正后重新导入`, 422, 'IMPORT_INVALID');

    let created = 0;
    let updated = 0;
    let skippedPosted = 0;
    const now = nowIso();
    this.db.transaction(() => {
      const existing = this.existingByName(rows.map((r) => r.name));
      const insert = this.db.prepare(
        `INSERT INTO project (id,contract_id,contract_no,batch_no,region,name,contract_price,qx_received,qx_subcontract_fee,chen_pei,qx_profit,
                              qx_money_received,paid_subcontractor,paid_chen_pei,note,archived,created_at,updated_at,device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`
      );
      const update = this.db.prepare(
        `UPDATE project SET contract_id=?, contract_no=?, batch_no=?, region=?, contract_price=?, qx_received=?, qx_subcontract_fee=?, chen_pei=?,
                qx_profit=?, qx_money_received=?, paid_subcontractor=?, paid_chen_pei=?, note=?, updated_at=? WHERE id=?`
      );
      const currentRow = this.db.prepare('SELECT * FROM project WHERE id = ?');
      // Excel 里的批次号 -> 批次 id：批次表里没有就自动创建（本批内同一批次号只创建一次）。
      // 批次号 null（Excel 没填）-> 0 号「未分批」兜底批次
      const batchIds = new Map<number, string>();
      const findBatch = this.db.prepare('SELECT id FROM batch WHERE batch_no = ? AND archived = 0');
      const insertBatch = this.db.prepare(
        'INSERT INTO batch (id, batch_no, note, archived, created_at, updated_at, device_id) VALUES (?,?,?,0,?,?,?)'
      );
      const batchIdOf = (batchNo: number | null): string => {
        const no = batchNo ?? UNBATCHED_NO;
        const cached = batchIds.get(no);
        if (cached) return cached;
        const hit = findBatch.get(no) as { id: string } | undefined;
        let id = hit?.id;
        if (!id) {
          id = newId();
          insertBatch.run(id, no, no === UNBATCHED_NO ? '未分批' : '', now, now, this.deviceId);
          writeAudit(this.db, this.deviceId, 'batch', id, 'import_create', { fileName, batchNo: no });
        }
        batchIds.set(no, id);
        return id;
      };
      // Excel 里的合同编号 -> 合同：合同表里没有就自动创建（本批内同一编号只创建一次），新合同归属该行 Excel 的批次；
      // 已存在的合同保持原来所属的批次（批次以合同为准，不被 Excel 的批次列改动）
      const contracts = new Map<string, { id: string; batchNo: number }>();
      const findContract = this.db.prepare(
        'SELECT c.id, b.batch_no AS batchNo FROM contract c JOIN batch b ON b.id = c.batch_id WHERE c.contract_no = ? AND c.archived = 0'
      );
      const insertContract = this.db.prepare(
        'INSERT INTO contract (id, contract_no, batch_id, archived, created_at, updated_at, device_id) VALUES (?,?,?,0,?,?,?)'
      );
      const contractOf = (contractNo: string, excelBatchNo: number | null): { id: string; batchNo: number } | null => {
        if (!contractNo) return null;
        const cached = contracts.get(contractNo);
        if (cached) return cached;
        let found = findContract.get(contractNo) as { id: string; batchNo: number } | undefined;
        if (!found) {
          const id = newId();
          insertContract.run(id, contractNo, batchIdOf(excelBatchNo), now, now, this.deviceId);
          writeAudit(this.db, this.deviceId, 'contract', id, 'import_create', { fileName, contractNo, batchNo: excelBatchNo ?? UNBATCHED_NO });
          found = { id, batchNo: excelBatchNo ?? UNBATCHED_NO };
        }
        contracts.set(contractNo, found);
        return found;
      };
      /** 项目冗余的批次号随合同走：「未分批」对应 NULL；无合同的项目没有批次 */
      const projectBatchNo = (c: { batchNo: number } | null): number | null => (c === null || c.batchNo === UNBATCHED_NO ? null : c.batchNo);
      const b = (v: boolean | null, fallback: number): number => (v === null ? fallback : v ? 1 : 0);
      for (const r of rows) {
        const hit = existing.get(r.name);
        if (hit) {
          // 更新已有项目：Excel 里没有的列保持库里原值；已入账的字段（标记 + 金额）无论如何都保持库里的值
          const cur = currentRow.get(hit.id) as ProjectRow;
          const keep = (kind: ProjectPostingKind) => hit.posted.includes(kind);
          const pick = <T>(excel: T | null, current: T): T => (excel === null ? current : excel);
          // 合同归属：Excel 没有「合同编号」列时不动；有这一列则按单元格走（空 = 脱离合同）
          const contractNo = r.contractNo === null ? cur.contract_no : r.contractNo;
          const contract = r.contractNo === null ? null : contractOf(r.contractNo, r.batchNo ?? null);
          const contractId = r.contractNo === null ? cur.contract_id : (contract?.id ?? null);
          const money = [
            r.contractPrice,
            keep('qx_received') ? cur.qx_received : pick(r.qxReceived, cur.qx_received),
            keep('paid_subcontractor') ? cur.qx_subcontract_fee : pick(r.qxSubcontractFee, cur.qx_subcontract_fee),
            keep('paid_chen_pei') ? cur.chen_pei : pick(r.chenPei, cur.chen_pei),
            pick(r.qxProfit, cur.qx_profit)
          ] as const;
          const flags = [
            keep('qx_received') ? 1 : b(r.qxMoneyReceived, cur.qx_money_received),
            keep('paid_subcontractor') ? 1 : b(r.paidSubcontractor, cur.paid_subcontractor),
            keep('paid_chen_pei') ? 1 : b(r.paidChenPei, cur.paid_chen_pei)
          ] as const;
          // 批次号随合同走：没有「合同编号」列 -> 合同归属不动，批次号也保持；否则取（可能新建的）合同所属批次
          const batchNo = r.contractNo === null ? cur.batch_no : projectBatchNo(contract);
          update.run(
            contractId, contractNo, batchNo, pick(r.region, cur.region), ...money, ...flags,
            pick(r.note, cur.note), now, hit.id
          );
          writeAudit(this.db, this.deviceId, 'project', hit.id, 'import_update', {
            fileName, name: r.name, contractNo, keptPostedKinds: hit.posted
          });
          updated += 1;
          if (hit.posted.length > 0) skippedPosted += 1;
        } else {
          // 新增项目：Excel 里没有的列用默认值（文字空、金额 0、批次空、是否类为否）
          const contractNo = r.contractNo ?? '';
          const contract = contractOf(contractNo, r.batchNo ?? null);
          const contractId = contract?.id ?? null;
          const id = newId();
          const money = [r.contractPrice, r.qxReceived ?? 0, r.qxSubcontractFee ?? 0, r.chenPei ?? 0, r.qxProfit ?? 0] as const;
          const flags = [b(r.qxMoneyReceived, 0), b(r.paidSubcontractor, 0), b(r.paidChenPei, 0)] as const;
          insert.run(
            id, contractId, contractNo, projectBatchNo(contract), r.region ?? '', r.name, ...money, ...flags,
            r.note ?? '', now, now, this.deviceId
          );
          writeAudit(this.db, this.deviceId, 'project', id, 'import_create', { fileName, name: r.name, contractNo });
          created += 1;
        }
      }    })();
    return { total, created, updated, skippedPosted };
  }
}