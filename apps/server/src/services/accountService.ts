import type { Account, AccountType, ActiveAccountType } from '@fm/shared';
import type { Db } from '../db/database';
import { AppError, newId, nowIso } from '../utils';
import { writeAudit } from './audit';

interface AccountRow {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  opening_balance: number;
  bank_name: string;
  account_no: string;
  balance: number;
  note: string;
  archived: number;
  created_at: string;
  updated_at: string;
}

// 余额 = 期初 + 所有交易的分录之和（由流水实时推导，不单独存储）
const ACCOUNT_SELECT = `
  SELECT a.*,
         a.opening_balance + COALESCE((
           SELECT SUM(l.amount) FROM tx_line l
           WHERE l.account_id = a.id
         ), 0) AS balance
  FROM account a
`;

const toAccount = (r: AccountRow): Account => ({
  id: r.id,
  name: r.name,
  type: r.type,
  currency: r.currency,
  openingBalance: r.opening_balance,
  bankName: r.bank_name,
  accountNo: r.account_no,
  balance: r.balance,
  note: r.note,
  archived: r.archived === 1,
  createdAt: r.created_at,
  updatedAt: r.updated_at
});

export interface CreateAccountInput {
  name: string;
  type: ActiveAccountType;
  openingBalance?: number;
  currency?: string;
  note?: string;
  /** 开户银行、银行卡号：仅银行账户有效，其他类型会被忽略（存空串） */
  bankName?: string;
  accountNo?: string;
}

export class AccountService {
  constructor(
    private readonly db: Db,
    private readonly deviceId: string
  ) {}

  list(includeArchived = false): Account[] {
    const where = includeArchived ? '' : 'WHERE a.archived = 0';
    const rows = this.db.prepare(`${ACCOUNT_SELECT} ${where} ORDER BY a.created_at`).all() as AccountRow[];
    return rows.map(toAccount);
  }

  get(id: string): Account {
    const row = this.db.prepare(`${ACCOUNT_SELECT} WHERE a.id = ?`).get(id) as AccountRow | undefined;
    if (!row) throw new AppError('账户不存在', 404, 'NOT_FOUND');
    return toAccount(row);
  }

  create(input: CreateAccountInput): Account {
    const dup = this.db.prepare('SELECT 1 FROM account WHERE name = ? AND archived = 0').get(input.name);
    if (dup) throw new AppError(`账户名称已存在: ${input.name}`, 409, 'DUPLICATE');
    const id = newId();
    const now = nowIso();
    const isBank = input.type === 'bank';
    const bankName = isBank ? (input.bankName ?? '') : '';
    const accountNo = isBank ? (input.accountNo ?? '') : '';
    if (isBank && (!bankName || !accountNo)) {
      throw new AppError('银行账户必须填写开户银行和银行卡号', 400, 'VALIDATION');
    }
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO account (id,name,type,currency,opening_balance,bank_name,account_no,note,archived,created_at,updated_at,device_id)
           VALUES (?,?,?,?,?,?,?,?,0,?,?,?)`
        )
        .run(
          id, input.name, input.type, input.currency ?? 'CNY', input.openingBalance ?? 0,
          bankName, accountNo, input.note ?? '', now, now, this.deviceId
        );
      writeAudit(this.db, this.deviceId, 'account', id, 'create', { ...input, bankName, accountNo });
    })();
    return this.get(id);
  }

  update(id: string, patch: Partial<Pick<CreateAccountInput, 'name' | 'note' | 'type'>>): Account {
    const current = this.get(id);
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE account SET name = ?, type = ?, note = ?, updated_at = ? WHERE id = ?')
        .run(patch.name ?? current.name, patch.type ?? current.type, patch.note ?? current.note, nowIso(), id);
      // 注意：此处不处理 bank_name/account_no，类型变更后银行信息保持不变
      writeAudit(this.db, this.deviceId, 'account', id, 'update', patch);
    })();
    return this.get(id);
  }

  /** 账户不物理删除，只归档；余额不为 0 时禁止归档，避免钱"消失" */
  archive(id: string): Account {
    const acc = this.get(id);
    if (acc.balance !== 0) throw new AppError('账户余额不为 0，不能归档', 409, 'BALANCE_NOT_ZERO');
    this.db.transaction(() => {
      this.db.prepare('UPDATE account SET archived = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
      writeAudit(this.db, this.deviceId, 'account', id, 'archive');
    })();
    return this.get(id);
  }
}
