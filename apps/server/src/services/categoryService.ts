import type { Category } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

interface CategoryRow {
  id: string;
  name: string;
  kind: 'income' | 'expense';
  parent_id: string | null;
  builtin: number;
  usage?: number;
}

const toCategory = (r: CategoryRow): Category => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  parentId: r.parent_id,
  builtin: r.builtin === 1,
  ...(r.usage !== undefined ? { usageCount: r.usage } : {})
});

/** 内置收入分类「项目收入」：未结算项目归入合同（结算）入账时使用 */
export const PROJECT_INCOME_CATEGORY_NAME = '项目收入';

/**
 * 默认分类（均为内置，不可编辑/删除），其余由用户自行新增。
 * 数组顺序即展示顺序（写入 sort_order，从 1 起）；兜底分类「其他收入/其他支出」固定放在各自内置分类的最后。
 * 与迁移 v19 的 sort_order 保持一致。
 */
const DEFAULT_CATEGORIES: Array<{ kind: 'income' | 'expense'; names: string[] }> = [
  { kind: 'income', names: [PROJECT_INCOME_CATEGORY_NAME, '其他收入'] },
  {
    kind: 'expense',
    names: ['工资薪酬', '社保', '差旅费', '房租水电', '经营费', '员工报销', '企信支付下家分包费', '企信支付陈沛', '车辆', '其他支出']
  }
];

/** 删除自定义分类时，已使用它的流水改挂到该类型的兜底分类 */
export const FALLBACK_CATEGORY_NAME: Record<'income' | 'expense', string> = {
  income: '其他收入',
  expense: '其他支出'
};

const COLUMNS = 'id,name,kind,parent_id,builtin';

export class CategoryService {
  constructor(
    private readonly db: Db,
    private readonly deviceId = 'local'
  ) {}

  /** 首次启动时写入默认分类 */
  seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM category').get() as { c: number }).c;
    if (count > 0) return;
    const insert = this.db.prepare(
      'INSERT INTO category (id,name,kind,parent_id,created_at,builtin,sort_order) VALUES (?,?,?,NULL,?,?,?)'
    );
    this.db.transaction(() => {
      for (const group of DEFAULT_CATEGORIES) {
        group.names.forEach((name, i) => insert.run(newId(), name, group.kind, nowIso(), 1, i + 1));
      }
    })();
  }

  /** 列出可选分类（已归档的不返回） */
  list(): Category[] {
    return (
      this.db
        .prepare(
          `SELECT c.id,c.name,c.kind,c.parent_id,c.builtin,
                  (SELECT COUNT(*) FROM tx t WHERE t.category_id = c.id) AS usage
           FROM category c WHERE c.archived = 0 ORDER BY c.kind, c.builtin DESC, c.sort_order ASC, c.created_at DESC, c.rowid DESC`
        )
        .all() as CategoryRow[]
    ).map(toCategory);
  }

  create(input: { name: string; kind: 'income' | 'expense'; parentId?: string | null }): Category {
    const name = input.name.trim();
    this.assertNameFree(input.kind, name);
    const id = newId();
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO category (id,name,kind,parent_id,created_at) VALUES (?,?,?,?,?)')
        .run(id, name, input.kind, input.parentId ?? null, nowIso());
      writeAudit(this.db, this.deviceId, 'category', id, 'create', { name, kind: input.kind });
    })();
    return this.get(id);
  }

  /** 取一个可操作（未归档、非内置）的分类 */
  private getEditable(id: string, action: '编辑' | '删除'): Category {
    const row = this.db.prepare(`SELECT ${COLUMNS}, archived FROM category WHERE id = ?`).get(id) as
      | (CategoryRow & { archived: number })
      | undefined;
    if (!row || row.archived === 1) throw new AppError('分类不存在', 404, 'NOT_FOUND');
    if (row.builtin === 1) throw new AppError(`内置分类不可${action}`, 403, 'BUILTIN_READONLY');
    return toCategory(row);
  }

  /** 该分类被多少笔流水使用（含已作废，因为删除会一并改挂） */
  usageCount(id: string): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM tx WHERE category_id = ?').get(id) as { c: number }).c;
  }

  /**
   * 删除分类（归档式，不物理删除）：已使用该分类的流水改挂到同类型的内置兜底分类（收入=「其他收入」），
   * 然后把分类归档；写审计。返回被改挂的流水数。内置分类不可删除。
   */
  remove(id: string): { movedTransactions: number } {
    const cur = this.getEditable(id, '删除');
    const fallback = this.db
      .prepare('SELECT id FROM category WHERE kind = ? AND name = ? AND builtin = 1 AND archived = 0')
      .get(cur.kind, FALLBACK_CATEGORY_NAME[cur.kind]) as { id: string } | undefined;
    const used = this.usageCount(id);
    if (used > 0 && !fallback) throw new AppError('缺少兜底分类，无法删除已被使用的分类', 409, 'NO_FALLBACK');
    this.db.transaction(() => {
      if (used > 0) {
        this.db
          .prepare('UPDATE tx SET category_id = ?, updated_at = ?, version = version + 1 WHERE category_id = ?')
          .run(fallback!.id, nowIso(), id);
      }
      this.db.prepare('UPDATE category SET archived = 1 WHERE id = ?').run(id);
      writeAudit(this.db, this.deviceId, 'category', id, 'delete', {
        name: cur.name,
        movedTransactions: used,
        movedTo: used > 0 ? fallback!.id : null
      });
    })();
    return { movedTransactions: used };
  }

  /** 重命名分类；内置分类不可编辑 */
  update(id: string, input: { name: string }): Category {
    const cur = this.getEditable(id, '编辑');
    const name = input.name.trim();
    if (name !== cur.name) this.assertNameFree(cur.kind, name);
    this.db.transaction(() => {
      this.db.prepare('UPDATE category SET name = ? WHERE id = ?').run(name, id);
      writeAudit(this.db, this.deviceId, 'category', id, 'update', { from: cur.name, to: name });
    })();
    return this.get(id);
  }

  get(id: string): Category {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM category WHERE id = ?`).get(id) as CategoryRow | undefined;
    if (!row) throw new AppError('分类不存在', 404, 'NOT_FOUND');
    return toCategory(row);
  }

  findByName(kind: 'income' | 'expense', name: string): Category | undefined {
    const row = this.db
      .prepare(`SELECT ${COLUMNS} FROM category WHERE kind = ? AND name = ? AND archived = 0`)
      .get(kind, name) as CategoryRow | undefined;
    return row ? toCategory(row) : undefined;
  }

  private assertNameFree(kind: 'income' | 'expense', name: string): void {
    if (!name) throw new AppError('分类名称不能为空');
    const dup = this.db.prepare('SELECT archived FROM category WHERE kind = ? AND name = ?').get(kind, name) as
      | { archived: number }
      | undefined;
    if (dup) {
      throw new AppError(dup.archived ? `分类名称已被历史分类占用: ${name}，请换一个名称` : `分类已存在: ${name}`, 409, 'DUPLICATE');
    }
  }
}
