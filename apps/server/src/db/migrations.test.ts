import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './database';
import { migrations } from './migrations';

/** 把迁移应用到指定版本（含），用于构造「旧版本数据库」和单独验证某一版迁移 */
function migrateTo(db: Database.Database, version: number, from = 0): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const m of migrations.filter((x) => x.version > from && x.version <= version)) {
    if (m.rebuildsTables) db.pragma('foreign_keys = OFF');
    db.transaction(() => db.exec(m.sql))();
    db.pragma('foreign_keys = ON');
    db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 'x');
  }
}

describe('迁移 v2：转账 -> 借款/贷款', () => {
  it('历史转账拆为借款(流出)+贷款(流入)，账户余额不变，外键完好', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // 只应用 v1，造一笔旧转账（含作废转账）
    const v1 = migrations.find((m) => m.version === 1)!;
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    db.exec(v1.sql);
    db.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(v1.name, 'x');

    const now = '2026-01-01T00:00:00.000Z';
    db.prepare(`INSERT INTO account (id,name,type,opening_balance,created_at,updated_at,device_id) VALUES ('a1','A','bank',100000,?,?,'d')`).run(now, now);
    db.prepare(`INSERT INTO account (id,name,type,opening_balance,created_at,updated_at,device_id) VALUES ('a2','B','cash',0,?,?,'d')`).run(now, now);
    const insTx = db.prepare(
      `INSERT INTO tx (id,occurred_on,type,summary,note,status,created_at,updated_at,device_id) VALUES (?,?,?,?,?,?,?,?,'d')`
    );
    const insLine = db.prepare('INSERT INTO tx_line (id,tx_id,account_id,amount) VALUES (?,?,?,?)');
    insTx.run('t1', '2026-01-02', 'transfer', '取现', '', 'normal', now, now);
    insLine.run('l1', 't1', 'a1', -30000);
    insLine.run('l2', 't1', 'a2', 30000);
    insTx.run('t2', '2026-01-03', 'transfer', '作废的转账', '备注', 'voided', now, now);
    insLine.run('l3', 't2', 'a1', -500);
    insLine.run('l4', 't2', 'a2', 500);
    insTx.run('t3', '2026-01-04', 'income', '回款', '', 'normal', now, now);
    insLine.run('l5', 't3', 'a1', 10000);

    const balance = (id: string) =>
      (
        db
          .prepare(
            `SELECT a.opening_balance + COALESCE((SELECT SUM(l.amount) FROM tx_line l JOIN tx t ON t.id=l.tx_id AND t.status='normal' WHERE l.account_id=a.id),0) AS b FROM account a WHERE a.id=?`
          )
          .get(id) as { b: number }
      ).b;
    const before = { a1: balance('a1'), a2: balance('a2') };

    migrateTo(db, 2, 1);

    expect(balance('a1')).toBe(before.a1);
    expect(balance('a2')).toBe(before.a2);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);

    const types = db.prepare('SELECT id, type, status FROM tx ORDER BY id').all();
    expect(types).toEqual([
      { id: 't1', type: 'borrow', status: 'normal' },
      { id: 't1-in', type: 'loan', status: 'normal' },
      { id: 't2', type: 'borrow', status: 'voided' },
      { id: 't2-in', type: 'loan', status: 'voided' },
      { id: 't3', type: 'income', status: 'normal' }
    ]);
    // 每笔交易恰好一条分录
    const counts = db.prepare('SELECT COUNT(*) AS c FROM tx_line GROUP BY tx_id').all() as Array<{ c: number }>;
    expect(counts.every((x) => x.c === 1)).toBe(true);
    // 不再允许 transfer
    expect(() => insTx.run('t9', '2026-01-05', 'transfer', 'x', '', 'normal', now, now)).toThrow();
    db.close();
  });
});

