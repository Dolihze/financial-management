/**
 * 数据库迁移：按 version 递增顺序执行，已执行的版本记录在 schema_migrations。
 *
 * 规则：只追加新 version，不修改已有迁移。加字段 / 建表 / 改索引都新增一个 version，
 * 已有的本地库（包括演示库）启动时会自动升级，不需要删库重建。
 * （v1 是开发早期把历史迁移压平后的初始 schema；之后的改动都以 v2、v3… 追加。）
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
      -- 账户：银行 / 支付宝 / 微信等
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
        device_id       TEXT NOT NULL,
        bank_name       TEXT NOT NULL DEFAULT '',
        account_no      TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX uq_account_name ON account(name) WHERE archived = 0;

      -- 分类（收入/支出，支持一级父子）；内置分类由 CategoryService.seedDefaults 首次启动时写入
      CREATE TABLE category (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL CHECK (kind IN ('income','expense')),
        parent_id  TEXT REFERENCES category(id),
        created_at TEXT NOT NULL,
        builtin    INTEGER NOT NULL DEFAULT 0,
        archived   INTEGER NOT NULL DEFAULT 0,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE UNIQUE INDEX uq_category_kind_name ON category(kind, name);

      -- 往来单位主数据（tx.counterparty 保留为名称快照）
      CREATE TABLE counterparty (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        archived   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX uq_counterparty_name ON counterparty(name);

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

      -- 交易主表：删除为物理删除（删除前内容写入审计）；status 恒为 normal，不再使用「作废」概念
      CREATE TABLE tx (
        id              TEXT PRIMARY KEY,
        occurred_on     TEXT NOT NULL,                 -- YYYY-MM-DD
        type            TEXT NOT NULL CHECK (type IN ('income','expense','borrow','loan')),
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
        device_id       TEXT NOT NULL,
        counterparty_id TEXT REFERENCES counterparty(id)
      );
      CREATE INDEX idx_tx_occurred ON tx(occurred_on);
      CREATE INDEX idx_tx_fingerprint ON tx(fingerprint);
      CREATE INDEX idx_tx_batch ON tx(import_batch_id);
      CREATE INDEX idx_tx_counterparty ON tx(counterparty_id);

      -- 交易分录：同一笔交易所有分录之和必须为 0（钱不会凭空出现）
      CREATE TABLE tx_line (
        id         TEXT PRIMARY KEY,
        tx_id      TEXT NOT NULL REFERENCES tx(id),
        account_id TEXT NOT NULL REFERENCES account(id),
        amount     INTEGER NOT NULL                     -- 正=流入 负=流出（分）
      );
      CREATE INDEX idx_line_tx ON tx_line(tx_id);
      CREATE INDEX idx_line_account ON tx_line(account_id);

      -- 流水附件：文件本体在磁盘，库里只存元数据；删除为软删除（deleted_at）
      CREATE TABLE tx_attachment (
        id          TEXT PRIMARY KEY,
        tx_id       TEXT NOT NULL REFERENCES tx(id),
        file_name   TEXT NOT NULL,            -- 用户上传时的原始文件名（展示/下载用）
        stored_name TEXT NOT NULL,            -- 磁盘上的文件名（id + 扩展名，避免重名与路径注入）
        mime_type   TEXT NOT NULL,
        size        INTEGER NOT NULL,         -- 字节数
        created_at  TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        deleted_at  TEXT
      );
      CREATE INDEX idx_tx_attachment_tx ON tx_attachment(tx_id);

      -- 批次：批次号在未归档批次中唯一；批次号 0 为「未分批」
      -- sealed_at：存档时间。NULL = 正在结算中；有值 = 已存档（只读，其下合同/项目/文件都不能再改）
      CREATE TABLE batch (
        id         TEXT PRIMARY KEY,
        batch_no   INTEGER NOT NULL,
        note       TEXT NOT NULL DEFAULT '',
        archived   INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        device_id  TEXT NOT NULL,
        sealed_at  TEXT
      );
      CREATE UNIQUE INDEX uq_batch_no ON batch(batch_no) WHERE archived = 0;

      -- 批次的相关文件：与流水附件共用同一个磁盘目录；删除为软删除（deleted_at）
      CREATE TABLE batch_attachment (
        id          TEXT PRIMARY KEY,
        batch_id    TEXT NOT NULL REFERENCES batch(id),
        file_name   TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type   TEXT NOT NULL,
        size        INTEGER NOT NULL,
        created_at  TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        deleted_at  TEXT
      );
      CREATE INDEX idx_batch_attachment_batch ON batch_attachment(batch_id);

      -- 合同：归属一个批次；合同编号在未归档合同中唯一
      CREATE TABLE contract (
        id          TEXT PRIMARY KEY,
        contract_no TEXT NOT NULL,
        archived    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        device_id   TEXT NOT NULL,
        batch_id    TEXT REFERENCES batch(id)
      );
      CREATE UNIQUE INDEX uq_contract_no ON contract(contract_no) WHERE archived = 0;
      CREATE INDEX idx_contract_batch_id ON contract(batch_id);

      -- 项目（只有一张表）：是否结算由 contract_id 是否有值区分——有合同 = 已结算，没有 = 未结算。
      -- 金额一律整数分。sh_paid（上海院已支付）否→是时按企信实收入账，由 project_posting 记录对应流水。
      CREATE TABLE project (
        id                  TEXT PRIMARY KEY,
        contract_no         TEXT NOT NULL,
        region              TEXT NOT NULL DEFAULT '',
        name                TEXT NOT NULL,
        contract_price      INTEGER NOT NULL DEFAULT 0,
        qx_received         INTEGER NOT NULL DEFAULT 0,
        qx_subcontract_fee  INTEGER NOT NULL DEFAULT 0,
        chen_pei            INTEGER NOT NULL DEFAULT 0,
        qx_profit           INTEGER NOT NULL DEFAULT 0,
        sh_paid             INTEGER NOT NULL DEFAULT 0 CHECK (sh_paid IN (0,1)),
        paid_subcontractor  INTEGER NOT NULL DEFAULT 0 CHECK (paid_subcontractor IN (0,1)),
        paid_chen_pei       INTEGER NOT NULL DEFAULT 0 CHECK (paid_chen_pei IN (0,1)),
        archived            INTEGER NOT NULL DEFAULT 0,
        created_at          TEXT NOT NULL,
        updated_at          TEXT NOT NULL,
        device_id           TEXT NOT NULL,
        batch_no            INTEGER,
        contract_id         TEXT REFERENCES contract(id),
        note                TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX uq_project_name ON project(name) WHERE archived = 0;
      CREATE INDEX idx_project_contract_no ON project(contract_no);
      CREATE INDEX idx_project_contract_id ON project(contract_id);
      CREATE INDEX idx_project_created ON project(created_at);

      -- 项目入账记录：qx_received=上海院已支付(收入) / paid_subcontractor=支付下家(支出) / paid_chen_pei=支付陈沛(支出)
      -- 同一项目同一类型同时只能有一条有效（active = 1）记录
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
    name: 'contract_note',
    sql: `
      -- 合同备注（可为空字符串）。已有合同自动得到空备注
      ALTER TABLE contract ADD COLUMN note TEXT NOT NULL DEFAULT '';
    `
  },
  {
    version: 3,
    name: 'tx_sub_type',
    sql: `
      -- 借款/贷款的子类型：lend 企信借别人钱 / repay_in 别人还企信钱 / loan 贷款 / repay_out 还贷；收入/支出为 NULL。
      -- 历史借款全部是借出（lend）、历史贷款全部是借入（loan），回填后方向与原分录一致
      ALTER TABLE tx ADD COLUMN sub_type TEXT;
      UPDATE tx SET sub_type = 'lend' WHERE type = 'borrow';
      UPDATE tx SET sub_type = 'loan' WHERE type = 'loan';
    `
  }
];
