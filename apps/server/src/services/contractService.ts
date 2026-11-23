import type { Contract, ContractDetail, CreateContractInput, UpdateContractInput } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';
import { UNBATCHED_NO } from './batchService';

interface ContractRow {
  id: string;
  contract_no: string;
  batch_id: string;
  batch_no: number;
  created_at: string;
  updated_at: string;
}

const CONTRACT_SELECT = `SELECT c.id, c.contract_no, c.batch_id, b.batch_no, c.created_at, c.updated_at
  FROM contract c JOIN batch b ON b.id = c.batch_id`;

/**
 * 合同管理（项目管理第二层：批次 → 合同 → 项目）。
 * - 每个合同必须属于一个批次（batch_id）；项目的批次号（project.batch_no）随合同所属批次派生并同步维护。
 * - 合同总价不落库：= 其下项目「合同价」之和（整数分求和，不做浮点运算）。
 * - 新增合同：从「项目结算 = 否」且尚未归入任何合同的项目中挑选，并给每个项目设置合同价。
 * - 项目归入合同后：project.contract_id / contract_no / batch_no 一并设置。
 *   不会修改「项目结算」：结算由项目详情里单独切换（切换会入账生成收入流水），这里不能悄悄改变账目。
 * - 删除合同：不物理删除，归档合同，并清空其下项目的合同归属与批次号（项目回到未结算）。
 */
