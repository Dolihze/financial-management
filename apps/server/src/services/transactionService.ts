import { createHash } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  TRANSACTION_SUB_TYPES,
  TRANSACTION_TYPE_SUB_TYPES,
  TRANSACTION_TYPE_LABELS,
  isInflow,
  type CreateTransactionInput,
  type Transaction,
  type TransactionAttachment,
  type TransactionLine,
  type TransactionSubType,
  type TransactionType
} from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { toAttachment } from './attachmentService';
import { writeAudit } from './audit';

interface TxRow {
  id: string;
  occurred_on: string;
  type: TransactionType;
  sub_type: TransactionSubType | null;
  summary: string;
  category_id: string | null;
  category_name: string | null;
  counterparty_id: string | null;
  counterparty: string;
  note: string;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
}

interface LineRow {
  id: string;
  tx_id: string;
  account_id: string;
  account_name: string;
  amount: number;
}

export interface TransactionQuery {
  accountId?: string;
  type?: TransactionType;
  categoryId?: string;
  counterpartyId?: string;
  from?: string;
  to?: string;
  keyword?: string;
  limit?: number;
  offset?: number;
}

/** 导入去重指纹：日期 + 类型 + 金额 + 往来单位 + 账户 */
export function makeFingerprint(parts: {
  occurredOn: string;
  type: string;
  amount: number;
  counterparty: string;
  accountKey: string;
}): string {
  return createHash('sha1')
    .update([parts.occurredOn, parts.type, parts.amount, parts.counterparty.trim(), parts.accountKey].join('|'))
    .digest('hex');
}

/**
 * 解析并校验子类型：收入/支出不能带子类型；借款/贷款省略时取默认（借款=lend，贷款=loan），
 * 且必须属于该类型（借款只能是 lend/repay_in，贷款只能是 loan/repay_out）。
 */
export function resolveSubType(input: Pick<CreateTransactionInput, 'type' | 'subType'>): TransactionSubType | null {
  const allowed = TRANSACTION_TYPE_SUB_TYPES[input.type];
  if (!allowed) throw new AppError('未知的交易类型');
  if (allowed.length === 0) {
    if (input.subType) throw new AppError(`${TRANSACTION_TYPE_LABELS[input.type]}不能指定借款/贷款分类`);
    return null;
  }
  const sub = input.subType ?? allowed[0]!;
  if (!(TRANSACTION_SUB_TYPES as readonly string[]).includes(sub) || !allowed.includes(sub)) {
    throw new AppError(`${TRANSACTION_TYPE_LABELS[input.type]}的分类不合法`);
  }
  return sub;
}

/**
 * 将业务入参展开为分录（均为与「外部」的往来，单账户单分录）。
 * 流入（收入 / 别人还企信钱 / 贷款）=入账户 +amt；流出（支出 / 企信借别人钱 / 还贷）=出账户 -amt。
 */
export function buildLines(input: CreateTransactionInput): Array<{ accountId: string; amount: number }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new AppError('金额必须为大于 0 的整数分');
  }
  const sub = resolveSubType(input);
  const inflow = isInflow(input.type, sub);
  if (!input.accountId) {
    throw new AppError(`${TRANSACTION_TYPE_LABELS[input.type]}必须指定${inflow ? '入账' : '出账'}账户`);
  }
  return [{ accountId: input.accountId, amount: inflow ? input.amount : -input.amount }];
}

