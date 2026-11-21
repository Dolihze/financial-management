import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { toCents, type CreateTransactionInput, type ImportBatch, type ImportPreviewResult, type ImportRowError } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';
import { CategoryService } from './categoryService';
import { CounterpartyService } from './counterpartyService';
import { makeFingerprint, TransactionService } from './transactionService';

/**
 * 导入模板列（第一行为表头）：
 * 日期 | 类型(收入/支出) | 金额 | 账户 | 分类 | 往来单位 | 备注
 * 借款/贷款请用界面手工录入。
 */
export const IMPORT_HEADERS = ['日期', '类型', '金额', '账户', '分类', '往来单位', '备注'] as const;

interface ParsedRow {
  row: number;
  input: CreateTransactionInput;
  /** Excel 中的往来单位名称；预览不写库，提交时再解析/自动创建主数据 */
  counterpartyName: string;
  fingerprint: string;
}

interface ParseOutcome {
  rows: ParsedRow[];
  errors: ImportRowError[];
  total: number;
}

function cellText(v: ExcelJS.CellValue): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result ?? '');
  }
  return String(v).trim();
}

function normalizeDate(v: ExcelJS.CellValue): string {
  if (v instanceof Date) {
    // exceljs 以 UTC 解析日期单元格，直接取 UTC 日期部分
    return v.toISOString().slice(0, 10);
  }
  const text = cellText(v).replace(/[./]/g, '-');
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(text);
  if (!m) throw new Error(`日期格式无法识别: ${text || '(空)'}`);
  return `${m[1]}-${m[2]!.padStart(2, '0')}-${m[3]!.padStart(2, '0')}`;
}

export class ImportService {
  private readonly txService: TransactionService;
  private readonly categories: CategoryService;
  private readonly counterparties: CounterpartyService;

  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {
    this.txService = new TransactionService(db, deviceId);
    this.categories = new CategoryService(db, deviceId);
    this.counterparties = new CounterpartyService(db, deviceId);
  }

