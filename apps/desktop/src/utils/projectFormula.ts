/**
 * 项目金额公式（全部用整数分 + 整数「万分位」费率运算，不使用浮点）：
 *   企信实收       = 合同价 × 0.8（固定）
 *   企信支付下家分包费 = 按「分包费计算方法」：固定费率 = 企信实收 × 分包费率（默认 0.75，可维护）；自定义 = 用户填写的金额（默认 0）
 *   陈沛           = 企信实收 × 0.05（固定）
 *   企信利润       = 企信实收 − 企信支付下家分包费 − 陈沛
 */

/** 费率以「万分位」整数保存：0.8 -> 8000，0.75 -> 7500 */
export type SubcontractMode = 'rate' | 'custom';

export const SUBCONTRACT_MODES: { value: SubcontractMode; label: string }[] = [
  { value: 'rate', label: '固定费率' },
  { value: 'custom', label: '自定义' }
];

export interface FormulaRates {
  /** 下家分包费计算方法 */
  subcontractMode: SubcontractMode;
  /** 固定费率（万分位整数） */
  subcontractRate: number;
  /** 自定义分包费（整数分） */
  subcontractCustom: number;
}

export const QX_RECEIVED_RATE = 8000; // 0.8，固定不可改
export const CHEN_PEI_RATE = 500; // 0.05，固定不可改
export const RATE_SCALE = 10000;
export const DEFAULT_RATES: FormulaRates = { subcontractMode: 'rate', subcontractRate: 7500, subcontractCustom: 0 };

const STORAGE_KEY = 'fm.projectFormulaRates';

/** 费率文本（如 "0.8"）-> 万分位整数；非法（非 0~1 之间、超过 4 位小数）返回 null */
export function parseRate(text: string): number | null {
  const t = String(text ?? '').trim();
  if (!/^(0|1)(\.\d{1,4})?$|^\.\d{1,4}$/.test(t)) return null;
  const [i = '0', f = ''] = t.split('.');
  const v = Number(i || '0') * RATE_SCALE + Number(f.padEnd(4, '0'));
  return v >= 0 && v <= RATE_SCALE ? v : null;
}

/** 万分位整数 -> 费率文本，去掉多余的 0：8000 -> "0.8"，7500 -> "0.75"，10000 -> "1" */
export function rateToText(rate: number): string {
  const i = Math.floor(rate / RATE_SCALE);
  const f = String(rate % RATE_SCALE).padStart(4, '0').replace(/0+$/, '');
  return f ? `${i}.${f}` : String(i);
}

export function loadRates(): FormulaRates {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<FormulaRates> | null;
    const ok = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= RATE_SCALE;
    if (raw) {
      return {
        subcontractMode: raw.subcontractMode === 'custom' ? 'custom' : 'rate',
        subcontractRate: ok(raw.subcontractRate) ? raw.subcontractRate : DEFAULT_RATES.subcontractRate,
        subcontractCustom:
          Number.isSafeInteger(raw.subcontractCustom) && (raw.subcontractCustom as number) >= 0 ? (raw.subcontractCustom as number) : 0
      };
    }
  } catch {
    /* 读取失败使用默认值 */
  }
  return { ...DEFAULT_RATES };
}

export function saveRates(rates: FormulaRates): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(rates));
}

/** 整数分 × 万分位费率，四舍五入到整数分（纯整数运算；金额非负） */
export function applyRate(cents: number, rate: number): number {
  return Math.floor((cents * rate + RATE_SCALE / 2) / RATE_SCALE);
}

export interface FormulaResult {
  qxReceived: number;
  qxSubcontractFee: number;
  chenPei: number;
  qxProfit: number;
}

/** 由合同价（整数分）按公式算出四个金额（整数分） */
export function calcFromContractPrice(contractPrice: number, rates: FormulaRates): FormulaResult {
  const qxReceived = applyRate(contractPrice, QX_RECEIVED_RATE);
  const qxSubcontractFee =
    rates.subcontractMode === 'custom' ? rates.subcontractCustom : applyRate(qxReceived, rates.subcontractRate);
  const chenPei = applyRate(qxReceived, CHEN_PEI_RATE);
  return { qxReceived, qxSubcontractFee, chenPei, qxProfit: qxReceived - qxSubcontractFee - chenPei };
}