export class ContractService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {}

  private summaryOf(row: ContractRow): Contract {
    const agg = this.db
      .prepare('SELECT COALESCE(SUM(contract_price), 0) AS total, COUNT(*) AS n FROM project WHERE contract_id = ? AND archived = 0')
      .get(row.id) as { total: number; n: number };
    const regions = (
      this.db
        .prepare("SELECT DISTINCT region FROM project WHERE contract_id = ? AND archived = 0 AND region <> '' ORDER BY region")
        .all(row.id) as Array<{ region: string }>
    ).map((r) => r.region);
    return {
      id: row.id,
      batchId: row.batch_id,
      batchNo: row.batch_no,
      contractNo: row.contract_no,
      totalPrice: agg.total,
      projectCount: agg.n,
      regions,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /** 合同列表；传 batchId 时只返回该批次下的合同（批次必须存在） */
  list(batchId?: string): Contract[] {
    if (batchId !== undefined) this.assertBatchExists(batchId);
    const rows = (
      batchId === undefined
        ? this.db.prepare(`${CONTRACT_SELECT} WHERE c.archived = 0 ORDER BY c.created_at DESC, c.rowid DESC`).all()
        : this.db.prepare(`${CONTRACT_SELECT} WHERE c.archived = 0 AND c.batch_id = ? ORDER BY c.created_at DESC, c.rowid DESC`).all(batchId)
    ) as ContractRow[];
    return rows.map((r) => this.summaryOf(r));
  }

  private row(id: string): ContractRow {
    const r = this.db.prepare(`${CONTRACT_SELECT} WHERE c.id = ? AND c.archived = 0`).get(id) as ContractRow | undefined;
    if (!r) throw new AppError('合同不存在', 404, 'NOT_FOUND');
    return r;
  }

  get(id: string): ContractDetail {
    const row = this.row(id);
    const projects = this.db
      .prepare(
        `SELECT id, name, batch_no AS batchNo, region, contract_price AS contractPrice
         FROM project WHERE contract_id = ? AND archived = 0 ORDER BY created_at DESC, rowid DESC`
      )
      .all(id) as ContractDetail['projects'];
    return { ...this.summaryOf(row), projects };
  }

  private assertBatchExists(batchId: string): { id: string; batchNo: number } {
    const b = this.db.prepare('SELECT id, batch_no FROM batch WHERE id = ? AND archived = 0').get(batchId) as
      | { id: string; batch_no: number }
      | undefined;
    if (!b) throw new AppError('批次不存在', 404, 'NOT_FOUND');
    return { id: b.id, batchNo: b.batch_no };
  }

  /** 项目冗余的批次号：「未分批」兜底批次对应 NULL */
  private projectBatchNo(batchNo: number): number | null {
    return batchNo === UNBATCHED_NO ? null : batchNo;
  }

  private assertNoDuplicateProjects(projects: Array<{ projectId: string }>): void {
    const seen = new Set<string>();
    for (const p of projects) {
      if (seen.has(p.projectId)) throw new AppError('同一个项目不能重复加入合同', 400, 'VALIDATION');
      seen.add(p.projectId);
    }
  }

  /** 合同总价 = 各项目合同价（整数分）之和，不能超出安全整数范围 */
  private assertTotalInRange(projects: Array<{ contractPrice: number }>): void {
    let sum = 0;
    for (const p of projects) {
      sum += p.contractPrice;
      if (!Number.isSafeInteger(sum)) throw new AppError('合同总价超出允许范围', 400, 'VALIDATION');
    }
  }

  private assertContractNoFree(contractNo: string, exceptId?: string): void {
    const clash = this.db
      .prepare('SELECT 1 FROM contract WHERE contract_no = ? AND archived = 0 AND id <> ?')
      .get(contractNo, exceptId ?? '');
    if (clash) throw new AppError(`合同编号「${contractNo}」已存在`, 409, 'DUPLICATE_CONTRACT_NO');
  }

  /** 新增合同：归属某个批次，挑选未结算项目并设置各自的合同价，整个过程一个事务 */
  create(input: CreateContractInput): ContractDetail {
    const contractNo = input.contractNo.trim();
    if (!contractNo) throw new AppError('合同编号不能为空', 400, 'VALIDATION');
    if (input.projects.length === 0) throw new AppError('请至少选择一个未结算项目加入合同', 400, 'VALIDATION');
    this.assertNoDuplicateProjects(input.projects);
    this.assertTotalInRange(input.projects);
    this.assertContractNoFree(contractNo);
    const batch = this.assertBatchExists(input.batchId);

    const now = nowIso();
    const id = newId();
    this.db.transaction(() => {
      // 先校验所有项目都存在、未归档、尚未归入合同、且「项目结算」为否，再写库
      const find = this.db.prepare(
        'SELECT id, name, contract_id AS contractId, qx_money_received AS settled FROM project WHERE id = ? AND archived = 0'
      );
      for (const p of input.projects) {
        const hit = find.get(p.projectId) as { id: string; name: string; contractId: string | null; settled: number } | undefined;
        if (!hit) throw new AppError('所选项目不存在', 404, 'NOT_FOUND');
        if (hit.contractId) throw new AppError(`项目「${hit.name}」已归入其他合同`, 409, 'PROJECT_ALREADY_IN_CONTRACT');
        if (hit.settled === 1) throw new AppError(`项目「${hit.name}」已结算，只能从未结算的项目中选择`, 409, 'PROJECT_ALREADY_SETTLED');
      }
      this.db
        .prepare('INSERT INTO contract (id, contract_no, batch_id, archived, created_at, updated_at, device_id) VALUES (?,?,?,0,?,?,?)')
        .run(id, contractNo, batch.id, now, now, this.deviceId);
      const attach = this.db.prepare(
        'UPDATE project SET contract_id = ?, contract_no = ?, batch_no = ?, contract_price = ?, updated_at = ? WHERE id = ?'
      );
      const pb = this.projectBatchNo(batch.batchNo);
      for (const p of input.projects) attach.run(id, contractNo, pb, p.contractPrice, now, p.projectId);
      writeAudit(this.db, this.deviceId, 'contract', id, 'create', { contractNo, batchId: batch.id, batchNo: batch.batchNo, projects: input.projects });
    })();
    return this.get(id);
  }

  /**
   * 修改合同编号 / 所属批次及项目合同价；也可加入新项目。
   * - 本合同已有项目：只改合同价。
   * - 其他项目：必须存在、未归档、未归入任何合同、项目结算 = 否，才能加入本合同（与新增合同同一规则）。
   * - 指定了不同的 batchId：合同连同其下项目一起移到该批次。
   * - 不在这里移除项目。整个过程一个事务，任一校验失败都不落库。
   */
  update(id: string, input: UpdateContractInput): ContractDetail {
    const current = this.get(id);
    const contractNo = input.contractNo.trim();
    if (!contractNo) throw new AppError('合同编号不能为空', 400, 'VALIDATION');
    this.assertNoDuplicateProjects(input.projects);
    this.assertContractNoFree(contractNo, id);
    const batch = input.batchId === undefined ? { id: current.batchId, batchNo: current.batchNo } : this.assertBatchExists(input.batchId);

    const members = new Set(current.projects.map((p) => p.id));
    const existing = input.projects.filter((p) => members.has(p.projectId));
    const added = input.projects.filter((p) => !members.has(p.projectId));

    // 最终总价 = 请求里的价格 + 请求里未出现的已有项目的原价
    const sent = new Set(input.projects.map((p) => p.projectId));
    this.assertTotalInRange([...input.projects, ...current.projects.filter((p) => !sent.has(p.id))]);

    const now = nowIso();
    this.db.transaction(() => {
      // 待加入的项目：先全部校验再写库
      const find = this.db.prepare(
        'SELECT id, name, contract_id AS contractId, qx_money_received AS settled FROM project WHERE id = ? AND archived = 0'
      );
      for (const p of added) {
        const hit = find.get(p.projectId) as { id: string; name: string; contractId: string | null; settled: number } | undefined;
        if (!hit) throw new AppError('所选项目不存在', 404, 'NOT_FOUND');
        if (hit.contractId) throw new AppError(`项目「${hit.name}」已归入其他合同`, 409, 'PROJECT_ALREADY_IN_CONTRACT');
        if (hit.settled === 1) throw new AppError(`项目「${hit.name}」已结算，只能从未结算的项目中选择`, 409, 'PROJECT_ALREADY_SETTLED');
      }

      this.db.prepare('UPDATE contract SET contract_no = ?, batch_id = ?, updated_at = ? WHERE id = ?').run(contractNo, batch.id, now, id);
      const attach = this.db.prepare('UPDATE project SET contract_id = ?, contract_price = ?, updated_at = ? WHERE id = ?');
      for (const p of added) attach.run(id, p.contractPrice, now, p.projectId);
      // 合同编号文本、批次号同步到其下全部项目（含刚加入的）
      this.db
        .prepare('UPDATE project SET contract_no = ?, batch_no = ?, updated_at = ? WHERE contract_id = ? AND archived = 0')
        .run(contractNo, this.projectBatchNo(batch.batchNo), now, id);
      const setPrice = this.db.prepare('UPDATE project SET contract_price = ?, updated_at = ? WHERE id = ? AND contract_id = ?');
      for (const p of existing) setPrice.run(p.contractPrice, now, p.projectId, id);
      writeAudit(this.db, this.deviceId, 'contract', id, 'update', {
        before: {
          contractNo: current.contractNo,
          batchId: current.batchId,
          projects: current.projects.map((p) => ({ projectId: p.id, contractPrice: p.contractPrice }))
        },
        after: { contractNo, batchId: batch.id, projects: input.projects },
        addedProjects: added.map((p) => p.projectId)
      });
    })();
    return this.get(id);
  }

  /**
   * 「删除」合同 = 归档（不物理删除）。只有合同内部没有任何（未归档）项目时才允许删除：
   * 有项目时拒绝（409），避免一次删除悄悄把一批项目踢出合同；要删请先到合同里把项目删除。
   * 判断与写库在同一事务里，避免检查后又有项目被加入。
   */
  archive(id: string): Contract {
    const current = this.get(id);
    const now = nowIso();
    this.db.transaction(() => {
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM project WHERE contract_id = ? AND archived = 0').get(id) as { n: number }).n;
      if (n > 0) {
        throw new AppError(`合同「${current.contractNo}」下还有 ${n} 个项目，不能删除。请先删除或处理其下的项目`, 409, 'CONTRACT_HAS_PROJECTS');
      }
      this.db.prepare('UPDATE contract SET archived = 1, updated_at = ? WHERE id = ?').run(now, id);
      writeAudit(this.db, this.deviceId, 'contract', id, 'archive', { contractNo: current.contractNo, batchNo: current.batchNo });
    })();
    return current;
  }
}