  /** 生成导入模板 */
  async buildTemplate(): Promise<Buffer> {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('流水导入');
    ws.addRow([...IMPORT_HEADERS]);
    ws.addRow(['2026-01-15', '收入', 10000.5, '招商银行基本户', '其他收入', 'XX公司', '客户回款']);
    ws.addRow(['2026-01-16', '支出', 2300, '现金', '经营费', '京东', '办公用品采购']);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 16));
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

    const accountByName = new Map(
      (this.db.prepare('SELECT id,name FROM account WHERE archived = 0').all() as Array<{ id: string; name: string }>).map((a) => [
        a.name,
        a.id
      ])
    );

    const rows: ParsedRow[] = [];
    const errors: ImportRowError[] = [];
    let total = 0;

    ws.eachRow((excelRow, rowNumber) => {
      if (rowNumber === 1) return; // 表头
      const cells = IMPORT_HEADERS.map((_, i) => excelRow.getCell(i + 1).value);
      if (cells.every((c) => cellText(c) === '')) return; // 空行
      total += 1;
      try {
        const occurredOn = normalizeDate(cells[0] ?? null);
        const typeText = cellText(cells[1] ?? null);
        const type = typeText === '收入' ? 'income' : typeText === '支出' ? 'expense' : null;
        if (!type) throw new Error(`类型必须是「收入」或「支出」，当前: ${typeText || '(空)'}`);
        const amount = toCents(cellText(cells[2] ?? null));
        if (amount <= 0) throw new Error('金额必须大于 0');
        const accountName = cellText(cells[3] ?? null);
        const accountId = accountByName.get(accountName);
        if (!accountId) throw new Error(`账户不存在: ${accountName || '(空)'}，请先在系统中创建`);
        const categoryName = cellText(cells[4] ?? null);
        let categoryId: string | null = null;
        if (categoryName) {
          const cat = this.categories.findByName(type, categoryName);
          if (!cat) throw new Error(`分类不存在: ${categoryName}`);
          categoryId = cat.id;
        }
        const counterpartyName = cellText(cells[5] ?? null);
        if (counterpartyName.length > 100) throw new Error('往来单位名称不能超过 100 个字符');
        if (counterpartyName && !this.counterparties.findByName(counterpartyName)) {
          const archived = this.db.prepare('SELECT 1 FROM counterparty WHERE name = ?').get(counterpartyName);
          if (archived) throw new Error(`往来单位「${counterpartyName}」已被删除，名称不可复用，请换一个名称`);
        }
        const input: CreateTransactionInput = {
          occurredOn,
          type,
          amount,
          accountId,
          categoryId,
          note: cellText(cells[6] ?? null)
        };
        rows.push({
          row: rowNumber,
          input,
          counterpartyName,
          fingerprint: makeFingerprint({ occurredOn, type, amount, counterparty: counterpartyName, accountKey: accountId })
        });
      } catch (e) {
        errors.push({ row: rowNumber, message: e instanceof Error ? e.message : String(e) });
      }
    });
    return { rows, errors, total };
  }

  private existingFingerprints(fps: string[]): Set<string> {
    const found = new Set<string>();
    const stmt = this.db.prepare("SELECT 1 FROM tx WHERE fingerprint = ? AND status = 'normal' LIMIT 1");
    for (const fp of fps) if (stmt.get(fp)) found.add(fp);
    return found;
  }

  /** 预览：不写库，返回有效/重复/错误统计 */
  async preview(buffer: Buffer): Promise<ImportPreviewResult> {
    const { rows, errors, total } = await this.parse(buffer);
    const dupes = this.existingFingerprints(rows.map((r) => r.fingerprint));
    return { total, valid: rows.length - dupes.size, duplicates: dupes.size, errors };
  }

  /** 确认导入：整批在一个事务内，要么全成功要么全回滚。有错误行时拒绝导入。 */
  async commit(buffer: Buffer, fileName: string, opts: { skipDuplicates?: boolean } = {}): Promise<ImportBatch> {
    const { rows, errors, total } = await this.parse(buffer);
    if (errors.length > 0) throw new AppError(`存在 ${errors.length} 行错误，请修正后重新导入`, 422, 'IMPORT_INVALID');

    const fileHash = createHash('sha256').update(buffer).digest('hex');
    const sameFile = this.db
      .prepare("SELECT 1 FROM import_batch WHERE file_hash = ? AND status = 'committed'")
      .get(fileHash);
    if (sameFile) throw new AppError('该文件已导入过，如需重新导入请先撤销原批次', 409, 'FILE_ALREADY_IMPORTED');

    const dupes = this.existingFingerprints(rows.map((r) => r.fingerprint));
    if (dupes.size > 0 && !opts.skipDuplicates) {
      throw new AppError(`发现 ${dupes.size} 行与已有流水重复`, 409, 'IMPORT_DUPLICATES');
    }
    const toInsert = rows.filter((r) => !dupes.has(r.fingerprint));

    const batchId = newId();
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO import_batch (id,file_name,file_hash,row_count,imported_count,status,created_at) VALUES (?,?,?,?,?,?,?)'
        )
        .run(batchId, fileName, fileHash, total, toInsert.length, 'committed', nowIso());
      const cpIds = new Map<string, string>(); // 本批次内同名只创建一次
      for (const r of toInsert) {
        let counterpartyId: string | null = null;
        if (r.counterpartyName) {
          counterpartyId = cpIds.get(r.counterpartyName) ?? null;
          if (!counterpartyId) {
            counterpartyId = (this.counterparties.findByName(r.counterpartyName) ?? this.counterparties.create({ name: r.counterpartyName })).id;
            cpIds.set(r.counterpartyName, counterpartyId);
          }
        }
        this.txService.insertWithinTx({ ...r.input, counterpartyId }, { importBatchId: batchId, fingerprint: r.fingerprint });
      }
      writeAudit(this.db, this.deviceId, 'import_batch', batchId, 'commit', { fileName, imported: toInsert.length });
    })();
    return this.getBatch(batchId);
  }

  /** 撤销整批导入：批内所有交易作废（不物理删除） */
  revert(batchId: string): ImportBatch {
    const batch = this.getBatch(batchId);
    if (batch.status === 'reverted') throw new AppError('该批次已撤销', 409, 'ALREADY_REVERTED');
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE tx SET status='voided', updated_at=?, version=version+1 WHERE import_batch_id=? AND status='normal'")
        .run(nowIso(), batchId);
      this.db.prepare("UPDATE import_batch SET status='reverted' WHERE id=?").run(batchId);
      writeAudit(this.db, this.deviceId, 'import_batch', batchId, 'revert');
    })();
    return this.getBatch(batchId);
  }

  listBatches(): ImportBatch[] {
    const rows = this.db.prepare('SELECT * FROM import_batch ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map(this.toBatch);
  }

  getBatch(id: string): ImportBatch {
    const row = this.db.prepare('SELECT * FROM import_batch WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new AppError('导入批次不存在', 404, 'NOT_FOUND');
    return this.toBatch(row);
  }

  private toBatch = (r: Record<string, unknown>): ImportBatch => ({
    id: r.id as string,
    fileName: r.file_name as string,
    fileHash: r.file_hash as string,
    rowCount: r.row_count as number,
    importedCount: r.imported_count as number,
    status: r.status as 'committed' | 'reverted',
    createdAt: r.created_at as string
  });
}
