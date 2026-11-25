import Database from 'better-sqlite3';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCompatible,
  describeDatabaseError,
  EXIT_INCOMPATIBLE_DB,
  IncompatibleDatabaseError,
  openDatabase,
  runMigrations
} from './database';
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

  it('批次：sealed_at 默认为空（= 正在结算中），可写入存档时间', () => {
    const db = open();
    expect(columns(db, 'batch')).toContain('sealed_at');
    db.prepare(`INSERT INTO batch (id,batch_no,created_at,updated_at,device_id) VALUES ('b1',1,?,?,'d')`).run(NOW, NOW);
    expect(db.prepare('SELECT sealed_at FROM batch').get()).toEqual({ sealed_at: null });
    db.prepare("UPDATE batch SET sealed_at = ? WHERE id = 'b1'").run(NOW);
    expect(db.prepare('SELECT sealed_at FROM batch').get()).toEqual({ sealed_at: NOW });
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

describe('已有数据库自动升级（以后改字段不需要删库重建）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('只有 v1 的库（含数据）打开后自动升级到最新版本：新增列带默认值，已有数据一条不丢，重复打开幂等', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-upgrade-'));
    dirs.push(dir);
    const path = join(dir, 'finance.db');

    // 用迁移里的 v1 建一个「用户现在本地的库」，并写入数据
    const v1 = migrations.find((m) => m.version === 1)!;
    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    old.pragma('foreign_keys = ON');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    old.exec(v1.sql);
    old.prepare('INSERT INTO schema_migrations VALUES (1, ?, ?)').run(v1.name, NOW);
    old.prepare(`INSERT INTO batch (id,batch_no,note,created_at,updated_at,device_id) VALUES ('b1',7,'批次备注',?,?,'d')`).run(NOW, NOW);
    old.prepare(`INSERT INTO contract (id,contract_no,batch_id,created_at,updated_at,device_id) VALUES ('c1','HT-OLD','b1',?,?,'d')`).run(NOW, NOW);
    expect(columns(old, 'contract')).not.toContain('note'); // 旧结构确实没有
    old.close();

    const db = openDatabase(path); // 不删库，直接打开
    expect(columns(db, 'contract')).toContain('note');
    expect(db.prepare("SELECT contract_no, note, batch_id FROM contract WHERE id = 'c1'").get()).toEqual({ contract_no: 'HT-OLD', note: '', batch_id: 'b1' });
    expect(db.prepare("SELECT batch_no, note FROM batch WHERE id = 'b1'").get()).toEqual({ batch_no: 7, note: '批次备注' }); // 其他数据不受影响
    expect((db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version)).toEqual(
      migrations.map((m) => m.version).sort((a, b) => a - b)
    );
    db.close();

    const again = openDatabase(path); // 再次打开：幂等，不重复升级
    expect(again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: migrations.length });
    again.close();
  });

  it('v2 -> v3：流水新增 sub_type，历史借款回填 lend、贷款回填 loan、收入/支出为 NULL，分录与其他数据不丢', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-upgrade-v3-'));
    dirs.push(dir);
    const path = join(dir, 'finance.db');

    const old = new Database(path);
    old.pragma('journal_mode = WAL');
    old.pragma('foreign_keys = ON');
    old.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    for (const m of migrations.filter((x) => x.version <= 2)) {
      old.exec(m.sql);
      old.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(m.version, m.name, NOW);
    }
    old.prepare(`INSERT INTO account (id,name,type,created_at,updated_at,device_id) VALUES ('a1','账户','bank',?,?,'d')`).run(NOW, NOW);
    const ins = (id: string, type: string, amount: number) => {
      old.prepare(`INSERT INTO tx (id,occurred_on,type,summary,created_at,updated_at,device_id) VALUES (?,'2026-01-01',?,'',?,?,'d')`).run(id, type, NOW, NOW);
      old.prepare('INSERT INTO tx_line (id,tx_id,account_id,amount) VALUES (?,?,?,?)').run(`l-${id}`, id, 'a1', amount);
    };
    ins('t-income', 'income', 100);
    ins('t-expense', 'expense', -50);
    ins('t-borrow', 'borrow', -30);
    ins('t-loan', 'loan', 200);
    expect(columns(old, 'tx')).not.toContain('sub_type');
    old.close();

    const db = openDatabase(path);
    expect(columns(db, 'tx')).toContain('sub_type');
    const subs = Object.fromEntries((db.prepare('SELECT id, sub_type FROM tx').all() as Array<{ id: string; sub_type: string | null }>).map((r) => [r.id, r.sub_type]));
    expect(subs).toEqual({ 't-income': null, 't-expense': null, 't-borrow': 'lend', 't-loan': 'loan' });
    expect(db.prepare('SELECT COUNT(*) AS n, SUM(amount) AS s FROM tx_line').get()).toEqual({ n: 4, s: 220 }); // 分录不变
    db.close();
  });

  it('新增迁移的约定：版本号从 1 开始连续递增，没有重复或跳号', () => {
    const versions = migrations.map((m) => m.version).sort((a, b) => a - b);
    expect(versions).toEqual(versions.map((_, i) => i + 1));
    expect(new Set(versions).size).toBe(versions.length);
  });
});

