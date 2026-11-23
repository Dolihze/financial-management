import type { UnsettledProject, UnsettledProjectInput } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

interface Row {
  id: string;
  region: string;
  name: string;
  contract_price: number;
  qx_received: number;
  qx_subcontract_fee: number;
  chen_pei: number;
  qx_profit: number;
  created_at: string;
  updated_at: string;
}

const SELECT = `SELECT id, region, name, contract_price, qx_received, qx_subcontract_fee, chen_pei, qx_profit, created_at, updated_at
                FROM unsettled_project`;

const toModel = (r: Row): UnsettledProject => ({
  id: r.id,
  region: r.region,
  name: r.name,
  contractPrice: r.contract_price,
  qxReceived: r.qx_received,
  qxSubcontractFee: r.qx_subcontract_fee,
  chenPei: r.chen_pei,
  qxProfit: r.qx_profit,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

const snapshot = (p: UnsettledProject | UnsettledProjectInput) => ({
  region: p.region,
  name: p.name,
  contractPrice: p.contractPrice,
  qxReceived: p.qxReceived,
  qxSubcontractFee: p.qxSubcontractFee,
  chenPei: p.chenPei,
  qxProfit: p.qxProfit
});

/**
 * 未结算项目总表。
 * - 与已结算项目（project 表）独立；金额均为整数分。
 * - 「删除」= 归档，不物理删除；所有写操作同时写审计。
 */
export class UnsettledProjectService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {}

  list(): UnsettledProject[] {
    // 按创建时间正序：先录入的在前，序号即录入顺序；rowid 兜底保证同一毫秒内顺序稳定
    const rows = this.db.prepare(`${SELECT} WHERE archived = 0 ORDER BY created_at ASC, rowid ASC`).all() as Row[];
    return rows.map(toModel);
  }

  /** 可选区域：已结算项目与未结算项目里出现过的非空区域，去重并排序，供下拉选择 */
  regions(): string[] {
    const rows = this.db
      .prepare(
        `SELECT region FROM project WHERE archived = 0 AND region <> ''
         UNION
         SELECT region FROM unsettled_project WHERE archived = 0 AND region <> ''
         ORDER BY region`
      )
      .all() as Array<{ region: string }>;
    return rows.map((r) => r.region);
  }

  get(id: string): UnsettledProject {
    const row = this.db.prepare(`${SELECT} WHERE id = ? AND archived = 0`).get(id) as Row | undefined;
    if (!row) throw new AppError('未结算项目不存在', 404, 'NOT_FOUND');
    return toModel(row);
  }

  private normalize(input: UnsettledProjectInput): UnsettledProjectInput {
    const name = input.name.trim();
    if (!name) throw new AppError('项目名称不能为空', 400, 'VALIDATION');
    return { ...input, region: input.region.trim(), name };
  }

  create(raw: UnsettledProjectInput): UnsettledProject {
    const input = this.normalize(raw);
    const id = newId();
    const now = nowIso();
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO unsettled_project
             (id, region, name, contract_price, qx_received, qx_subcontract_fee, chen_pei, qx_profit, archived, created_at, updated_at, device_id)
           VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`
        )
        .run(id, input.region, input.name, input.contractPrice, input.qxReceived, input.qxSubcontractFee, input.chenPei, input.qxProfit, now, now, this.deviceId);
      writeAudit(this.db, this.deviceId, 'unsettled_project', id, 'create', snapshot(input));
    })();
    return this.get(id);
  }

  update(id: string, raw: UnsettledProjectInput): UnsettledProject {
    const cur = this.get(id);
    const input = this.normalize(raw);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE unsettled_project
              SET region = ?, name = ?, contract_price = ?, qx_received = ?, qx_subcontract_fee = ?, chen_pei = ?, qx_profit = ?, updated_at = ?
            WHERE id = ?`
        )
        .run(input.region, input.name, input.contractPrice, input.qxReceived, input.qxSubcontractFee, input.chenPei, input.qxProfit, nowIso(), id);
      writeAudit(this.db, this.deviceId, 'unsettled_project', id, 'update', { before: snapshot(cur), after: snapshot(input) });
    })();
    return this.get(id);
  }

  /** 「删除」= 归档 */
  remove(id: string): UnsettledProject {
    const cur = this.get(id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE unsettled_project SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
      writeAudit(this.db, this.deviceId, 'unsettled_project', id, 'archive', snapshot(cur));
    })();
    return cur;
  }
}
