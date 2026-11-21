import type { OverviewSummary } from '@fm/shared';
import type { Db } from '../db/database';
import { AccountService } from './accountService';

export class OverviewService {
  private readonly accounts: AccountService;

  constructor(
    private readonly db: Db,
    deviceId: string
  ) {
    this.accounts = new AccountService(db, deviceId);
  }

  /** 公司账目总览：总余额、各账户余额、本月收支、近 6 个月趋势、本月支出分类 */
  summary(today = new Date()): OverviewSummary {
    const accounts = this.accounts.list();
    const totalBalance = accounts.reduce((s, a) => s + a.balance, 0);

    const month = today.toISOString().slice(0, 7); // YYYY-MM
    const monthRow = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN t.type='income'  THEN l.amount END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type='expense' THEN -l.amount END), 0) AS expense
         FROM tx t JOIN tx_line l ON l.tx_id = t.id
         WHERE t.status='normal' AND substr(t.occurred_on,1,7) = ?`
      )
      .get(month) as { income: number; expense: number };

    const trendRows = this.db
      .prepare(
        `SELECT substr(t.occurred_on,1,7) AS month,
                COALESCE(SUM(CASE WHEN t.type='income'  THEN l.amount END), 0) AS income,
                COALESCE(SUM(CASE WHEN t.type='expense' THEN -l.amount END), 0) AS expense
         FROM tx t JOIN tx_line l ON l.tx_id = t.id
         WHERE t.status='normal' AND t.type IN ('income','expense')
         GROUP BY month ORDER BY month DESC LIMIT 6`
      )
      .all() as Array<{ month: string; income: number; expense: number }>;

    const byCategory = this.db
      .prepare(
        `SELECT t.category_id AS categoryId, COALESCE(c.name,'未分类') AS categoryName, SUM(-l.amount) AS amount
         FROM tx t JOIN tx_line l ON l.tx_id = t.id LEFT JOIN category c ON c.id = t.category_id
         WHERE t.status='normal' AND t.type='expense' AND substr(t.occurred_on,1,7) = ?
         GROUP BY t.category_id ORDER BY amount DESC`
      )
      .all(month) as OverviewSummary['expenseByCategory'];

    return {
      totalBalance,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: a.balance })),
      monthIncome: monthRow.income,
      monthExpense: monthRow.expense,
      trend: trendRows.reverse(),
      expenseByCategory: byCategory
    };
  }

  /**
   * 对账校验：每笔交易必须恰有一条分录，且方向与类型一致
   * （收入/贷款为流入 > 0，支出/借款为流出 < 0），否则说明数据被破坏。
   */
  integrityCheck(): { ok: boolean; brokenTransactions: string[] } {
    const rows = this.db
      .prepare(
        `SELECT t.id FROM tx t LEFT JOIN tx_line l ON l.tx_id = t.id
         GROUP BY t.id
         HAVING COUNT(l.id) <> 1
             OR (t.type IN ('income','loan')   AND SUM(l.amount) <= 0)
             OR (t.type IN ('expense','borrow') AND SUM(l.amount) >= 0)`
      )
      .all() as Array<{ id: string }>;
    return { ok: rows.length === 0, brokenTransactions: rows.map((r) => r.id) };
  }
}
