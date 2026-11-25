import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from './database';
import { migrations } from './migrations';

const open = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
};
const columns = (db: Database.Database, table: string) => (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((c) => c.name);
const NOW = '2026-01-01T00:00:00Z';

describe('数据库初始 schema（迁移已压平为单个 v1）', () => {
  it('从空库一路迁移到最新版本，重复执行不报错，版本记录只有一条', () => {
    const db = open();
    const latest = Math.max(...migrations.map((m) => m.version));
    expect(db.prepare('SELECT MAX(version) AS v, COUNT(*) AS n FROM schema_migrations').get()).toEqual({ v: latest, n: migrations.length });
    runMigrations(db); // 幂等
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: migrations.length });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('建出全部业务表，且不含已废弃的 unsettled_project 表', () => {
    const db = open();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>).map((t) => t.name).sort();
    expect(tables).toEqual([
      'account', 'audit_log', 'batch', 'batch_attachment', 'category', 'contract', 'counterparty',
      'import_batch', 'project', 'project_posting', 'schema_migrations', 'tx', 'tx_attachment', 'tx_line'
    ]);
    db.close();
  });

  it('项目表：只有「上海院已支付」sh_paid，没有任何旧的结算 / 90% / 10% 列；sh_paid 默认否且只允许 0/1', () => {
    const db = open();
    const cols = columns(db, 'project');
    expect(cols).toEqual(expect.arrayContaining(['sh_paid', 'paid_subcontractor', 'paid_chen_pei', 'contract_id', 'batch_no', 'note', 'qx_received']));
    for (const gone of ['qx_money_received', 'sh_paid_90', 'sh_paid_rest_10', 'status', 'design_no', 'batch']) expect(cols).not.toContain(gone);

    db.prepare(`INSERT INTO project (id,contract_no,name,archived,created_at,updated_at,device_id) VALUES ('p1','','甲',0,?,?,'d')`).run(NOW, NOW);
    expect(db.prepare('SELECT sh_paid, paid_subcontractor, paid_chen_pei, contract_id, note FROM project').get()).toEqual({
      sh_paid: 0, paid_subcontractor: 0, paid_chen_pei: 0, contract_id: null, note: ''
    });
    for (const col of ['sh_paid', 'paid_subcontractor', 'paid_chen_pei']) {
      expect(() => db.prepare(`UPDATE project SET ${col} = 2 WHERE id = 'p1'`).run()).toThrow();
    }
    db.close();
  });

  it('项目名称仅在未归档项目中唯一；合同编号 / 批次号同样只在未归档记录中唯一', () => {
    const db = open();
    const ins = (id: string, name: string, archived: number) =>
      db.prepare(`INSERT INTO project (id,contract_no,name,archived,created_at,updated_at,device_id) VALUES (?,'',?,?,?,?,'d')`).run(id, name, archived, NOW, NOW);
    ins('p1', '甲', 0);
    expect(() => ins('p2', '甲', 0)).toThrow(/UNIQUE/);
    expect(() => ins('p3', '甲', 1)).not.toThrow(); // 已归档的不占名称

    const contract = (id: string, no: string, archived: number) =>
      db.prepare(`INSERT INTO contract (id,contract_no,archived,created_at,updated_at,device_id) VALUES (?,?,?,?,?,'d')`).run(id, no, archived, NOW, NOW);
    contract('c1', 'HT-1', 0);
    expect(() => contract('c2', 'HT-1', 0)).toThrow(/UNIQUE/);
    expect(() => contract('c3', 'HT-1', 1)).not.toThrow();

    const batch = (id: string, no: number, archived: number) =>
      db.prepare(`INSERT INTO batch (id,batch_no,archived,created_at,updated_at,device_id) VALUES (?,?,?,?,?,'d')`).run(id, no, archived, NOW, NOW);
    batch('b1', 1, 0);
    expect(() => batch('b2', 1, 0)).toThrow(/UNIQUE/);
    expect(() => batch('b3', 1, 1)).not.toThrow();
    db.close();
  });

  it('入账关联：kind 只允许三种；同一项目同一类型只能有一条有效记录，回退后（active=0）可再入账；外键完好', () => {
    const db = open();
    db.prepare(`INSERT INTO project (id,contract_no,name,archived,created_at,updated_at,device_id) VALUES ('p1','','甲',0,?,?,'d')`).run(NOW, NOW);
    for (const id of ['t1', 't2']) {
      db.prepare(`INSERT INTO tx (id,occurred_on,type,summary,created_at,updated_at,device_id) VALUES (?,'2026-01-01','income','',?,?,'d')`).run(id, NOW, NOW);
    }
    const post = (id: string, txId: string, kind: string, active = 1) =>
      db.prepare('INSERT INTO project_posting (id,project_id,kind,tx_id,active,created_at) VALUES (?,?,?,?,?,?)').run(id, 'p1', kind, txId, active, NOW);
    post('pp1', 't1', 'qx_received');
    expect(() => post('pp2', 't2', 'qx_received')).toThrow(/UNIQUE/); // 同类型只能一条有效
    expect(() => post('pp3', 't2', 'bogus')).toThrow(); // kind 受限
    expect(() => post('pp4', 't2', 'qx_received', 0)).not.toThrow(); // 已回退的不占位
    expect(() => post('pp5', 't2', 'paid_chen_pei')).not.toThrow();
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('交易：类型只允许 income / expense / borrow / loan（没有 transfer），status 默认 normal；分录与附件关联到交易', () => {
    const db = open();
    const ins = (id: string, type: string) =>
      db.prepare(`INSERT INTO tx (id,occurred_on,type,summary,created_at,updated_at,device_id) VALUES (?,'2026-01-01',?,'',?,?,'d')`).run(id, type, NOW, NOW);
    for (const t of ['income', 'expense', 'borrow', 'loan']) expect(() => ins(`t-${t}`, t)).not.toThrow();
    expect(() => ins('t-x', 'transfer')).toThrow();
    expect(db.prepare("SELECT status FROM tx WHERE id = 't-income'").get()).toEqual({ status: 'normal' });
    expect(() => db.prepare(`INSERT INTO tx_line (id,tx_id,account_id,amount) VALUES ('l1','t-income','no-account',1)`).run()).toThrow(); // 外键
    expect(columns(db, 'tx_attachment')).toContain('deleted_at');
    expect(columns(db, 'batch_attachment')).toContain('deleted_at');
    expect(columns(db, 'tx')).toContain('counterparty_id');
    db.close();
  });

  it('分类与往来单位：分类名称按类型唯一、往来单位名称唯一；分类带 builtin / archived / sort_order', () => {
    const db = open();
    expect(columns(db, 'category')).toEqual(expect.arrayContaining(['builtin', 'archived', 'sort_order']));
    const cat = (id: string, name: string, kind: string) =>
      db.prepare('INSERT INTO category (id,name,kind,created_at) VALUES (?,?,?,?)').run(id, name, kind, NOW);
    cat('c1', '其他', 'income');
    expect(() => cat('c2', '其他', 'income')).toThrow(/UNIQUE/);
    expect(() => cat('c3', '其他', 'expense')).not.toThrow(); // 不同类型可重名
    expect(() => cat('c4', 'x', 'bogus')).toThrow();
    db.prepare('INSERT INTO counterparty (id,name,created_at) VALUES (?,?,?)').run('cp1', '甲公司', NOW);
    expect(() => db.prepare('INSERT INTO counterparty (id,name,created_at) VALUES (?,?,?)').run('cp2', '甲公司', NOW)).toThrow(/UNIQUE/);
    db.close();
  });
});
