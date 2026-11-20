/**
 * 金额工具：全系统以「整数分」存储和计算，禁止使用浮点数。
 */

const MONEY_RE = /^[+-]?\d+(\.\d{1,2})?$/;

/** 把用户输入/Excel 单元格的金额转为整数分。非法输入抛错。 */
export function toCents(input: string | number): number {
  let text: string;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`非法金额: ${input}`);
    // 先按 2 位小数四舍五入后转字符串，规避 0.1+0.2 一类的浮点误差
    text = (Math.round(input * 100) / 100).toFixed(2);
  } else {
    text = input.trim().replace(/[,\s¥￥]/g, '');
  }
  if (!MONEY_RE.test(text)) throw new Error(`非法金额: ${String(input)}`);

  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [intPart = '0', fracPart = ''] = unsigned.split('.');
  const cents = Number(intPart) * 100 + Number(fracPart.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error(`金额超出范围: ${String(input)}`);
  return negative ? -cents : cents;
}

/** 整数分 -> "1234.56" */
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`金额必须是整数分: ${cents}`);
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const fen = String(abs % 100).padStart(2, '0');
  return `${sign}${yuan}.${fen}`;
}

/** 整数分 -> "¥1,234.56"，用于展示 */
export function formatMoney(cents: number, symbol = '¥'): string {
  const raw = fromCents(cents);
  const negative = raw.startsWith('-');
  const [i = '0', f = '00'] = raw.replace('-', '').split('.');
  const grouped = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '-' : ''}${symbol}${grouped}.${f}`;
}
