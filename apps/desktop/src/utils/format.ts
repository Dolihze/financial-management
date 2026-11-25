import { formatMoney as formatMoneyWithSymbol, fromCents, toCents } from '@fm/shared';

export { fromCents, toCents };

/** 前端展示金额：千分位 + 两位小数，不带货币符号（如 1,234.50 / -0.50） */
export function formatMoney(cents: number): string {
  return formatMoneyWithSymbol(cents, '');
}

/** 今天的本地日期 YYYY-MM-DD（不能用 toISOString，会因时区差一天） */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
