import type { BorrowSummary, OverviewSummary, PeriodSummary } from '@fm/shared';
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

  /** 公司账目总览：现有金额、各账户余额、借款/贷款累计、本月收支、近 6 个月趋势、本月支出分类 */
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
         WHERE substr(t.occurred_on,1,7) = ?`
      )
      .get(month) as { income: number; expense: number };

    const trendRows = this.db
      .prepare(
        `SELECT substr(t.occurred_on,1,7) AS month,
                COALESCE(SUM(CASE WHEN t.type='income'  THEN l.amount END), 0) AS income,
                COALESCE(SUM(CASE WHEN t.type='expense' THEN -l.amount END), 0) AS expense
         FROM tx t JOIN tx_line l ON l.tx_id = t.id
         WHERE t.type IN ('income','expense')
         GROUP BY month ORDER BY month DESC LIMIT 6`
      )
      .all() as Array<{ month: string; income: number; expense: number }>;

    const byCategory = this.db
      .prepare(
        `SELECT t.category_id AS categoryId, COALESCE(c.name,'未分类') AS categoryName, SUM(-l.amount) AS amount
         FROM tx t JOIN tx_line l ON l.tx_id = t.id LEFT JOIN category c ON c.id = t.category_id
         WHERE t.type='expense' AND substr(t.occurred_on,1,7) = ?
         GROUP BY t.category_id ORDER BY amount DESC`
      )
      .all(month) as OverviewSummary['expenseByCategory'];

    return {
      totalBalance,
      accounts: accounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: a.balance })),
      monthIncome: monthRow.income,
      monthExpense: monthRow.expense,
      trend: trendRows.reverse(),
      expenseByCategory: byCategory,
      borrow: this.debtSummary('borrow'),
      loan: this.debtSummary('loan')
    };
  }

  /**
   * 借款 / 贷款统计（两者分开，互不抵消）：按往来单位汇总「未还余额」，全部时间累计，不受时间段影响。
   * - 借款 = 企信借别人钱(出账) − 别人还企信钱(入账) = -SUM(分录)，即别人欠企信的；
   * - 贷款 = 贷款(入账) − 还贷(出账) = SUM(分录)，即企信欠别人的。
   * 余额为 0 的往来单位不展示；还多了则为负数。
   */
  debtSummary(type: 'borrow' | 'loan'): BorrowSummary {
    const net = type === 'borrow' ? 'SUM(-l.amount)' : 'SUM(l.amount)';
    // 别名用 balance 而不是 amount：避免与 tx_line.amount 列重名，导致 HAVING/ORDER BY 绑定到原始列
    const rows = this.db
      .prepare(
        `SELECT CASE WHEN TRIM(t.counterparty) = '' THEN '未填写' ELSE TRIM(t.counterparty) END AS name,
                ${net} AS balance
         FROM tx t JOIN tx_line l ON l.tx_id = t.id
         WHERE t.type = ?
         GROUP BY name HAVING ${net} <> 0 ORDER BY balance DESC, name`
      )
      .all(type) as Array<{ name: string; balance: number }>;
    const items = rows.map((r) => ({ name: r.name, amount: r.balance }));
    return { total: items.reduce((s, r) => s + r.amount, 0), items };
  }

  /**
   * 指定时间段（含首尾日期，缺省一端表示不限）内的收入/支出统计与去向明细。
   * 只统计收入/支出；借款/贷款是资金往来，不计入。
   */
  periodSummary(range: { from?: string; to?: string } = {}): PeriodSummary {
    const where = ["t.type IN ('income','expense')"];
    const params: string[] = [];
    if (range.from) {
      where.push('t.occurred_on >= ?');
      params.push(range.from);
    }
    if (range.to) {
      where.push('t.occurred_on <= ?');
      params.push(range.to);
    }
    const whereSql = where.join(' AND ');

    const total = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN t.type='income'  THEN l.amount END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type='expense' THEN -l.amount END), 0) AS expense,
           COUNT(DISTINCT t.id) AS count
         FROM tx t JOIN tx_line l ON l.tx_id = t.id WHERE ${whereSql}`
      )
      .get(...params) as { income: number; expense: number; count: number };

    const byCategory = (type: 'income' | 'expense') =>
      this.db
        .prepare(
          `SELECT t.category_id AS categoryId, COALESCE(c.name,'未分类') AS categoryName,
                  SUM(${type === 'income' ? 'l.amount' : '-l.amount'}) AS amount, COUNT(DISTINCT t.id) AS count
           FROM tx t JOIN tx_line l ON l.tx_id = t.id LEFT JOIN category c ON c.id = t.category_id
           WHERE ${whereSql} AND t.type = ?
           GROUP BY t.category_id ORDER BY amount DESC, categoryName`
        )
        .all(...params, type) as PeriodSummary['expenseByCategory'];

    const byCounterparty = (type: 'income' | 'expense') =>
      this.db
        .prepare(
          `SELECT CASE WHEN TRIM(t.counterparty) = '' THEN '未填写' ELSE TRIM(t.counterparty) END AS name,
                  SUM(${type === 'income' ? 'l.amount' : '-l.amount'}) AS amount, COUNT(DISTINCT t.id) AS count
           FROM tx t JOIN tx_line l ON l.tx_id = t.id
           WHERE ${whereSql} AND t.type = ?
           GROUP BY name ORDER BY amount DESC, name`
        )
        .all(...params, type) as PeriodSummary['expenseByCounterparty'];

    return {
      from: range.from ?? null,
      to: range.to ?? null,
      income: total.income,
      expense: total.expense,
      profit: total.income - total.expense,
      count: total.count,
      expenseByCategory: byCategory('expense'),
      incomeByCategory: byCategory('income'),
      expenseByCounterparty: byCounterparty('expense'),
      incomeByCounterparty: byCounterparty('income')
    };
  }
  /**
   * 对账校验：每笔交易必须恰有一条分录，且方向与类型（借款/贷款看子类型）一致
   * （收入/贷款/别人还企信钱为流入 > 0，支出/企信借别人钱/还贷为流出 < 0），否则说明数据被破坏。
   * 子类型为空的历史借款按借出、贷款按借入处理（迁移 v3 已回填，这里只是兜底）。
   */
  integrityCheck(): { ok: boolean; brokenTransactions: string[] } {
    const rows = this.db
      .prepare(
        `SELECT t.id FROM tx t LEFT JOIN tx_line l ON l.tx_id = t.id
         GROUP BY t.id
         HAVING COUNT(l.id) <> 1
             OR (t.type = 'income' AND SUM(l.amount) <= 0)
             OR (t.type = 'expense' AND SUM(l.amount) >= 0)
             OR (t.type = 'borrow' AND COALESCE(t.sub_type,'lend') = 'lend'     AND SUM(l.amount) >= 0)
             OR (t.type = 'borrow' AND COALESCE(t.sub_type,'lend') = 'repay_in' AND SUM(l.amount) <= 0)
             OR (t.type = 'loan'   AND COALESCE(t.sub_type,'loan') = 'loan'      AND SUM(l.amount) <= 0)
             OR (t.type = 'loan'   AND COALESCE(t.sub_type,'loan') = 'repay_out' AND SUM(l.amount) >= 0)`
      )
      .all() as Array<{ id: string }>;
    return { ok: rows.length === 0, brokenTransactions: rows.map((r) => r.id) };
  }
}
