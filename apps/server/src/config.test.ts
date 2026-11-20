import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, parsePort } from './config';

describe('parsePort', () => {
  it('未设置或空白时使用默认端口', () => {
    expect(parsePort(undefined)).toBe(DEFAULT_PORT);
    expect(parsePort('')).toBe(DEFAULT_PORT);
    expect(parsePort('  ')).toBe(DEFAULT_PORT);
  });

  it('接受合法端口（含 Tauri 随机分配的高位端口）', () => {
    expect(parsePort('1')).toBe(1);
    expect(parsePort('51234')).toBe(51234);
    expect(parsePort('65535')).toBe(65535);
  });

  it('非法值直接报错，而不是得到 NaN', () => {
    expect(() => parsePort('abc')).toThrow(/FM_PORT/);
    expect(() => parsePort('0')).toThrow();
    expect(() => parsePort('65536')).toThrow();
    expect(() => parsePort('-1')).toThrow();
    expect(() => parsePort('80.5')).toThrow();
  });
});
