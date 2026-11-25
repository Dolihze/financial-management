import type { Batch, BatchAttachment, BatchInput } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { toBatchAttachment } from './attachmentService';
import { writeAudit } from './audit';
import { assertBatchWritable } from './sealGuard';

interface BatchRow {
  id: string;
  batch_no: number;
  note: string;
  sealed_at: string | null;
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
  sealedAt: r.sealed_at,
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
  SELECT b.id, b.batch_no, b.note, b.sealed_at, b.created_at, b.updated_at,
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

/** 项目三个流程字段：列名与展示名 */
const FLOW_FLAGS: Array<{ column: 'sh_paid' | 'paid_subcontractor' | 'paid_chen_pei'; label: string }> = [
  { column: 'sh_paid', label: '上海院已支付' },
  { column: 'paid_subcontractor', label: '支付下家' },
  { column: 'paid_chen_pei', label: '支付陈沛' }
];
/** 错误信息里最多列出的未走完项目数 */
const MAX_LISTED = 5;

/**
 * 批次管理（项目管理第一层：批次 → 合同 → 项目）。
 * - 批次号为正整数，在未归档批次中唯一；备注可空。
 * - 「删除」= 归档，不物理删除；只有批次下没有任何（未归档）合同时才能删除，避免合同失去归属。
 * - 0 号「未分批」兜底批次：不能改号、不能删除，但可以改备注。
 * - 存档（sealed_at 有值）：手动挑选批次进入存档，存档时再校验一次——批次下每个项目的
 *   「上海院已支付 / 支付下家 / 支付陈沛」都必须为是，否则整体拒绝。存档批次整批只读（批次、合同、项目、文件
 *   都不能再改，见 sealGuard.ts），要改必须先取消存档。空批次（没有项目）可以存档。
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

  /**
   * 批次列表。sealed 省略 = 全部；false = 正在结算中（未存档）；true = 存档。
   * 批次号倒序：最新的批次排在最前；0 号兜底批次天然排在最后。
   */
  list(sealed?: boolean): Batch[] {
    const cond = sealed === undefined ? '' : sealed ? ' AND b.sealed_at IS NOT NULL' : ' AND b.sealed_at IS NULL';
    const rows = this.db.prepare(`${SELECT_BATCH} WHERE b.archived = 0${cond} ORDER BY b.batch_no DESC`).all() as BatchRow[];
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
    assertBatchWritable(this.db, id);
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
    assertBatchWritable(this.db, id);
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

  /** 批次下还没走完流程的项目（上海院已支付 / 支付下家 / 支付陈沛 任一不为是） */
  private unfinishedOf(batchId: string): Array<{ name: string; contractNo: string; missing: string[] }> {
    const rows = this.db
      .prepare(
        `SELECT p.name, c.contract_no AS contractNo, p.sh_paid, p.paid_subcontractor, p.paid_chen_pei
         FROM project p JOIN contract c ON c.id = p.contract_id
         WHERE c.batch_id = ? AND c.archived = 0 AND p.archived = 0
           AND (p.sh_paid = 0 OR p.paid_subcontractor = 0 OR p.paid_chen_pei = 0)
         ORDER BY c.contract_no, p.created_at, p.rowid`
      )
      .all(batchId) as Array<{ name: string; contractNo: string; sh_paid: number; paid_subcontractor: number; paid_chen_pei: number }>;
    return rows.map((r) => ({
      name: r.name,
      contractNo: r.contractNo,
      missing: FLOW_FLAGS.filter((f) => r[f.column] !== 1).map((f) => f.label)
    }));
  }

  /**
   * 存档：手动挑选的若干批次。校验与写库在同一事务里，任一批次不满足（已存档 / 还有未走完流程的项目）整体拒绝，
   * 都不存档。空批次（没有任何项目）允许存档。返回存档后的批次。
   */
  seal(batchIds: string[]): Batch[] {
    const ids = [...new Set(batchIds)];
    if (ids.length === 0) throw new AppError('请至少选择一个批次', 400, 'VALIDATION');
    const now = nowIso();
    this.db.transaction(() => {
      const problems: string[] = [];
      const targets: Batch[] = [];
      for (const id of ids) {
        const b = this.get(id); // 不存在 -> 404
        const title = b.batchNo === UNBATCHED_NO ? '未分批' : `第 ${b.batchNo} 批`;
        if (b.sealedAt) {
          problems.push(`「${title}」已经是存档状态`);
          continue;
        }
        const unfinished = this.unfinishedOf(id);
        if (unfinished.length > 0) {
          const shown = unfinished
            .slice(0, MAX_LISTED)
            .map((u) => `「${u.name}」（合同 ${u.contractNo}，未完成：${u.missing.join('、')}）`)
            .join('；');
          const more = unfinished.length > MAX_LISTED ? ` 等共 ${unfinished.length} 个项目` : '';
          problems.push(`「${title}」下还有 ${unfinished.length} 个项目没有走完全部流程：${shown}${more}`);
          continue;
        }
        targets.push(b);
      }
      if (problems.length > 0) {
        throw new AppError(`不能存档：${problems.join('。')}。上海院已支付、支付下家、支付陈沛必须全部为「是」才能存档`, 409, 'BATCH_NOT_FINISHED');
      }
      const mark = this.db.prepare('UPDATE batch SET sealed_at = ?, updated_at = ? WHERE id = ?');
      for (const b of targets) {
        mark.run(now, now, b.id);
        writeAudit(this.db, this.deviceId, 'batch', b.id, 'seal', { batchNo: b.batchNo, projectCount: b.projectCount });
      }
    })();
    return ids.map((id) => this.get(id));
  }

  /** 取消存档：把批次放回「正在结算中」。只对已存档的批次有效 */
  unseal(batchId: string): Batch {
    const b = this.get(batchId);
    if (!b.sealedAt) throw new AppError('该批次不是存档状态', 409, 'BATCH_NOT_SEALED');
    this.db.transaction(() => {
      this.db.prepare('UPDATE batch SET sealed_at = NULL, updated_at = ? WHERE id = ?').run(nowIso(), batchId);
      writeAudit(this.db, this.deviceId, 'batch', batchId, 'unseal', { batchNo: b.batchNo });
    })();
    return this.get(batchId);
  }
}
