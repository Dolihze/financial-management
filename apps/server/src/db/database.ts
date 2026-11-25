import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations';

export type Db = Database.Database;

/**
 * 数据库与当前程序不匹配时后端进程的退出码（sysexits 的 EX_CONFIG）。
 * 修改时需同步 src-tauri/src/lib.rs 的 EXIT_INCOMPATIBLE_DB：Rust 侧据此在失败页显示明确提示。
 */
export const EXIT_INCOMPATIBLE_DB = 78;

/**
 * 数据库结构与当前程序不匹配（例如开发阶段迁移被压平后，磁盘上还留着按旧迁移建出来的库）。
 * 这种库不能直接使用：缺表缺列会让接口随机报 500。出现时拒绝启动并给出明确提示，绝不自动修改库里的数据、不建表、不删除库文件。
 * （注意：SQLite 打开带未合并 WAL 的库再关闭时，会自行把 WAL 合并回主文件，这属于 SQLite 的正常行为，不改变数据。）
 */
export class IncompatibleDatabaseError extends Error {
  constructor(
    message: string,
    /** 库里已记录的迁移版本（升序） */
    public readonly appliedVersions: number[],
    /** 当前程序已知的迁移版本（升序） */
    public readonly knownVersions: number[]
  ) {
    super(message);
    this.name = 'IncompatibleDatabaseError';
  }
}

/**
 * 检查库里的迁移记录是否都是当前程序认识的版本：出现程序里没有的版本号，说明这个库是按另一套（旧的）迁移建的，
 * 其表结构与当前代码对不上。全新的空库（没有 schema_migrations 表或表里没有记录）不受影响。
 */
export function assertCompatible(db: Db): void {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasTable) return;
  const applied = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map((r) => r.version);
  const known = migrations.map((m) => m.version).sort((a, b) => a - b);
  const unknown = applied.filter((v) => !known.includes(v));
  if (unknown.length === 0) return;
  throw new IncompatibleDatabaseError(
    `数据库结构版本（已记录 v${applied.join('、v')}）与当前程序（v${known.join('、v')}）不一致，` +
      `其中 v${unknown.join('、v')} 是当前程序不认识的版本。这通常是开发阶段迁移被调整后遗留的旧库`,
    applied,
    known
  );
}

/** 把 IncompatibleDatabaseError 展开成给用户看的完整提示（含库路径与处理步骤）；其他错误原样返回 */
export function describeDatabaseError(err: unknown, dbPath: string): string {
  if (!(err instanceof IncompatibleDatabaseError)) return err instanceof Error ? err.message : String(err);
  const stem = dbPath.replace(/\.db$/i, '');
  return [
    `无法使用数据库：${dbPath}`,
    err.message,
    '',
    '程序没有修改其中的数据。请按下面的步骤处理：',
    '  1. 如果里面有需要保留的数据，先关闭程序，把该文件（以及同名的 -wal、-shm 文件）复制到别处备份；',
    `  2. 删除或移走这个数据库（${dbPath} 及 ${stem}.db-wal、${stem}.db-shm），下次启动会自动按新结构重新创建；`,
    '  3. 演示库用 npm run seed -w @fm/server -- --reset 重新生成。'
  ].join('\n');
}

/** 打开数据库并执行迁移。库结构与当前程序不匹配时抛出 IncompatibleDatabaseError（不会改动库文件的内容） */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  try {
    // 先检查再设置 WAL / 迁移：不兼容的库一个字节都不写
    assertCompatible(db);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

export function runMigrations(db: Db): void {
  assertCompatible(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((r) => (r as { version: number }).version)
  );
  const insert = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    // 重建表需要在事务外关闭外键（事务内 PRAGMA foreign_keys 无效），完成后恢复并校验
    if (m.rebuildsTables) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(m.sql);
        if (m.rebuildsTables && (db.pragma('foreign_key_check') as unknown[]).length > 0) {
          throw new Error(`迁移 ${m.version} 后外键校验失败`);
        }
        insert.run(m.version, m.name, new Date().toISOString());
      })();
    } finally {
      if (m.rebuildsTables) db.pragma('foreign_keys = ON');
    }
  }
}
