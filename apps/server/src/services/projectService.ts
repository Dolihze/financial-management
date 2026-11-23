import ExcelJS from 'exceljs';
import {
  PROJECT_IMPORT_HEADERS,
  PROJECT_IMPORT_LEGACY_HEADERS,
  toCents,
  type ImportRowError,
  type Project,
  type ProjectImportPreview,
  type ProjectImportResult,
  type ProjectPostingKind,
  type UpdateProjectInput
} from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';
import { TransactionService } from './transactionService';

/**
 * 三个「是/否」字段 与 记账流水 的对应关系：
 * - 项目结算（原企信是否收到钱） -> 收入，金额取「企信实收」
 * - 支付下家       -> 支出，金额取「企信支付下家分包费」
 * - 支付陈沛       -> 支出，金额取「陈沛」
 */
const POSTING_RULES: Record<
  ProjectPostingKind,
  { label: string; txType: 'income' | 'expense'; flag: 'qxMoneyReceived' | 'paidSubcontractor' | 'paidChenPei'; amount: 'qxReceived' | 'qxSubcontractFee' | 'chenPei' }
> = {
  qx_received: { label: '项目结算', txType: 'income', flag: 'qxMoneyReceived', amount: 'qxReceived' },
  paid_subcontractor: { label: '支付下家', txType: 'expense', flag: 'paidSubcontractor', amount: 'qxSubcontractFee' },
  paid_chen_pei: { label: '支付陈沛', txType: 'expense', flag: 'paidChenPei', amount: 'chenPei' }
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
  postedKinds,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

/** 一行已校验的导入数据 */
export interface ParsedProjectRow {
  row: number;
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
  if (!Number.isSafeInteger(n)) throw new Error(`批次号超出范围: ${raw}`);
  return n;
}

/** 「是否」字段：只有明确写「是」才为真，其他任何内容（含空）一律按「否」 */
const parseYesNo = (v: ExcelJS.CellValue): boolean => cellText(v) === '是';

export class ProjectService {
  private readonly txService: TransactionService;

  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {
    this.txService = new TransactionService(db, deviceId);
  }

  /** 各项目当前「有效入账」的字段（有对应未作废流水） */
  private postedKindsOf(ids: string[]): Map<string, ProjectPostingKind[]> {
    const map = new Map<string, ProjectPostingKind[]>();
    if (ids.length === 0) return map;
    const rows = this.db
      .prepare(
        `SELECT p.project_id AS projectId, p.kind AS kind FROM project_posting p
         JOIN tx t ON t.id = p.tx_id AND t.status = 'normal'
         WHERE p.active = 1 AND p.project_id IN (${ids.map(() => '?').join(',')})`
      )
      .all(...ids) as Array<{ projectId: string; kind: ProjectPostingKind }>;
    for (const r of rows) map.set(r.projectId, [...(map.get(r.projectId) ?? []), r.kind]);
    return map;
  }

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM project WHERE archived = 0 ORDER BY created_at DESC, rowid DESC')
      .all() as ProjectRow[];
    const posted = this.postedKindsOf(rows.map((r) => r.id));
    return rows.map((r) => toProject(r, posted.get(r.id) ?? []));
  }

  get(id: string): Project {
    const row = this.db.prepare('SELECT * FROM project WHERE id = ? AND archived = 0').get(id) as ProjectRow | undefined;
    if (!row) throw new AppError('项目不存在', 404, 'NOT_FOUND');
    return toProject(row, this.postedKindsOf([id]).get(id) ?? []);
  }

  /**
   * 修改项目（详情页整体保存），并在同一个数据库事务内完成入账/回退：
   * - 字段从「否」切到「是」：按规则生成一笔流水（需 postingAccountId），记录关联；
   * - 字段从「是」切到「否」：作废之前生成的那笔流水（不物理删除），解除关联；
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

    // 先算出需要入账/回退的字段并做业务校验（还没写库）
    const toPost: ProjectPostingKind[] = [];
    const toRevert: ProjectPostingKind[] = [];
    for (const kind of POSTING_KINDS) {
      const rule = POSTING_RULES[kind];
      const wasYes = current[rule.flag];
      const isYes = input[rule.flag];
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

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE project SET batch_no=?, region=?, name=?, contract_price=?, qx_received=?, qx_subcontract_fee=?,
                  chen_pei=?, qx_profit=?, qx_money_received=?, paid_subcontractor=?, paid_chen_pei=?, updated_at=? WHERE id=?`
        )
        .run(
          input.batchNo, input.region.trim(), name,
          input.contractPrice, input.qxReceived, input.qxSubcontractFee, input.chenPei, input.qxProfit,
          input.qxMoneyReceived ? 1 : 0, input.paidSubcontractor ? 1 : 0, input.paidChenPei ? 1 : 0,
          nowIso(), id
        );

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
        // 作废流水（若已被手工作废则跳过，仍解除关联）
        const tx = this.txService.get(link.txId);
        const amount = Math.abs(tx.lines.reduce((s, l) => s + l.amount, 0));
        if (tx.status === 'normal') this.txService.void(link.txId, `项目「${name}」${POSTING_RULES[kind].label}切换为否，回退入账`);
        this.db.prepare('UPDATE project_posting SET active = 0, reverted_at = ? WHERE id = ?').run(now, link.id);
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
            note: `项目「${name}」${rule.label}${rule.txType === 'income' ? '（收入）' : '（支出）'}`
          })
        )();
        this.db
          .prepare('INSERT INTO project_posting (id, project_id, kind, tx_id, active, created_at) VALUES (?,?,?,?,1,?)')
          .run(newId(), id, kind, txId, now);
        postings.push({ kind, action: 'post', txId, amount, date: postingDate });
      }

      writeAudit(this.db, this.deviceId, 'project', id, 'update', {
        before: current,
        after: { ...input, name },
        postings
      });
    })();
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
    ws.addRow(['', '', '', '合计', 1500000, 1000000, 600000, 100000, 300000, '', '', '']);
    ws.addRow(['HT-2026-001', '第1批', '华东', '示例项目A', 1000000, 800000, 400000, 50000, 200000, '是', '是', '否']);
    ws.addRow(['HT-2026-002', '第2批', '华南', '示例项目B', 500000, 200000, 200000, 50000, 100000, '否', '否', '否']);
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
    // 新表头缺失时，回退到旧表头（如「项目结算」缺失则找「企信是否收到钱」）
    for (const [now, legacy] of Object.entries(PROJECT_IMPORT_LEGACY_HEADERS)) {
      if (!colOf.has(now) && colOf.has(legacy)) colOf.set(now, colOf.get(legacy)!);
    }
    const missing = PROJECT_IMPORT_HEADERS.filter((h) => !colOf.has(h));
    if (missing.length > 0) throw new AppError(`Excel 第一行缺少表头: ${missing.join('、')}`, 422, 'IMPORT_HEADER_MISSING');
    const cell = (row: ExcelJS.Row, h: (typeof PROJECT_IMPORT_HEADERS)[number]) => row.getCell(colOf.get(h)!).value;

    const rows: ParsedProjectRow[] = [];
    const errors: ImportRowError[] = [];
    const seen = new Map<string, number>(); // 项目名称 -> 首次出现的行号（项目名称是唯一键）
    let total = 0;

    ws.eachRow((excelRow, rowNumber) => {
      if (rowNumber <= 1) return; // 第 1 行表头
      if (PROJECT_IMPORT_HEADERS.every((h) => cellText(cell(excelRow, h)) === '')) return; // 空行
      // 非数据行：合计行（项目名称为「合计」），以及重复表头的说明行（项目名称与表头同名）。
      // 不按固定行号跳过，这样「第 2 行合计」和「第 2 行说明 + 第 3 行合计」两种 Excel 结构都能导入。
      const rowName = cellText(cell(excelRow, '项目名称')).replace(/\s+/g, '');
      if (rowName === '合计' || rowName === '项目名称') return;
      total += 1;
      try {
        const contractNo = cellText(cell(excelRow, '合同编号'));
        if (contractNo.length > 50) throw new Error('合同编号不能超过 50 个字符'); // 合同编号可为空、可重复
        const name = cellText(cell(excelRow, '项目名称'));
        if (!name) throw new Error('项目名称不能为空');
        if (name.length > 100) throw new Error('项目名称不能超过 100 个字符');
        const dupRow = seen.get(name);
        if (dupRow !== undefined) throw new Error(`项目名称「${name}」与第 ${dupRow} 行重复`);
        const batchNo = parseBatchNo(cell(excelRow, '批次'));
        const region = cellText(cell(excelRow, '区域'));
        if (region.length > 50) throw new Error('区域不能超过 50 个字符');

        rows.push({
          row: rowNumber,
          contractNo,
          batchNo,
          region,
          name,
          contractPrice: parseMoney(cell(excelRow, '合同价'), '合同价'),
          qxReceived: parseMoney(cell(excelRow, '企信实收'), '企信实收'),
          qxSubcontractFee: parseMoney(cell(excelRow, '企信支付下家分包费'), '企信支付下家分包费'),
          chenPei: parseMoney(cell(excelRow, '陈沛'), '陈沛'),
          qxProfit: parseMoney(cell(excelRow, '企信利润'), '企信利润'),
          qxMoneyReceived: parseYesNo(cell(excelRow, '项目结算')),
          paidSubcontractor: parseYesNo(cell(excelRow, '支付下家')),
          paidChenPei: parseYesNo(cell(excelRow, '支付陈沛'))
        });
        seen.set(name, rowNumber);
      } catch (e) {
        errors.push({ row: rowNumber, message: e instanceof Error ? e.message : String(e) });
      }
    });
    return { rows, errors, total };
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
                              qx_money_received,paid_subcontractor,paid_chen_pei,archived,created_at,updated_at,device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`
      );
      const update = this.db.prepare(
        `UPDATE project SET contract_id=?, contract_no=?, batch_no=?, region=?, contract_price=?, qx_received=?, qx_subcontract_fee=?, chen_pei=?,
                qx_profit=?, qx_money_received=?, paid_subcontractor=?, paid_chen_pei=?, updated_at=? WHERE id=?`
      );
      const currentRow = this.db.prepare('SELECT * FROM project WHERE id = ?');
      // Excel 里的合同编号 -> 合同 id：合同表里没有就自动创建（本批内同一编号只创建一次）
      const contractIds = new Map<string, string>();
      const findContract = this.db.prepare('SELECT id FROM contract WHERE contract_no = ? AND archived = 0');
      const insertContract = this.db.prepare(
        'INSERT INTO contract (id, contract_no, archived, created_at, updated_at, device_id) VALUES (?,?,0,?,?,?)'
      );
      const contractIdOf = (contractNo: string): string | null => {
        if (!contractNo) return null;
        const cached = contractIds.get(contractNo);
        if (cached) return cached;
        const hit = findContract.get(contractNo) as { id: string } | undefined;
        let id = hit?.id;
        if (!id) {
          id = newId();
          insertContract.run(id, contractNo, now, now, this.deviceId);
          writeAudit(this.db, this.deviceId, 'contract', id, 'import_create', { fileName, contractNo });
        }
        contractIds.set(contractNo, id);
        return id;
      };
      for (const r of rows) {
        const contractId = contractIdOf(r.contractNo);
        const hit = existing.get(r.name);
        if (hit) {
          // 已入账的字段保持库里的值（标记 + 金额），其余用 Excel 的值
          const cur = currentRow.get(hit.id) as ProjectRow;
          const keep = (kind: ProjectPostingKind) => hit.posted.includes(kind);
          const money = [
            r.contractPrice,
            keep('qx_received') ? cur.qx_received : r.qxReceived,
            keep('paid_subcontractor') ? cur.qx_subcontract_fee : r.qxSubcontractFee,
            keep('paid_chen_pei') ? cur.chen_pei : r.chenPei,
            r.qxProfit
          ] as const;
          const flags = [
            keep('qx_received') ? 1 : r.qxMoneyReceived ? 1 : 0,
            keep('paid_subcontractor') ? 1 : r.paidSubcontractor ? 1 : 0,
            keep('paid_chen_pei') ? 1 : r.paidChenPei ? 1 : 0
          ] as const;
          update.run(contractId, r.contractNo, r.batchNo, r.region, ...money, ...flags, now, hit.id);
          writeAudit(this.db, this.deviceId, 'project', hit.id, 'import_update', {
            fileName, name: r.name, contractNo: r.contractNo, keptPostedKinds: hit.posted
          });
          updated += 1;
          if (hit.posted.length > 0) skippedPosted += 1;
        } else {
          const id = newId();
          const money = [r.contractPrice, r.qxReceived, r.qxSubcontractFee, r.chenPei, r.qxProfit] as const;
          const flags = [r.qxMoneyReceived ? 1 : 0, r.paidSubcontractor ? 1 : 0, r.paidChenPei ? 1 : 0] as const;
          insert.run(id, contractId, r.contractNo, r.batchNo, r.region, r.name, ...money, ...flags, now, now, this.deviceId);
          writeAudit(this.db, this.deviceId, 'project', id, 'import_create', { fileName, name: r.name, contractNo: r.contractNo });
          created += 1;
        }
      }
    })();
    return { total, created, updated, skippedPosted };
  }
}