describe('旧结构数据库检测（开发阶段迁移压平后遗留的旧库）', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const tmpDb = () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-incompat-'));
    dirs.push(dir);
    return join(dir, 'finance.db');
  };
  /** 造一个「按旧迁移建出来」的库：schema_migrations 里有当前程序不认识的版本号，且结构是旧的（没有 batch 表） */
  const makeLegacyDb = (path: string, versions: number[]) => {
    const db = new Database(path);
    db.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    db.exec('CREATE TABLE account (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    db.prepare("INSERT INTO account (id, name) VALUES ('a1', '旧账户')").run();
    for (const v of versions) db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?,?,?)').run(v, `old_${v}`, NOW);
    db.close();
  };

  it('库里有当前程序不认识的迁移版本 -> 抛出 IncompatibleDatabaseError，信息里指出已记录与已知版本', () => {
    const path = tmpDb();
    makeLegacyDb(path, [1, 11, 12, 13]);
    let err: unknown;
    try {
      openDatabase(path).close();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(IncompatibleDatabaseError);
    const e = err as IncompatibleDatabaseError;
    expect(e.appliedVersions).toEqual([1, 11, 12, 13]);
    expect(e.knownVersions).toEqual(migrations.map((m) => m.version).sort((a, b) => a - b));
    expect(e.message).toContain('v1、v11、v12、v13');
    expect(e.message).toContain('v11、v12、v13 是当前程序不认识的版本');
  });

  it('拒绝时不动库：不新建任何表、不改旧数据与迁移记录，也没有被切成 WAL（非 WAL 库的文件字节完全不变）', () => {
    const path = tmpDb();
    makeLegacyDb(path, [1, 12]);
    const before = readFileSync(path);
    expect(() => openDatabase(path)).toThrow(IncompatibleDatabaseError);
    expect(readFileSync(path).equals(before)).toBe(true); // 没有 WAL 的库：一个字节都没改

    const db = new Database(path, { readonly: true });
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name).sort();
    expect(tables).toEqual(['account', 'schema_migrations']); // 没有补建 batch 等新表
    expect(db.prepare('SELECT name FROM account').all()).toEqual([{ name: '旧账户' }]); // 旧数据还在
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete'); // 没被设成 WAL
    db.close();
  });

  it('带未合并 WAL 的旧库（用户真实遇到的情形）：同样拒绝；数据、表结构、迁移记录完整保留（SQLite 自己合并 WAL 不算改数据）', () => {
    const path = tmpDb();
    const raw = new Database(path);
    raw.pragma('journal_mode = WAL');
    raw.pragma('wal_autocheckpoint = 0'); // 写入留在 -wal 里不合并
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    raw.exec('CREATE TABLE account (id TEXT PRIMARY KEY, name TEXT NOT NULL)');
    raw.prepare("INSERT INTO account VALUES ('a1', '旧账户')").run();
    for (const v of [1, 11, 12]) raw.prepare('INSERT INTO schema_migrations VALUES (?,?,?)').run(v, 'old', NOW);
    // 模拟程序没有正常关闭：把磁盘上的三个文件原样拷贝到新目录再打开
    const copyDir = mkdtempSync(join(tmpdir(), 'fm-incompat-wal-'));
    dirs.push(copyDir);
    for (const ext of ['', '-wal', '-shm']) copyFileSync(path + ext, join(copyDir, 'finance.db' + ext));
    raw.close();

    const copy = join(copyDir, 'finance.db');
    expect(() => openDatabase(copy)).toThrow(IncompatibleDatabaseError);

    const db = new Database(copy, { readonly: true });
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name).sort()).toEqual([
      'account', 'schema_migrations'
    ]);
    expect(db.prepare('SELECT name FROM account').all()).toEqual([{ name: '旧账户' }]);
    expect((db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version)).toEqual([1, 11, 12]);
    db.close();
  });

  it('正常的库不受影响：全新库、已是最新版本的库都能打开；重复打开幂等', () => {
    const path = tmpDb();
    openDatabase(path).close(); // 全新空库
    const db = openDatabase(path); // 再次打开
    expect(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()).toEqual({ n: migrations.length });
    db.close();
    expect(() => assertCompatible(new Database(':memory:'))).not.toThrow(); // 没有 schema_migrations 表
  });

  it('只有 schema_migrations 空表（上次建表后中断）也视为兼容，会补跑迁移', () => {
    const path = tmpDb();
    const raw = new Database(path);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
    raw.close();
    const db = openDatabase(path);
    expect(db.prepare('SELECT COUNT(*) AS n FROM batch').get()).toEqual({ n: 0 });
    db.close();
  });

  it('describeDatabaseError：给出库路径、「没有改动文件」的说明和备份 / 删除 / 重建步骤；其他错误原样返回', () => {
    const err = new IncompatibleDatabaseError('版本不一致', [1, 12], [1]);
    const text = describeDatabaseError(err, 'C:\\data\\finance.db');
    expect(text).toContain('C:\\data\\finance.db');
    expect(text).toContain('程序没有修改其中的数据');
    expect(text).toContain('备份');
    expect(text).toContain('finance.db-wal');
    expect(text).toContain('finance.db-shm');
    expect(text).toContain('--reset');
    expect(describeDatabaseError(new Error('别的错误'), 'x.db')).toBe('别的错误');
    expect(describeDatabaseError('字符串错误', 'x.db')).toBe('字符串错误');
  });

  it('退出码约定为 78（与 src-tauri/src/lib.rs 的 EXIT_INCOMPATIBLE_DB 一致）', () => {
    expect(EXIT_INCOMPATIBLE_DB).toBe(78);
    const rust = readFileSync(join(__dirname, '../../../desktop/src-tauri/src/lib.rs'), 'utf8');
    expect(rust).toMatch(/const EXIT_INCOMPATIBLE_DB: i32 = 78;/);
  });
});
