import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations } from './migrations';

export type Db = Database.Database;

/** 打开数据库并执行迁移 */
export function openDatabase(dbPath: string): Db {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function runMigrations(db: Db): void {
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
