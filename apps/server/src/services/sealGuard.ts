import type { Db } from '../db/database';
import { AppError } from '../utils';

/**
 * 存档写保护：批次存档（batch.sealed_at 有值）后整批只读。
 * 独立成纯函数模块（只依赖 db），供批次/合同/项目/附件各服务共用，避免服务之间互相依赖。
 * 批次/合同/项目不存在时都不报错，交给调用方自己的存在性校验（返回 404）。
 */

const UNBATCHED_NO = 0;

/** 批次已存档则拒绝（409 BATCH_SEALED） */
export function assertBatchWritable(db: Db, batchId: string | null | undefined): void {
  if (!batchId) return;
  const row = db.prepare('SELECT batch_no, sealed_at FROM batch WHERE id = ? AND archived = 0').get(batchId) as
    | { batch_no: number; sealed_at: string | null }
    | undefined;
  if (row?.sealed_at) {
    const title = row.batch_no === UNBATCHED_NO ? '未分批' : `第 ${row.batch_no} 批`;
    throw new AppError(`「${title}」已存档，是只读的。请先在「存档」页取消存档后再修改`, 409, 'BATCH_SEALED');
  }
}

/** 合同所在批次已存档则拒绝 */
export function assertContractWritable(db: Db, contractId: string | null | undefined): void {
  if (!contractId) return;
  const row = db.prepare('SELECT batch_id FROM contract WHERE id = ? AND archived = 0').get(contractId) as { batch_id: string } | undefined;
  if (row) assertBatchWritable(db, row.batch_id);
}

/** 项目所在合同所属批次已存档则拒绝（未归入合同的项目不属于任何批次，不受限） */
export function assertProjectWritable(db: Db, projectId: string): void {
  const row = db.prepare('SELECT contract_id FROM project WHERE id = ? AND archived = 0').get(projectId) as
    | { contract_id: string | null }
    | undefined;
  if (row) assertContractWritable(db, row.contract_id);
}
