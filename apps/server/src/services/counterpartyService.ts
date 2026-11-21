import type { Counterparty } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

interface Row {
  id: string;
  name: string;
  usage?: number;
}

const toCounterparty = (r: Row): Counterparty => ({
  id: r.id,
  name: r.name,
  ...(r.usage !== undefined ? { usageCount: r.usage } : {})
});

/**
 * 往来单位主数据。
 * - tx.counterparty_id 关联主数据；tx.counterparty 保留为名称快照（用于搜索/展示/导入去重）。
 * - 重命名：同步更新关联流水的名称快照。
 * - 删除：归档式（不物理删除），关联流水的 counterparty_id 置空，但名称快照保留。
 */
export class CounterpartyService {
  constructor(
    private readonly db: Db,
    private readonly deviceId = 'local'
  ) {}

  list(): Counterparty[] {
    return (
      this.db
        .prepare(
          `SELECT c.id, c.name, (SELECT COUNT(*) FROM tx t WHERE t.counterparty_id = c.id) AS usage
           FROM counterparty c WHERE c.archived = 0 ORDER BY c.created_at, c.name`
        )
        .all() as Row[]
    ).map(toCounterparty);
  }

  get(id: string): Counterparty {
    const row = this.db.prepare('SELECT id, name FROM counterparty WHERE id = ? AND archived = 0').get(id) as Row | undefined;
    if (!row) throw new AppError('往来单位不存在', 404, 'NOT_FOUND');
    return toCounterparty(row);
  }

  /** 按名称取可用的往来单位（导入用） */
  findByName(name: string): Counterparty | undefined {
    const row = this.db.prepare('SELECT id, name FROM counterparty WHERE name = ? AND archived = 0').get(name) as Row | undefined;
    return row ? toCounterparty(row) : undefined;
  }

  create(input: { name: string }): Counterparty {
    const name = input.name.trim();
    this.assertNameFree(name);
    const id = newId();
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO counterparty (id,name,created_at) VALUES (?,?,?)').run(id, name, nowIso());
      writeAudit(this.db, this.deviceId, 'counterparty', id, 'create', { name });
    })();
    return this.get(id);
  }

  update(id: string, input: { name: string }): Counterparty {
    const cur = this.get(id);
    const name = input.name.trim();
    if (name !== cur.name) this.assertNameFree(name);
    this.db.transaction(() => {
      this.db.prepare('UPDATE counterparty SET name = ? WHERE id = ?').run(name, id);
      this.db
        .prepare('UPDATE tx SET counterparty = ?, updated_at = ?, version = version + 1 WHERE counterparty_id = ?')
        .run(name, nowIso(), id);
      writeAudit(this.db, this.deviceId, 'counterparty', id, 'update', { from: cur.name, to: name });
    })();
    return this.get(id);
  }

  /** 归档式删除；返回被解除关联的流水数 */
  remove(id: string): { unlinkedTransactions: number } {
    const cur = this.get(id);
    let unlinked = 0;
    this.db.transaction(() => {
      unlinked = this.db
        .prepare('UPDATE tx SET counterparty_id = NULL, updated_at = ?, version = version + 1 WHERE counterparty_id = ?')
        .run(nowIso(), id).changes;
      this.db.prepare('UPDATE counterparty SET archived = 1 WHERE id = ?').run(id);
      writeAudit(this.db, this.deviceId, 'counterparty', id, 'delete', { name: cur.name, unlinkedTransactions: unlinked });
    })();
    return { unlinkedTransactions: unlinked };
  }

  private assertNameFree(name: string): void {
    if (!name) throw new AppError('往来单位名称不能为空');
    const dup = this.db.prepare('SELECT archived FROM counterparty WHERE name = ?').get(name) as { archived: number } | undefined;
    if (dup) {
      throw new AppError(
        dup.archived ? `名称已被历史往来单位占用: ${name}，请换一个名称` : `往来单位已存在: ${name}`,
        409,
        'DUPLICATE'
      );
    }
  }
}
