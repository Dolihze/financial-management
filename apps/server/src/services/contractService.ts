import type { Contract, ContractDetail, CreateContractInput, UpdateContractInput } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

interface ContractRow {
  id: string;
  contract_no: string;
  created_at: string;
  updated_at: string;
}

/**
 * 合同管理。
 * - 合同总价不落库：= 其下项目「合同价」之和（整数分求和，不做浮点运算）。
 * - 新增合同：从「项目结算 = 否」且尚未归入任何合同的项目中挑选，并给每个项目设置合同价。
 * - 项目归入合同后：project.contract_id / contract_no 一并设置。
 *   不会修改「项目结算」：结算由项目详情里单独切换（切换会入账生成收入流水），这里不能悄悄改变账目。
 * - 删除合同：不物理删除，归档合同，并清空其下项目的合同归属（项目回到未结算）。
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
    return {
      id: row.id,
      contractNo: row.contract_no,
      totalPrice: agg.total,
      projectCount: agg.n,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  list(): Contract[] {
    const rows = this.db
      .prepare('SELECT id, contract_no, created_at, updated_at FROM contract WHERE archived = 0 ORDER BY created_at DESC, rowid DESC')
      .all() as ContractRow[];
    return rows.map((r) => this.summaryOf(r));
  }

  private row(id: string): ContractRow {
    const r = this.db
      .prepare('SELECT id, contract_no, created_at, updated_at FROM contract WHERE id = ? AND archived = 0')
      .get(id) as ContractRow | undefined;
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

  private assertNoDuplicateProjects(projects: Array<{ projectId: string }>): void {
    const seen = new Set<string>();
    for (const p of projects) {
      if (seen.has(p.projectId)) throw new AppError('同一个项目不能重复加入合同', 400, 'VALIDATION');
      seen.add(p.projectId);
    }
  }

  private assertContractNoFree(contractNo: string, exceptId?: string): void {
    const clash = this.db
      .prepare('SELECT 1 FROM contract WHERE contract_no = ? AND archived = 0 AND id <> ?')
      .get(contractNo, exceptId ?? '');
    if (clash) throw new AppError(`合同编号「${contractNo}」已存在`, 409, 'DUPLICATE_CONTRACT_NO');
  }

  /** 新增合同：挑选未结算项目并设置各自的合同价，整个过程一个事务 */
  create(input: CreateContractInput): ContractDetail {
    const contractNo = input.contractNo.trim();
    if (!contractNo) throw new AppError('合同编号不能为空', 400, 'VALIDATION');
    if (input.projects.length === 0) throw new AppError('请至少选择一个未结算项目加入合同', 400, 'VALIDATION');
    this.assertNoDuplicateProjects(input.projects);
    this.assertContractNoFree(contractNo);

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
        .prepare('INSERT INTO contract (id, contract_no, archived, created_at, updated_at, device_id) VALUES (?,?,0,?,?,?)')
        .run(id, contractNo, now, now, this.deviceId);
      const attach = this.db.prepare(
        'UPDATE project SET contract_id = ?, contract_no = ?, contract_price = ?, updated_at = ? WHERE id = ?'
      );
      for (const p of input.projects) attach.run(id, contractNo, p.contractPrice, now, p.projectId);
      writeAudit(this.db, this.deviceId, 'contract', id, 'create', { contractNo, projects: input.projects });
    })();
    return this.get(id);
  }

  /** 修改合同编号及其下项目的合同价（不在这里增减项目） */
  update(id: string, input: UpdateContractInput): ContractDetail {
    const current = this.get(id);
    const contractNo = input.contractNo.trim();
    if (!contractNo) throw new AppError('合同编号不能为空', 400, 'VALIDATION');
    this.assertNoDuplicateProjects(input.projects);
    this.assertContractNoFree(contractNo, id);

    const members = new Set(current.projects.map((p) => p.id));
    for (const p of input.projects) {
      if (!members.has(p.projectId)) throw new AppError('只能修改本合同已有项目的合同价', 400, 'VALIDATION');
    }

    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare('UPDATE contract SET contract_no = ?, updated_at = ? WHERE id = ?').run(contractNo, now, id);
      // 合同编号文本同步到其下全部项目
      this.db.prepare('UPDATE project SET contract_no = ?, updated_at = ? WHERE contract_id = ? AND archived = 0').run(contractNo, now, id);
      const setPrice = this.db.prepare('UPDATE project SET contract_price = ?, updated_at = ? WHERE id = ? AND contract_id = ?');
      for (const p of input.projects) setPrice.run(p.contractPrice, now, p.projectId, id);
      writeAudit(this.db, this.deviceId, 'contract', id, 'update', {
        before: { contractNo: current.contractNo, projects: current.projects.map((p) => ({ projectId: p.id, contractPrice: p.contractPrice })) },
        after: { contractNo, projects: input.projects }
      });
    })();
    return this.get(id);
  }

  /** 「删除」合同：归档合同并清空其下项目的合同归属（项目回到未结算）；项目本身与其流水都保留 */
  archive(id: string): Contract {
    const current = this.get(id);
    const now = nowIso();
    this.db.transaction(() => {
      this.db.prepare("UPDATE project SET contract_id = NULL, contract_no = '', updated_at = ? WHERE contract_id = ? AND archived = 0").run(now, id);
      this.db.prepare('UPDATE contract SET archived = 1, updated_at = ? WHERE id = ?').run(now, id);
      writeAudit(this.db, this.deviceId, 'contract', id, 'archive', {
        contractNo: current.contractNo,
        releasedProjects: current.projects.map((p) => ({ projectId: p.id, name: p.name }))
      });
    })();
    return current;
  }
}
