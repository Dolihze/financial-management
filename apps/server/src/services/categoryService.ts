import type { Category } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';

interface CategoryRow {
  id: string;
  name: string;
  kind: 'income' | 'expense';
  parent_id: string | null;
}

const toCategory = (r: CategoryRow): Category => ({ id: r.id, name: r.name, kind: r.kind, parentId: r.parent_id });

const DEFAULT_CATEGORIES: Array<{ kind: 'income' | 'expense'; names: string[] }> = [
  { kind: 'income', names: ['主营业务收入', '其他业务收入', '利息收入', '其他收入'] },
  { kind: 'expense', names: ['采购成本', '工资薪酬', '房租水电', '差旅费', '办公费', '营销推广', '税费', '其他支出'] }
];

export class CategoryService {
  constructor(private readonly db: Db) {}

  /** 首次启动时写入默认分类 */
  seedDefaults(): void {
    const count = (this.db.prepare('SELECT COUNT(*) AS c FROM category').get() as { c: number }).c;
    if (count > 0) return;
    const insert = this.db.prepare('INSERT INTO category (id,name,kind,parent_id,created_at) VALUES (?,?,?,NULL,?)');
    this.db.transaction(() => {
      for (const group of DEFAULT_CATEGORIES) {
        for (const name of group.names) insert.run(newId(), name, group.kind, nowIso());
      }
    })();
  }

  list(): Category[] {
    return (this.db.prepare('SELECT id,name,kind,parent_id FROM category ORDER BY kind, name').all() as CategoryRow[]).map(
      toCategory
    );
  }

  create(input: { name: string; kind: 'income' | 'expense'; parentId?: string | null }): Category {
    const dup = this.db.prepare('SELECT 1 FROM category WHERE kind = ? AND name = ?').get(input.kind, input.name);
    if (dup) throw new AppError(`分类已存在: ${input.name}`, 409, 'DUPLICATE');
    const id = newId();
    this.db
      .prepare('INSERT INTO category (id,name,kind,parent_id,created_at) VALUES (?,?,?,?,?)')
      .run(id, input.name, input.kind, input.parentId ?? null, nowIso());
    return { id, name: input.name, kind: input.kind, parentId: input.parentId ?? null };
  }

  findByName(kind: 'income' | 'expense', name: string): Category | undefined {
    const row = this.db.prepare('SELECT id,name,kind,parent_id FROM category WHERE kind = ? AND name = ?').get(kind, name) as
      | CategoryRow
      | undefined;
    return row ? toCategory(row) : undefined;
  }
}
