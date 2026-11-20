/**
 * 数据库迁移：按 version 递增顺序执行，已执行的版本记录在 schema_migrations。
 * 约定：只追加新迁移，不修改已发布的迁移。
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      -- 账户：银行卡/现金/第三方支付/应收/应付...
      CREATE TABLE account (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        type            TEXT NOT NULL,
        currency        TEXT NOT NULL DEFAULT 'CNY',
        opening_balance INTEGER NOT NULL DEFAULT 0,   -- 整数分
        note            TEXT NOT NULL DEFAULT '',
        archived        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        device_id       TEXT NOT NULL
      );
      CREATE UNIQUE INDEX uq_account_name ON account(name) WHERE archived = 0;

      -- 分类（收入/支出，支持一级父子）
      CREATE TABLE category (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('income','expense')),
        parent_id  TEXT REFERENCES category(id),
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX uq_category_kind_name ON category(kind, name);

      -- Excel 导入批次，支持整批撤销
      CREATE TABLE import_batch (
        id             TEXT PRIMARY KEY,
        file_name      TEXT NOT NULL,
        file_hash      TEXT NOT NULL,
        row_count      INTEGER NOT NULL,
        imported_count INTEGER NOT NULL,
        status         TEXT NOT NULL DEFAULT 'committed' CHECK (status IN ('committed','reverted')),
        created_at     TEXT NOT NULL
      );
      CREATE INDEX idx_import_batch_hash ON import_batch(file_hash);

      -- 交易主表：不物理删除，只作废
      CREATE TABLE tx (
        id              TEXT PRIMARY KEY,
        occurred_on     TEXT NOT NULL,                 -- YYYY-MM-DD
        type            TEXT NOT NULL CHECK (type IN ('income','expense','transfer')),
        summary         TEXT NOT NULL,
        category_id     TEXT REFERENCES category(id),
        counterparty    TEXT NOT NULL DEFAULT '',
        note            TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','voided')),
        import_batch_id TEXT REFERENCES import_batch(id),
        fingerprint     TEXT,                          -- 导入去重指纹
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        version         INTEGER NOT NULL DEFAULT 1,
        device_id       TEXT NOT NULL
      );
      CREATE INDEX idx_tx_occurred ON tx(occurred_on);
      CREATE INDEX idx_tx_fingerprint ON tx(fingerprint);
      CREATE INDEX idx_tx_batch ON tx(import_batch_id);

      -- 交易分录：同一笔交易所有分录之和必须为 0（钱不会凭空出现）
      CREATE TABLE tx_line (
        id         TEXT PRIMARY KEY,
        tx_id      TEXT NOT NULL REFERENCES tx(id),
        account_id TEXT NOT NULL REFERENCES account(id),
        amount     INTEGER NOT NULL                     -- 正=流入 负=流出（分）
      );
      CREATE INDEX idx_line_tx ON tx_line(tx_id);
      CREATE INDEX idx_line_account ON tx_line(account_id);

      -- 审计日志：追加写入，不修改不删除；后期也可作为同步变更流
      CREATE TABLE audit_log (
        id         TEXT PRIMARY KEY,
        entity     TEXT NOT NULL,
        entity_id  TEXT NOT NULL,
        action     TEXT NOT NULL,
        payload    TEXT NOT NULL DEFAULT '{}',
        device_id  TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);
    `
  }
];
