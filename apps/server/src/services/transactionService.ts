import { createHash } from 'node:crypto';
import type { CreateTransactionInput, Transaction, TransactionLine, TransactionType } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

interface TxRow {
  id: string;
  occurred_on: string;
  type: TransactionType;
  summary: string;
  category_id: string | null;
  category_name: string | null;
  counterparty_id: string | null;
  counterparty: string;
  note: string;
  status: 'normal' | 'voided';
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
  includeVoided?: boolean;
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
 * 将业务入参展开为分录（均为与「外部」的往来，单账户单分录）。
 * 收入/贷款（借入）=入账户 +amt；支出/借款（借出）=出账户 -amt。
 */
export function buildLines(input: CreateTransactionInput): Array<{ accountId: string; amount: number }> {
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    throw new AppError('金额必须为大于 0 的整数分');
  }
  switch (input.type) {
    case 'income':
      if (!input.accountId) throw new AppError('收入必须指定入账账户');
      return [{ accountId: input.accountId, amount: input.amount }];
    case 'expense':
      if (!input.accountId) throw new AppError('支出必须指定出账账户');
      return [{ accountId: input.accountId, amount: -input.amount }];
    case 'borrow':
      if (!input.accountId) throw new AppError('借款必须指定出账账户');
      return [{ accountId: input.accountId, amount: -input.amount }];
    case 'loan':
      if (!input.accountId) throw new AppError('贷款必须指定入账账户');
      return [{ accountId: input.accountId, amount: input.amount }];
    default:
      throw new AppError('未知的交易类型');
  }
}

export class TransactionService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {}

  /** 在已有事务内插入一笔交易（导入批量调用复用） */
  insertWithinTx(input: CreateTransactionInput, extra: { importBatchId?: string; fingerprint?: string } = {}): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) throw new AppError('日期格式应为 YYYY-MM-DD');

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

    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tx (id,occurred_on,type,summary,category_id,counterparty_id,counterparty,note,status,import_batch_id,fingerprint,created_at,updated_at,version,device_id)
         VALUES (?,?,?,?,?,?,?,?,'normal',?,?,?,?,1,?)`
      )
      .run(
        id,
        input.occurredOn,
        input.type,
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

  list(q: TransactionQuery = {}): { items: Transaction[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!q.includeVoided) where.push("t.status = 'normal'");
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
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (this.db.prepare(`SELECT COUNT(*) AS c FROM tx t ${whereSql}`).get(...params) as { c: number }).c;
    const rows = this.db
      .prepare(
        `SELECT t.*, c.name AS category_name FROM tx t LEFT JOIN category c ON c.id = t.category_id
         ${whereSql} ORDER BY t.occurred_on DESC, t.created_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, q.limit ?? 50, q.offset ?? 0) as TxRow[];
    return { items: this.hydrate(rows), total };
  }

  /** 作废交易（不物理删除）。分录保留，仅不再计入余额。 */
  void(id: string, reason = ''): Transaction {
    const tx = this.get(id);
    if (tx.status === 'voided') throw new AppError('交易已作废', 409, 'ALREADY_VOIDED');
    this.db.transaction(() => {
      this.db
        .prepare("UPDATE tx SET status = 'voided', updated_at = ?, version = version + 1 WHERE id = ?")
        .run(nowIso(), id);
      writeAudit(this.db, this.deviceId, 'tx', id, 'void', { reason });
    })();
    return this.get(id);
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
    return rows.map((r) => ({
      id: r.id,
      occurredOn: r.occurred_on,
      type: r.type,
      summary: r.summary,
      categoryId: r.category_id,
      categoryName: r.category_name,
      counterpartyId: r.counterparty_id,
      counterparty: r.counterparty,
      note: r.note,
      status: r.status,
      importBatchId: r.import_batch_id,
      lines: byTx.get(r.id) ?? [],
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }));
  }
}
