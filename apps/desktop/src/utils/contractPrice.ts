import { toCents } from './format';

/** 单个项目合同价上限（元）：100 亿，远小于整数分的安全范围，同时能拦住明显的误输入 */
export const MAX_CONTRACT_PRICE_YUAN = 10_000_000_000;

const PRICE_RE = /^\d+(\.\d{1,2})?$/;

/**
 * 校验一个「合同价」输入（元，字符串）。合法返回 null，否则返回具体的错误原因。
 * 只接受非负、最多两位小数的纯数字；拒绝空值、负数、科学计数法、千分位、多个小数点、超长/超大数字等。
 */
export function validateContractPrice(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return '请输入合同价';
  if (v.startsWith('-')) return '合同价不能为负数';
  if (!PRICE_RE.test(v)) return '合同价格式不正确，只能是数字，最多两位小数';
  // 只比较整数部分，避免大数字走浮点
  const intPart = v.split('.')[0]!.replace(/^0+(?=\d)/, '');
  if (intPart.length > String(MAX_CONTRACT_PRICE_YUAN).length || (intPart.length === String(MAX_CONTRACT_PRICE_YUAN).length && intPart > String(MAX_CONTRACT_PRICE_YUAN))) {
    return '合同价过大，请检查是否多输了位数';
  }
  return null;
}

/** 合同价（元，已通过 validateContractPrice）转整数分 */
export function contractPriceToCents(raw: string): number {
  return toCents(raw.trim());
}

/** 若干项目合同价求和（整数分）；任一价格不合法或总价超出安全整数范围时返回 null */
export function sumContractPrices(raws: Array<string | undefined>): number | null {
  let sum = 0;
  for (const r of raws) {
    if (validateContractPrice(r) !== null) return null;
    sum += contractPriceToCents(r!);
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}
