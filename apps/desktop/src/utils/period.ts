/** 时间段预设（总览、记账流水共用）：本月 / 上月 / 本季度 / 今年 / 自定义 */
export type PeriodKey = 'month' | 'lastMonth' | 'quarter' | 'year' | 'custom';

export const PERIOD_TABS: Array<{ key: PeriodKey; label: string }> = [
  { key: 'month', label: '本月' },
  { key: 'lastMonth', label: '上月' },
  { key: 'quarter', label: '本季度' },
  { key: 'year', label: '今年' },
  { key: 'custom', label: '自定义' }
];

const pad = (n: number) => String(n).padStart(2, '0');
/** 用本地时间格式化日期（不能用 toISOString，会因时区差一天） */
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function monthRange(offset = 0): [string, string] {
  const n = new Date();
  return [ymd(new Date(n.getFullYear(), n.getMonth() + offset, 1)), ymd(new Date(n.getFullYear(), n.getMonth() + offset + 1, 0))];
}

/** 预设范围，每次调用按「当前日期」重新计算 */
export function presetRange(key: Exclude<PeriodKey, 'custom'>): [string, string] {
  const n = new Date();
  switch (key) {
    case 'month':
      return monthRange(0);
    case 'lastMonth':
      return monthRange(-1);
    case 'quarter': {
      const q = Math.floor(n.getMonth() / 3) * 3;
      return [ymd(new Date(n.getFullYear(), q, 1)), ymd(new Date(n.getFullYear(), q + 3, 0))];
    }
    default:
      return [ymd(new Date(n.getFullYear(), 0, 1)), ymd(new Date(n.getFullYear(), 11, 31))];
  }
}
