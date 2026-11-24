import type { Batch, BatchAttachment, BatchInput } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { toBatchAttachment } from './attachmentService';
import { writeAudit } from './audit';

interface BatchRow {
  id: string;
  batch_no: number;
  note: string;
  created_at: string;
  updated_at: string;
  contract_count: number;
  project_count: number;
  total_price: number;
  qx_received: number;
  qx_profit: number;
}

/** 迁移产生的「未分批」兜底批次的批次号 */
export const UNBATCHED_NO = 0;
/** 批次号上限：防止误输入，且远小于安全整数 */
export const MAX_BATCH_NO = 100_000;

const toBatch = (r: BatchRow, attachments: BatchAttachment[] = []): Batch => ({
  id: r.id,
  batchNo: r.batch_no,
  note: r.note,
  attachments,
  contractCount: r.contract_count,
  projectCount: r.project_count,
  totalPrice: r.total_price,
  qxReceived: r.qx_received,
  qxProfit: r.qx_profit,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

/** 批次汇总用的 SELECT：金额都是整数分之和，不做浮点运算 */
const SELECT_BATCH = `
  SELECT b.id, b.batch_no, b.note, b.created_at, b.updated_at,
         (SELECT COUNT(*) FROM contract c WHERE c.batch_id = b.id AND c.archived = 0) AS contract_count,
         (SELECT COUNT(*) FROM project p JOIN contract c ON c.id = p.contract_id
            WHERE c.batch_id = b.id AND c.archived = 0 AND p.archived = 0) AS project_count,
         (SELECT COALESCE(SUM(p.contract_price), 0) FROM project p JOIN contract c ON c.id = p.contract_id
            WHERE c.batch_id = b.id AND c.archived = 0 AND p.archived = 0) AS total_price,
         (SELECT COALESCE(SUM(p.qx_received), 0) FROM project p JOIN contract c ON c.id = p.contract_id
            WHERE c.batch_id = b.id AND c.archived = 0 AND p.archived = 0) AS qx_received,
         (SELECT COALESCE(SUM(p.qx_profit), 0) FROM project p JOIN contract c ON c.id = p.contract_id
            WHERE c.batch_id = b.id AND c.archived = 0 AND p.archived = 0) AS qx_profit
  FROM batch b`;

/**
 * 批次管理（项目管理第一层：批次 → 合同 → 项目）。
 * - 批次号为正整数，在未归档批次中唯一；备注可空。
 * - 「删除」= 归档，不物理删除；只有批次下没有任何（未归档）合同时才能删除，避免合同失去归属。
 * - 迁移产生的 0 号「未分批」兜底批次只读：不能改号、不能删除，但可以改备注。
 */
export class BatchService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {}

  /** 一次性取多个批次的附件（按上传时间先后），避免 N+1 查询 */
  private attachmentsOf(ids: string[]): Map<string, BatchAttachment[]> {
    const map = new Map<string, BatchAttachment[]>();
    if (ids.length === 0) return map;
    const rows = this.db
      .prepare(`SELECT * FROM batch_attachment WHERE batch_id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL ORDER BY created_at, rowid`)
      .all(...ids) as Array<Parameters<typeof toBatchAttachment>[0]>;
    for (const a of rows) {
      const arr = map.get(a.batch_id) ?? [];
      arr.push(toBatchAttachment(a));
      map.set(a.batch_id, arr);
    }
    return map;
  }

  list(): Batch[] {
    // 批次号倒序：最新的批次排在最前；0 号兜底批次天然排在最后
    const rows = this.db.prepare(`${SELECT_BATCH} WHERE b.archived = 0 ORDER BY b.batch_no DESC`).all() as BatchRow[];
    const files = this.attachmentsOf(rows.map((r) => r.id));
    return rows.map((r) => toBatch(r, files.get(r.id) ?? []));
  }

  get(id: string): Batch {
    const row = this.db.prepare(`${SELECT_BATCH} WHERE b.id = ? AND b.archived = 0`).get(id) as BatchRow | undefined;
    if (!row) throw new AppError('批次不存在', 404, 'NOT_FOUND');
    return toBatch(row, this.attachmentsOf([id]).get(id) ?? []);
  }

  /** 按批次号取可用批次（导入用） */
  findByNo(batchNo: number): { id: string; batchNo: number } | undefined {
    const row = this.db.prepare('SELECT id, batch_no FROM batch WHERE batch_no = ? AND archived = 0').get(batchNo) as
      | { id: string; batch_no: number }
      | undefined;
    return row ? { id: row.id, batchNo: row.batch_no } : undefined;
  }

  private assertBatchNo(batchNo: number, exceptId?: string): void {
    if (!Number.isInteger(batchNo) || batchNo < 1 || batchNo > MAX_BATCH_NO) {
      throw new AppError(`批次号必须是 1 ~ ${MAX_BATCH_NO} 的整数`, 400, 'VALIDATION');
    }
    const clash = this.db.prepare('SELECT 1 FROM batch WHERE batch_no = ? AND archived = 0 AND id <> ?').get(batchNo, exceptId ?? '');
    if (clash) throw new AppError(`批次号「${batchNo}」已存在`, 409, 'DUPLICATE_BATCH_NO');
  }

  create(input: BatchInput): Batch {
    this.assertBatchNo(input.batchNo);
    const note = (input.note ?? '').trim();
    const id = newId();
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO batch (id, batch_no, note, archived, created_at, updated_at, device_id) VALUES (?,?,?,0,?,?,?)')
        .run(id, input.batchNo, note, now, now, this.deviceId);
      writeAudit(this.db, this.deviceId, 'batch', id, 'create', { batchNo: input.batchNo, note });
    })();
    return this.get(id);
  }

  /** 修改批次号/备注。批次号变化会同步到其下项目的冗余批次号 */
  update(id: string, input: BatchInput): Batch {
    const cur = this.get(id);
    const note = (input.note ?? '').trim();
    const renumber = input.batchNo !== cur.batchNo;
    if (cur.batchNo === UNBATCHED_NO) {
      if (renumber) throw new AppError('「未分批」批次不能修改批次号', 403, 'BUILTIN_BATCH');
    } else if (renumber) {
      this.assertBatchNo(input.batchNo, id);
    }
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare('UPDATE batch SET batch_no = ?, note = ?, updated_at = ? WHERE id = ?').run(input.batchNo, note, now, id);
      if (renumber) {
        this.db
          .prepare(
            `UPDATE project SET batch_no = ?, updated_at = ?
             WHERE archived = 0 AND contract_id IN (SELECT id FROM contract WHERE batch_id = ? AND archived = 0)`
          )
          .run(input.batchNo, now, id);
      }
      writeAudit(this.db, this.deviceId, 'batch', id, 'update', {
        before: { batchNo: cur.batchNo, note: cur.note },
        after: { batchNo: input.batchNo, note }
      });
    })();
    return this.get(id);
  }

  /** 「删除」批次 = 归档；批次下还有合同时拒绝（合同必须归属某个批次） */
  remove(id: string): Batch {
    const cur = this.get(id);
    if (cur.batchNo === UNBATCHED_NO) throw new AppError('「未分批」批次不能删除', 403, 'BUILTIN_BATCH');
    if (cur.contractCount > 0) {
      throw new AppError(`批次下还有 ${cur.contractCount} 个合同，请先把合同移到其他批次或删除后再删除批次`, 409, 'BATCH_HAS_CONTRACTS');
    }
    this.db.transaction(() => {
      this.db.prepare('UPDATE batch SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
      writeAudit(this.db, this.deviceId, 'batch', id, 'archive', { batchNo: cur.batchNo, note: cur.note });
    })();
    return cur;
  }
}