export class TransactionService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string,
    /** 附件目录：删除流水时清理磁盘上的附件文件；不传则只删记录（导入/项目等内部使用的实例不需要） */
    private readonly attachmentsDir?: string
  ) {}

  /** 校验入参并展开分录；返回分录与往来单位名称快照（新增与编辑共用） */
  private prepare(input: CreateTransactionInput): {
    lines: Array<{ accountId: string; amount: number }>;
    counterpartyName: string;
    subType: TransactionSubType | null;
  } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) throw new AppError('日期格式应为 YYYY-MM-DD');

    const subType = resolveSubType(input);
    const lines = buildLines(input);

    const accountIds = lines.map((l) => l.accountId);
    for (const aid of accountIds) {
      const acc = this.db.prepare('SELECT archived FROM account WHERE id = ?').get(aid) as { archived: number } | undefined;
      if (!acc) throw new AppError(`账户不存在: ${aid}`, 404, 'NOT_FOUND');
      if (acc.archived === 1) throw new AppError('账户已归档，不能记账');
    }

    // 往来单位：必须是存在且未删除的主数据；同时写入名称快照
    let counterpartyName = '';
    if (input.counterpartyId) {
      const cp = this.db.prepare('SELECT name FROM counterparty WHERE id = ? AND archived = 0').get(input.counterpartyId) as
        | { name: string }
        | undefined;
      if (!cp) throw new AppError('往来单位不存在或已删除', 404, 'NOT_FOUND');
      counterpartyName = cp.name;
    }
    return { lines, counterpartyName, subType };
  }

  /** 在已有事务内插入一笔交易（导入批量调用复用） */
  insertWithinTx(input: CreateTransactionInput, extra: { importBatchId?: string; fingerprint?: string } = {}): string {
    const { lines, counterpartyName, subType } = this.prepare(input);

    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tx (id,occurred_on,type,sub_type,summary,category_id,counterparty_id,counterparty,note,status,import_batch_id,fingerprint,created_at,updated_at,version,device_id)
         VALUES (?,?,?,?,?,?,?,?,?,'normal',?,?,?,?,1,?)`
      )
      .run(
        id,
        input.occurredOn,
        input.type,
        subType,
        '', // summary 列保留（历史数据），新交易不再录入
        input.categoryId ?? null,
        input.counterpartyId ?? null,
        counterpartyName,
        input.note ?? '',
        extra.importBatchId ?? null,
        extra.fingerprint ?? null,
        now,
        now,
        this.deviceId
      );
    const insertLine = this.db.prepare('INSERT INTO tx_line (id,tx_id,account_id,amount) VALUES (?,?,?,?)');
    for (const l of lines) insertLine.run(newId(), id, l.accountId, l.amount);
    writeAudit(this.db, this.deviceId, 'tx', id, 'create', input);
    return id;
  }

  create(input: CreateTransactionInput): Transaction {
    const id = this.db.transaction(() => this.insertWithinTx(input))();
    return this.get(id);
  }

  get(id: string): Transaction {
    const row = this.db
      .prepare(
        `SELECT t.*, c.name AS category_name FROM tx t LEFT JOIN category c ON c.id = t.category_id WHERE t.id = ?`
      )
      .get(id) as TxRow | undefined;
    if (!row) throw new AppError('交易不存在', 404, 'NOT_FOUND');
    return this.hydrate([row])[0]!;
  }

  /** 列表与统计共用的筛选条件 */
  private buildFilter(q: TransactionQuery): { whereSql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.type) {
      where.push('t.type = ?');
      params.push(q.type);
    }
    if (q.categoryId) {
      where.push('t.category_id = ?');
      params.push(q.categoryId);
    }
    if (q.counterpartyId) {
      where.push('t.counterparty_id = ?');
      params.push(q.counterpartyId);
    }
    if (q.from) {
      where.push('t.occurred_on >= ?');
      params.push(q.from);
    }
    if (q.to) {
      where.push('t.occurred_on <= ?');
      params.push(q.to);
    }
    if (q.keyword) {
      where.push('(t.summary LIKE ? OR t.counterparty LIKE ? OR t.note LIKE ?)');
      const like = `%${q.keyword}%`;
      params.push(like, like, like);
    }
    if (q.accountId) {
      where.push('EXISTS (SELECT 1 FROM tx_line l WHERE l.tx_id = t.id AND l.account_id = ?)');
      params.push(q.accountId);
    }
    return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  list(q: TransactionQuery = {}): { items: Transaction[]; total: number } {
    const { whereSql, params } = this.buildFilter(q);
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM tx t ${whereSql}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT t.*, c.name AS category_name FROM tx t LEFT JOIN category c ON c.id = t.category_id
         ${whereSql} ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, q.limit ?? 50, q.offset ?? 0) as TxRow[];
    return { items: this.hydrate(rows), total };
  }

  /**
   * 按与 list 相同的筛选条件统计盈亏（忽略分页）：
   * 收入合计、支出合计（正数）、盈亏 = 收入 − 支出。只统计收入/支出；借款/贷款是资金往来，不计入盈亏。
   */
  summary(q: TransactionQuery = {}): { income: number; expense: number; profit: number; count: number } {
    const { whereSql, params } = this.buildFilter(q);
    const extra = whereSql ? `${whereSql} AND` : 'WHERE';
    const row = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN t.type = 'income'  THEN l.amount END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type = 'expense' THEN -l.amount END), 0) AS expense,
           COUNT(DISTINCT t.id) AS count
         FROM tx t JOIN tx_line l ON l.tx_id = t.id
         ${extra} t.type IN ('income', 'expense')`
      )
      .get(...params) as { income: number; expense: number; count: number };
    return { income: row.income, expense: row.expense, profit: row.income - row.expense, count: row.count };
  }

  /**
   * 编辑流水（全部字段）：校验规则与新增一致；分录整体重写（金额/账户/类型可变），余额由流水实时推导。
   * 审计里同时记录修改前后的内容。
   */
  update(id: string, input: CreateTransactionInput): Transaction {
    const before = this.get(id);
    this.assertNotProjectPosting(id);
    const { lines, counterpartyName, subType } = this.prepare(input);
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE tx SET occurred_on = ?, type = ?, sub_type = ?, category_id = ?, counterparty_id = ?, counterparty = ?, note = ?,
                  updated_at = ?, version = version + 1 WHERE id = ?`
        )
        .run(
          input.occurredOn,
          input.type,
          subType,
          input.categoryId ?? null,
          input.counterpartyId ?? null,
          counterpartyName,
          input.note ?? '',
          nowIso(),
          id
        );
      this.db.prepare('DELETE FROM tx_line WHERE tx_id = ?').run(id);
      const insertLine = this.db.prepare('INSERT INTO tx_line (id,tx_id,account_id,amount) VALUES (?,?,?,?)');
      for (const l of lines) insertLine.run(newId(), id, l.accountId, l.amount);
      writeAudit(this.db, this.deviceId, 'tx', id, 'update', {
        before: {
          occurredOn: before.occurredOn,
          type: before.type,
          subType: before.subType,
          categoryId: before.categoryId,
          counterpartyId: before.counterpartyId,
          note: before.note,
          lines: before.lines.map((l) => ({ accountId: l.accountId, amount: l.amount }))
        },
        after: { ...input, subType }
      });
    })();
    return this.get(id);
  }

  /**
   * 在调用方的事务内物理删除一笔流水：分录、附件记录、项目入账关联一并删除，写审计（审计保留删除前的内容）。
   * 返回被删除附件在磁盘上的文件名，由调用方在事务提交后清理磁盘文件。
   */
  removeWithinTx(id: string): string[] {
    const tx = this.get(id);
    const files = (
      this.db.prepare('SELECT stored_name FROM tx_attachment WHERE tx_id = ?').all(id) as Array<{ stored_name: string }>
    ).map((r) => r.stored_name);
    this.db.prepare('DELETE FROM project_posting WHERE tx_id = ?').run(id);
    this.db.prepare('DELETE FROM tx_attachment WHERE tx_id = ?').run(id);
    this.db.prepare('DELETE FROM tx_line WHERE tx_id = ?').run(id);
    this.db.prepare('DELETE FROM tx WHERE id = ?').run(id);
    writeAudit(this.db, this.deviceId, 'tx', id, 'delete', {
      occurredOn: tx.occurredOn,
      type: tx.type,
      subType: tx.subType,
      categoryId: tx.categoryId,
      counterpartyId: tx.counterpartyId,
      counterparty: tx.counterparty,
      note: tx.note,
      importBatchId: tx.importBatchId,
      lines: tx.lines.map((l) => ({ accountId: l.accountId, amount: l.amount })),
      attachments: tx.attachments.map((a) => ({ fileName: a.fileName, size: a.size }))
    });
    return files;
  }

  /**
   * 由项目入账生成的流水（有未回退的 project_posting 关联）不能单独编辑/删除：
   * 否则项目的「是/否」标记与账上金额会不一致。需要在项目里把对应字段切回「否」来回退入账。
   * 只用于用户直接操作的入口；项目回退、导入撤销走 removeWithinTx，不受此限制。
   */
  private assertNotProjectPosting(id: string): void {
    const linked = this.db.prepare('SELECT 1 FROM project_posting WHERE tx_id = ? AND active = 1').get(id);
    if (linked) {
      throw new AppError(
        '该流水由项目入账自动生成，不能单独编辑或删除。请在项目中把对应字段切换为「否」回退入账',
        409,
        'TX_LINKED_TO_PROJECT'
      );
    }
  }

  /** 删除流水（物理删除）。磁盘上的附件文件在提交后清理（清理失败不影响删除结果）。 */
  remove(id: string): void {
    this.get(id); // 不存在时 404
    this.assertNotProjectPosting(id);
    const files = this.db.transaction(() => this.removeWithinTx(id))();
    this.deleteFiles(files);
  }

  /** 清理磁盘文件（事务提交后调用）；文件已不存在等情况忽略 */
  deleteFiles(storedNames: string[]): void {
    if (!this.attachmentsDir) return;
    for (const f of storedNames) {
      try {
        unlinkSync(join(this.attachmentsDir, f));
      } catch {
        /* ignore */
      }
    }
  }

  private hydrate(rows: TxRow[]): Transaction[] {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => '?').join(',');
    const lineRows = this.db
      .prepare(
        `SELECT l.*, a.name AS account_name FROM tx_line l JOIN account a ON a.id = l.account_id
         WHERE l.tx_id IN (${placeholders})`
      )
      .all(...ids) as LineRow[];
    const byTx = new Map<string, TransactionLine[]>();
    for (const l of lineRows) {
      const arr = byTx.get(l.tx_id) ?? [];
      arr.push({ id: l.id, accountId: l.account_id, accountName: l.account_name, amount: l.amount });
      byTx.set(l.tx_id, arr);
    }
    const attachmentRows = this.db
      .prepare(`SELECT * FROM tx_attachment WHERE tx_id IN (${placeholders}) AND deleted_at IS NULL ORDER BY created_at, rowid`)
      .all(...ids) as Array<Parameters<typeof toAttachment>[0]>;
    const attachmentsByTx = new Map<string, TransactionAttachment[]>();
    for (const a of attachmentRows) {
      const arr = attachmentsByTx.get(a.tx_id) ?? [];
      arr.push(toAttachment(a));
      attachmentsByTx.set(a.tx_id, arr);
    }
    const linkedRows = this.db
      .prepare(`SELECT DISTINCT tx_id FROM project_posting WHERE active = 1 AND tx_id IN (${placeholders})`)
      .all(...ids) as Array<{ tx_id: string }>;
    const linked = new Set(linkedRows.map((r) => r.tx_id));
    return rows.map((r) => ({
      id: r.id,
      occurredOn: r.occurred_on,
      type: r.type,
      subType: r.sub_type,
      summary: r.summary,
      categoryId: r.category_id,
      categoryName: r.category_name,
      counterpartyId: r.counterparty_id,
      counterparty: r.counterparty,
      note: r.note,
      importBatchId: r.import_batch_id,
      linkedToProject: linked.has(r.id),
      lines: byTx.get(r.id) ?? [],
      attachments: attachmentsByTx.get(r.id) ?? [],
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }
}
