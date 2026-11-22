/**
 * 数据库迁移：按 version 递增顺序执行，已执行的版本记录在 schema_migrations。
 * 约定：只追加新迁移，不修改已发布的迁移。
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
  /**
   * 重建表（需要临时关闭外键）的迁移：由 runMigrations 在事务外关闭 foreign_keys，
   * 事务内执行后做 foreign_key_check 校验。
   */
  rebuildsTables?: boolean;
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
  },
  {
    version: 2,
    name: 'replace_transfer_with_borrow_loan',
    rebuildsTables: true,
    sql: `
      -- 移除「转账」类型，新增「借款(borrow，借出/出账)」「贷款(loan，借入/入账)」。
      -- SQLite 无法修改 CHECK 约束，需重建 tx 表。

      -- 1) 历史转账拆成两笔单账户交易，保证每个账户的余额不变：
      --    流出分录 -> 借款(borrow)；流入分录 -> 贷款(loan)。
      --    原交易 id 保留给流出方，流入方生成新的 tx（id 后缀 -in），状态/批次与原交易一致。
      INSERT INTO tx (id, occurred_on, type, summary, category_id, counterparty, note, status,
                      import_batch_id, fingerprint, created_at, updated_at, version, device_id)
        SELECT id || '-in', occurred_on, 'transfer', summary, category_id, counterparty,
               CASE WHEN note = '' THEN '[原转账·转入]' ELSE note || ' [原转账·转入]' END,
               status, import_batch_id, NULL, created_at, updated_at, 1, device_id
        FROM tx WHERE type = 'transfer';

      -- 把流入分录挪到新 tx 上
      UPDATE tx_line SET tx_id = tx_id || '-in'
        WHERE amount > 0 AND tx_id IN (SELECT id FROM tx WHERE type = 'transfer' AND id NOT LIKE '%-in');

      -- 2) 重建 tx 表（新的 CHECK 约束）
      CREATE TABLE tx_new (
        id              TEXT PRIMARY KEY,
        occurred_on     TEXT NOT NULL,
        type            TEXT NOT NULL CHECK (type IN ('income','expense','borrow','loan')),
        summary         TEXT NOT NULL,
        category_id     TEXT REFERENCES category(id),
        counterparty    TEXT NOT NULL DEFAULT '',
        note            TEXT NOT NULL DEFAULT '',
        status          TEXT NOT NULL DEFAULT 'normal' CHECK (status IN ('normal','voided')),
        import_batch_id TEXT REFERENCES import_batch(id),
        fingerprint     TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        version         INTEGER NOT NULL DEFAULT 1,
        device_id       TEXT NOT NULL
      );
      INSERT INTO tx_new
        SELECT id, occurred_on,
               CASE
                 WHEN type <> 'transfer' THEN type
                 WHEN id LIKE '%-in' THEN 'loan'
                 ELSE 'borrow'
               END,
               summary, category_id, counterparty,
               CASE WHEN type = 'transfer' AND id NOT LIKE '%-in'
                    THEN CASE WHEN note = '' THEN '[原转账·转出]' ELSE note || ' [原转账·转出]' END
                    ELSE note END,
               status, import_batch_id, fingerprint, created_at, updated_at, version, device_id
        FROM tx;
      DROP TABLE tx;
      ALTER TABLE tx_new RENAME TO tx;
      CREATE INDEX idx_tx_occurred ON tx(occurred_on);
      CREATE INDEX idx_tx_fingerprint ON tx(fingerprint);
      CREATE INDEX idx_tx_batch ON tx(import_batch_id);
    `
  },
  {
    version: 3,
    name: 'income_category_other_only',
    sql: `
      -- 分类增加：builtin（内置，不可编辑）、archived（归档，不再出现在选择列表；不物理删除）
      ALTER TABLE category ADD COLUMN builtin  INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE category ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;

      -- 老库没有数据时由程序 seedDefaults 生成；这里只处理已存在的老库（有收入分类时）。
      -- 1) 确保存在「其他收入」，并标记为内置
      INSERT INTO category (id, name, kind, parent_id, created_at, builtin)
        SELECT lower(hex(randomblob(16))), '其他收入', 'income', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1
        WHERE EXISTS (SELECT 1 FROM category WHERE kind = 'income')
          AND NOT EXISTS (SELECT 1 FROM category WHERE kind = 'income' AND name = '其他收入');
      UPDATE category SET builtin = 1 WHERE kind = 'income' AND name = '其他收入';

      -- 2) 记录合并审计（必须在改动之前取到旧分类 id）
      INSERT INTO audit_log (id, entity, entity_id, action, payload, device_id, created_at)
        SELECT lower(hex(randomblob(16))), 'category', c.id, 'merge',
               json_object('name', c.name, 'into', (SELECT id FROM category WHERE kind='income' AND name='其他收入')),
               'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM category c WHERE c.kind = 'income' AND c.builtin = 0;

      -- 3) 旧收入分类的流水改挂到「其他收入」
      UPDATE tx SET category_id = (SELECT id FROM category WHERE kind='income' AND name='其他收入')
        WHERE category_id IN (SELECT id FROM category WHERE kind='income' AND builtin = 0);

      -- 4) 旧收入分类归档（保留行，不物理删除）
      UPDATE category SET archived = 1 WHERE kind = 'income' AND builtin = 0;
    `
  },
  {
    version: 4,
    name: 'counterparty_master',
    sql: `
      -- 往来单位主数据：可新增/重命名/归档（不物理删除）
      CREATE TABLE counterparty (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        archived   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX uq_counterparty_name ON counterparty(name);

      -- tx.counterparty（文本）保留为名称快照；新增关联列指向主数据
      ALTER TABLE tx ADD COLUMN counterparty_id TEXT REFERENCES counterparty(id);
      CREATE INDEX idx_tx_counterparty ON tx(counterparty_id);

      -- 历史流水里已有的非空往来单位文本，去重后生成主数据并关联
      INSERT INTO counterparty (id, name, created_at)
        SELECT lower(hex(randomblob(16))), name, strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM (SELECT DISTINCT trim(counterparty) AS name FROM tx WHERE trim(counterparty) <> '');
      UPDATE tx SET counterparty_id = (SELECT id FROM counterparty WHERE name = trim(tx.counterparty))
        WHERE trim(counterparty) <> '';
    `
  },
  {
    version: 5,
    name: 'expense_category_defaults',
    sql: `
      -- 支出分类收敛为 7 个内置默认项：工资薪酬、社保、差旅费、房租水电、经营费、员工报销、其他支出。
      -- 仅处理已有支出分类的老库（新库由程序 seedDefaults 生成）。
      -- 1) 补建缺失的默认项（已存在同名的直接复用）
      INSERT INTO category (id, name, kind, parent_id, created_at, builtin)
        SELECT lower(hex(randomblob(16))), d.name, 'expense', NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'), 1
        FROM (SELECT '工资薪酬' AS name UNION ALL SELECT '社保' UNION ALL SELECT '差旅费' UNION ALL
              SELECT '房租水电' UNION ALL SELECT '经营费' UNION ALL SELECT '员工报销' UNION ALL SELECT '其他支出') d
        WHERE EXISTS (SELECT 1 FROM category WHERE kind = 'expense')
          AND NOT EXISTS (SELECT 1 FROM category c WHERE c.kind = 'expense' AND c.name = d.name);
      UPDATE category SET builtin = 1, archived = 0
        WHERE kind = 'expense' AND name IN ('工资薪酬','社保','差旅费','房租水电','经营费','员工报销','其他支出');

      -- 2) 记录合并审计（改动前取旧分类 id）。被移除的 = 非内置的支出分类
      INSERT INTO audit_log (id, entity, entity_id, action, payload, device_id, created_at)
        SELECT lower(hex(randomblob(16))), 'category', c.id, 'merge',
               json_object('name', c.name, 'into', (SELECT id FROM category WHERE kind='expense' AND name='其他支出')),
               'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM category c
        WHERE c.kind = 'expense' AND c.builtin = 0 AND c.archived = 0
          AND EXISTS (SELECT 1 FROM category WHERE kind = 'expense' AND name = '其他支出');

      -- 3) 被移除分类的流水统一改挂「其他支出」
      UPDATE tx SET category_id = (SELECT id FROM category WHERE kind='expense' AND name='其他支出')
        WHERE category_id IN (SELECT id FROM category WHERE kind='expense' AND builtin = 0 AND archived = 0)
          AND EXISTS (SELECT 1 FROM category WHERE kind = 'expense' AND name = '其他支出');

      -- 4) 被移除分类归档（保留行，不物理删除）
      UPDATE category SET archived = 1 WHERE kind = 'expense' AND builtin = 0 AND archived = 0;
    `
  },
  {
    version: 6,
    name: 'account_bank_info',
    sql: `
      -- 银行账户的开户银行、银行账号（其他类型账户留空）
      ALTER TABLE account ADD COLUMN bank_name  TEXT NOT NULL DEFAULT '';
      ALTER TABLE account ADD COLUMN account_no TEXT NOT NULL DEFAULT '';
    `
  },
  {
    version: 7,
    name: 'project',
    sql: `
      -- 项目主数据：不物理删除，只归档
      CREATE TABLE project (
        id          TEXT PRIMARY KEY,
        design_no   TEXT NOT NULL DEFAULT '',
        contract_no TEXT NOT NULL DEFAULT '',
        name        TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'unsettled' CHECK (status IN ('unsettled','settled')),
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        device_id   TEXT NOT NULL
      );
      CREATE INDEX idx_project_created ON project(created_at);
    `
  },
  {
    version: 8,
    name: 'project_excel_fields',
    rebuildsTables: true,
    sql: `
      -- 项目改为仅由 Excel 导入维护：字段换成导入表头；合同编号作为唯一键（导入时存在则更新）。
      -- 金额一律整数分；三个「是否」字段存 0/1。重建表以移除 design_no / status，并保留旧数据。
      CREATE TABLE project_new (
        id                  TEXT PRIMARY KEY,
        contract_no         TEXT NOT NULL,
        batch               TEXT NOT NULL DEFAULT '',
        region              TEXT NOT NULL DEFAULT '',
        name                TEXT NOT NULL,
        contract_price      INTEGER NOT NULL DEFAULT 0,
        qx_received         INTEGER NOT NULL DEFAULT 0,
        qx_subcontract_fee  INTEGER NOT NULL DEFAULT 0,
        chen_pei            INTEGER NOT NULL DEFAULT 0,
        qx_profit           INTEGER NOT NULL DEFAULT 0,
        qx_money_received   INTEGER NOT NULL DEFAULT 0 CHECK (qx_money_received IN (0,1)),
        paid_subcontractor  INTEGER NOT NULL DEFAULT 0 CHECK (paid_subcontractor IN (0,1)),
        paid_chen_pei       INTEGER NOT NULL DEFAULT 0 CHECK (paid_chen_pei IN (0,1)),
        archived            INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        device_id           TEXT NOT NULL
      );
      INSERT INTO project_new (id, contract_no, name, archived, created_at, updated_at, device_id)
        SELECT id,
               CASE WHEN contract_no = '' THEN 'LEGACY-' || id ELSE contract_no END,
               name, archived, created_at, updated_at, device_id
        FROM project;
      DROP TABLE project;
      ALTER TABLE project_new RENAME TO project;
      CREATE UNIQUE INDEX uq_project_contract_no ON project(contract_no) WHERE archived = 0;
      CREATE INDEX idx_project_created ON project(created_at);
    `
  },
  {
    version: 9,
    name: 'project_name_unique',
    sql: `
      -- 修正：合同编号不是唯一键（同一合同下可有多个项目），项目名称才是。
      -- 导入时以项目名称匹配：已存在则更新，否则新增。合同编号允许重复，也允许为空。
      DROP INDEX IF EXISTS uq_project_contract_no;
      CREATE INDEX idx_project_contract_no ON project(contract_no);

      -- v8 为空合同编号的旧行补的 LEGACY- 占位值不再需要（合同编号可为空），还原为空串
      UPDATE project SET contract_no = '' WHERE contract_no LIKE 'LEGACY-%';

      -- 旧数据里若有未归档的重名项目，保留最早的一条，其余归档（不物理删除），
      -- 否则无法建立唯一索引；同时记审计
      INSERT INTO audit_log (id, entity, entity_id, action, payload, device_id, created_at)
        SELECT lower(hex(randomblob(16))), 'project', p.id, 'archive_duplicate_name',
               json_object('name', p.name), 'migration', strftime('%Y-%m-%dT%H:%M:%fZ','now')
        FROM project p
        WHERE p.archived = 0
          AND p.rowid > (SELECT MIN(q.rowid) FROM project q WHERE q.archived = 0 AND q.name = p.name);
      UPDATE project SET archived = 1
        WHERE archived = 0
          AND rowid > (SELECT MIN(q.rowid) FROM project q WHERE q.archived = 0 AND q.name = project.name);

      CREATE UNIQUE INDEX uq_project_name ON project(name) WHERE archived = 0;
    `
  },
  {
    version: 10,
    name: 'project_batch_no',
    sql: `
      -- 批次由文本（如「第15批」）改为批次号（整数 15）；无法解析出数字的为 NULL。
      -- 旧值只在「第N批」/「N」这两种规范形态下才转换，其余一律置空，不做猜测。
      ALTER TABLE project ADD COLUMN batch_no INTEGER;
      UPDATE project SET batch_no = CAST(trim(batch) AS INTEGER)
        WHERE trim(batch) GLOB '[0-9]*' AND trim(batch) NOT GLOB '*[^0-9]*';
      UPDATE project SET batch_no = CAST(substr(trim(batch), 2, length(trim(batch)) - 2) AS INTEGER)
        WHERE batch_no IS NULL
          AND trim(batch) GLOB '第[0-9]*批'
          AND substr(trim(batch), 2, length(trim(batch)) - 2) NOT GLOB '*[^0-9]*';
      ALTER TABLE project DROP COLUMN batch;
    `
  },
  {
    version: 11,
    name: 'project_posting',
    sql: `
      -- 项目「是」字段 <-> 记账流水 的关联：某字段当前已入账，对应哪一笔流水。
      -- 同一项目同一字段同时最多一笔「有效」入账（回退=作废该流水并解除关联）。
      -- kind: qx_received=企信是否收到钱(收入) / paid_subcontractor=支付下家(支出) / paid_chen_pei=支付陈沛(支出)
      CREATE TABLE project_posting (
        id          TEXT PRIMARY KEY,
        project_id  TEXT NOT NULL REFERENCES project(id),
        kind        TEXT NOT NULL CHECK (kind IN ('qx_received','paid_subcontractor','paid_chen_pei')),
        tx_id       TEXT NOT NULL REFERENCES tx(id),
        active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
        created_at  TEXT NOT NULL,
        reverted_at TEXT
      );
      CREATE UNIQUE INDEX uq_project_posting_active ON project_posting(project_id, kind) WHERE active = 1;
      CREATE INDEX idx_project_posting_tx ON project_posting(tx_id);
    `
  }
];