describe('迁移 v3：收入分类合并到「其他收入」', () => {
  it('旧收入分类的流水改挂「其他收入」，旧分类归档保留，支出分类不变', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const m of migrations.filter((x) => x.version <= 2)) {
      if (m.rebuildsTables) db.pragma('foreign_keys = OFF');
      db.exec(m.sql);
      db.pragma('foreign_keys = ON');
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 'x');
    }
    const now = '2026-01-01T00:00:00.000Z';
    const insCat = db.prepare('INSERT INTO category (id,name,kind,created_at) VALUES (?,?,?,?)');
    insCat.run('c1', '主营业务收入', 'income', now);
    insCat.run('c2', '利息收入', 'income', now);
    insCat.run('c3', '其他收入', 'income', now);
    insCat.run('e1', '办公费', 'expense', now);
    db.prepare(`INSERT INTO account (id,name,type,created_at,updated_at,device_id) VALUES ('a1','A','bank',?,?,'d')`).run(now, now);
    const insTx = db.prepare(
      `INSERT INTO tx (id,occurred_on,type,summary,category_id,created_at,updated_at,device_id) VALUES (?,?,?,'',?,?,?,'d')`
    );
    insTx.run('t1', '2026-01-02', 'income', 'c1', now, now);
    insTx.run('t2', '2026-01-03', 'income', 'c2', now, now);
    insTx.run('t3', '2026-01-04', 'expense', 'e1', now, now);

    migrateTo(db, 3, 2);

    const cats = db.prepare('SELECT id, builtin, archived FROM category ORDER BY id').all();
    expect(cats).toEqual([
      { id: 'c1', builtin: 0, archived: 1 },
      { id: 'c2', builtin: 0, archived: 1 },
      { id: 'c3', builtin: 1, archived: 0 },
      { id: 'e1', builtin: 0, archived: 0 }
    ]);
    const cat = (id: string) => (db.prepare('SELECT category_id AS c FROM tx WHERE id = ?').get(id) as { c: string }).c;
    expect(cat('t1')).toBe('c3');
    expect(cat('t2')).toBe('c3');
    expect(cat('t3')).toBe('e1');
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='merge'").get()).toEqual({ n: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('老库没有「其他收入」时自动补建为内置分类', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const m of migrations.filter((x) => x.version <= 2)) {
      if (m.rebuildsTables) db.pragma('foreign_keys = OFF');
      db.exec(m.sql);
      db.pragma('foreign_keys = ON');
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 'x');
    }
    db.prepare(`INSERT INTO category (id,name,kind,created_at) VALUES ('c1','主营业务收入','income','x')`).run();
    migrateTo(db, 3, 2);
    const other = db.prepare("SELECT builtin, archived FROM category WHERE kind='income' AND name='其他收入'").all();
    expect(other).toEqual([{ builtin: 1, archived: 0 }]);
    db.close();
  });
});
describe('迁移 v4：往来单位主数据', () => {
  it('历史往来单位文本去重生成主数据并关联，空值不关联，文本快照保留', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    for (const m of migrations.filter((x) => x.version <= 3)) {
      if (m.rebuildsTables) db.pragma('foreign_keys = OFF');
      db.exec(m.sql);
      db.pragma('foreign_keys = ON');
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?, ?)').run(m.version, m.name, 'x');
    }
    const now = '2026-01-01T00:00:00.000Z';
    db.prepare(`INSERT INTO account (id,name,type,created_at,updated_at,device_id) VALUES ('a1','A','bank',?,?,'d')`).run(now, now);
    const ins = db.prepare(
      `INSERT INTO tx (id,occurred_on,type,summary,counterparty,created_at,updated_at,device_id) VALUES (?,?,'income','',?,?,?,'d')`
    );
    ins.run('t1', '2026-01-02', '杭州云岚', now, now);
    ins.run('t2', '2026-01-03', '杭州云岚', now, now);
    ins.run('t3', '2026-01-04', ' 深圳启明 ', now, now);
    ins.run('t4', '2026-01-05', '', now, now);

    migrateTo(db, 4, 3);

    expect(db.prepare('SELECT name FROM counterparty ORDER BY name').all()).toEqual([{ name: '杭州云岚' }, { name: '深圳启明' }]);
    const rows = db
      .prepare('SELECT t.id, t.counterparty AS snap, c.name AS linked FROM tx t LEFT JOIN counterparty c ON c.id = t.counterparty_id ORDER BY t.id')
      .all();
    expect(rows).toEqual([
      { id: 't1', snap: '杭州云岚', linked: '杭州云岚' },
      { id: 't2', snap: '杭州云岚', linked: '杭州云岚' },
      { id: 't3', snap: ' 深圳启明 ', linked: '深圳启明' },
      { id: 't4', snap: '', linked: null }
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });
});
describe('迁移 v5：支出分类收敛为 7 个内置默认项', () => {
  const DEFAULTS = ['工资薪酬', '社保', '差旅费', '房租水电', '经营费', '员工报销', '其他支出'];

  function setup() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    migrateTo(db, 4);
    return db;
  }

  it('旧支出分类归档、流水改挂「其他支出」；保留的默认项标记内置；缺失的默认项补建；收入分类不受影响', () => {
    const db = setup();
    const now = '2026-01-01T00:00:00.000Z';
    const insCat = db.prepare('INSERT INTO category (id,name,kind,created_at,builtin) VALUES (?,?,?,?,0)');
    for (const [id, name] of [
      ['e1', '采购成本'], ['e2', '工资薪酬'], ['e3', '房租水电'], ['e4', '差旅费'],
      ['e5', '办公费'], ['e6', '营销推广'], ['e7', '税费'], ['e8', '其他支出']
    ] as const) insCat.run(id, name, 'expense', now);
    insCat.run('i1', '其他收入', 'income', now);
    db.prepare(`INSERT INTO account (id,name,type,created_at,updated_at,device_id) VALUES ('a1','A','bank',?,?,'d')`).run(now, now);
    const insTx = db.prepare(
      `INSERT INTO tx (id,occurred_on,type,summary,category_id,created_at,updated_at,device_id) VALUES (?,?,'expense','',?,?,?,'d')`
    );
    insTx.run('t1', '2026-01-02', 'e1', now, now); // 采购成本 -> 其他支出
    insTx.run('t2', '2026-01-03', 'e5', now, now); // 办公费 -> 其他支出
    insTx.run('t3', '2026-01-04', 'e2', now, now); // 工资薪酬 保留

    migrateTo(db, 5, 4);

    const active = db.prepare("SELECT name, builtin FROM category WHERE kind='expense' AND archived=0 ORDER BY name").all() as Array<{ name: string; builtin: number }>;
    expect(active.map((c) => c.name).sort()).toEqual([...DEFAULTS].sort());
    expect(active.every((c) => c.builtin === 1)).toBe(true);
    const archived = db.prepare("SELECT name FROM category WHERE kind='expense' AND archived=1 ORDER BY name").all() as Array<{ name: string }>;
    expect(archived.map((c) => c.name).sort()).toEqual(['办公费', '采购成本', '税费', '营销推广'].sort());

    const catName = (id: string) =>
      (db.prepare('SELECT c.name AS n FROM tx t JOIN category c ON c.id = t.category_id WHERE t.id = ?').get(id) as { n: string }).n;
    expect(catName('t1')).toBe('其他支出');
    expect(catName('t2')).toBe('其他支出');
    expect(catName('t3')).toBe('工资薪酬');
    expect((db.prepare("SELECT category_id AS c FROM tx WHERE id='t3'").get() as { c: string }).c).toBe('e2'); // 复用原行，不新建
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action='merge' AND entity='category'").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT archived FROM category WHERE id='i1'").get()).toEqual({ archived: 0 }); // 收入不受影响
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('没有任何支出分类的库不创建默认项（由 seedDefaults 负责）', () => {
    const db = setup();
    migrateTo(db, 5, 4);
    expect(db.prepare("SELECT COUNT(*) AS n FROM category WHERE kind='expense'").get()).toEqual({ n: 0 });
    db.close();
  });

  it('runMigrations 可从空库一路迁移到最新版本', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    const latest = Math.max(...migrations.map((m) => m.version));
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: latest });
    db.close();
  });
});