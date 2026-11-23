/** 批次号上限，与后端 MAX_BATCH_NO 保持一致 */
export const MAX_BATCH_NO = 100_000;

/**
 * 校验批次号输入（字符串）。合法返回 null，否则返回具体原因。
 * 只接受 1 ~ MAX_BATCH_NO 的正整数：拒绝空值、0、负数、小数、科学计数法、带空格/字母、前导零之外的怪异写法。
 */
export function validateBatchNo(raw: string | undefined): string | null {
  const v = (raw ?? '').trim();
  if (!v) return '请输入批次号';
  if (!/^\d+$/.test(v)) return '批次号只能是正整数';
  const n = Number(v);
  if (n < 1) return '批次号必须从 1 开始';
  if (n > MAX_BATCH_NO) return `批次号不能超过 ${MAX_BATCH_NO}`;
  return null;
}
