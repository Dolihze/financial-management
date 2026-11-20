import { describe, expect, it } from 'vitest';
import { formatMoney, fromCents, toCents } from './money';

describe('money', () => {
  it('toCents 处理字符串与浮点误差', () => {
    expect(toCents('12.34')).toBe(1234);
    expect(toCents('1,234.5')).toBe(123450);
    expect(toCents('¥-0.07')).toBe(-7);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(19.99)).toBe(1999);
  });

  it('toCents 拒绝非法输入', () => {
    expect(() => toCents('abc')).toThrow();
    expect(() => toCents('1.234')).toThrow();
    expect(() => toCents(NaN)).toThrow();
  });

  it('fromCents / formatMoney', () => {
    expect(fromCents(5)).toBe('0.05');
    expect(fromCents(-123456)).toBe('-1234.56');
    expect(formatMoney(123456789)).toBe('¥1,234,567.89');
    expect(formatMoney(-50)).toBe('-¥0.50');
  });
});
