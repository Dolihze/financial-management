import ExcelJS from 'exceljs';
import {
  PROJECT_IMPORT_HEADERS,
  toCents,
  type ImportRowError,
  type Project,
  type ProjectImportPreview,
  type ProjectImportResult
} from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

interface ProjectRow {
  id: string;
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

const toProject = (r: ProjectRow): Project => ({
  id: r.id,
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
  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {}

  list(): Project[] {
    const rows = this.db
      .prepare('SELECT * FROM project WHERE archived = 0 ORDER BY created_at DESC, rowid DESC')
      .all() as ProjectRow[];
    return rows.map(toProject);
  }

  get(id: string): Project {
    const row = this.db.prepare('SELECT * FROM project WHERE id = ? AND archived = 0').get(id) as ProjectRow | undefined;
    if (!row) throw new AppError('项目不存在', 404, 'NOT_FOUND');
    return toProject(row);
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
          qxMoneyReceived: parseYesNo(cell(excelRow, '企信是否收到钱')),
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

  /** 库中已存在（未归档）的项目名称 */
  private existingNames(names: string[]): Set<string> {
    const found = new Set<string>();
    const stmt = this.db.prepare('SELECT 1 FROM project WHERE name = ? AND archived = 0');
    for (const n of names) if (stmt.get(n)) found.add(n);
    return found;
  }

  /** 预览：不写库 */
  async preview(buffer: Buffer): Promise<ProjectImportPreview> {
    const { rows, errors, total } = await this.parse(buffer);
    const existing = this.existingNames(rows.map((r) => r.name));
    return { total, toCreate: rows.length - existing.size, toUpdate: existing.size, errors };
  }

  /** 确认导入：整批一个事务；有错误行时拒绝导入。以项目名称匹配：已存在则更新，否则新增。 */
  async commit(buffer: Buffer, fileName: string): Promise<ProjectImportResult> {
    const { rows, errors, total } = await this.parse(buffer);
    if (errors.length > 0) throw new AppError(`存在 ${errors.length} 行错误，请修正后重新导入`, 422, 'IMPORT_INVALID');

    let created = 0;
    let updated = 0;
    const now = nowIso();
    this.db.transaction(() => {
      const find = this.db.prepare('SELECT id FROM project WHERE name = ? AND archived = 0');
      const insert = this.db.prepare(
        `INSERT INTO project (id,contract_no,batch_no,region,name,contract_price,qx_received,qx_subcontract_fee,chen_pei,qx_profit,
                              qx_money_received,paid_subcontractor,paid_chen_pei,archived,created_at,updated_at,device_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?)`
      );
      const update = this.db.prepare(
        `UPDATE project SET contract_no=?, batch_no=?, region=?, contract_price=?, qx_received=?, qx_subcontract_fee=?, chen_pei=?,
                qx_profit=?, qx_money_received=?, paid_subcontractor=?, paid_chen_pei=?, updated_at=? WHERE id=?`
      );
      for (const r of rows) {
        // 金额列均为整数分；是/否存 0/1
        const money = [r.contractPrice, r.qxReceived, r.qxSubcontractFee, r.chenPei, r.qxProfit] as const;
        const flags = [r.qxMoneyReceived ? 1 : 0, r.paidSubcontractor ? 1 : 0, r.paidChenPei ? 1 : 0] as const;
        const hit = find.get(r.name) as { id: string } | undefined;
        if (hit) {
          update.run(r.contractNo, r.batchNo, r.region, ...money, ...flags, now, hit.id);
          writeAudit(this.db, this.deviceId, 'project', hit.id, 'import_update', { fileName, name: r.name, contractNo: r.contractNo });
          updated += 1;
        } else {
          const id = newId();
          insert.run(id, r.contractNo, r.batchNo, r.region, r.name, ...money, ...flags, now, now, this.deviceId);
          writeAudit(this.db, this.deviceId, 'project', id, 'import_create', { fileName, name: r.name, contractNo: r.contractNo });
          created += 1;
        }
      }
    })();
    return { total, created, updated };
  }
}
