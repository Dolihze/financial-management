import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from './app';

let ctx: BuiltApp;

beforeEach(async () => {
  ctx = await buildApp({ host: '127.0.0.1', port: 0, dbPath: ':memory:', deviceId: 'test' });
});
afterEach(async () => {
  await ctx.app.close();
});

async function post(url: string, payload: unknown) {
  return ctx.app.inject({ method: 'POST', url, payload: payload as object });
}

async function makeAccount(name: string, openingBalance = 0) {
  const res = await post('/api/accounts', { name, type: 'bank', openingBalance });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(['日期', '类型', '金额', '摘要', '账户', '分类', '往来单位', '备注']);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function multipart(file: Buffer, filename = 'a.xlsx') {
  const boundary = '----fmtest';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, file, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
}

describe('账户与余额', () => {
  it('余额 = 期初 + 流水，转账不改变总余额', async () => {
    const a = await makeAccount('银行A', 100_000);
    const b = await makeAccount('现金', 0);

    await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', summary: '回款', amount: 50_000, accountId: a.id });
    await post('/api/transactions', { occurredOn: '2026-01-11', type: 'expense', summary: '采购', amount: 20_000, accountId: a.id });
    await post('/api/transactions', { occurredOn: '2026-01-12', type: 'transfer', summary: '取现', amount: 30_000, fromAccountId: a.id, toAccountId: b.id });

    const accounts = (await ctx.app.inject({ url: '/api/accounts' })).json() as Array<{ name: string; balance: number }>;
    expect(accounts.find((x) => x.name === '银行A')!.balance).toBe(100_000 + 50_000 - 20_000 - 30_000);
    expect(accounts.find((x) => x.name === '现金')!.balance).toBe(30_000);

    const overview = (await ctx.app.inject({ url: '/api/overview' })).json() as { totalBalance: number };
    expect(overview.totalBalance).toBe(100_000 + 50_000 - 20_000);

    const integrity = (await ctx.app.inject({ url: '/api/overview/integrity' })).json() as { ok: boolean };
    expect(integrity.ok).toBe(true);
  });

  it('作废交易后余额回退，且记录仍保留', async () => {
    const a = await makeAccount('银行A', 0);
    const tx = (await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', summary: '回款', amount: 8_800, accountId: a.id })).json() as { id: string };

    const voided = await post(`/api/transactions/${tx.id}/void`, { reason: '录错' });
    expect(voided.statusCode).toBe(200);
    expect((await ctx.app.inject({ url: `/api/accounts/${a.id}` })).json()).toMatchObject({ balance: 0 });

    const withVoided = (await ctx.app.inject({ url: '/api/transactions?includeVoided=true' })).json() as { total: number };
    expect(withVoided.total).toBe(1);
    expect(((await ctx.app.inject({ url: '/api/transactions' })).json() as { total: number }).total).toBe(0);

    expect((await post(`/api/transactions/${tx.id}/void`, {})).statusCode).toBe(409);
  });

  it('校验：金额必须为正整数分，转账不能同账户，余额非 0 不能归档', async () => {
    const a = await makeAccount('银行A', 100);
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', summary: 'x', amount: 12.5, accountId: a.id })).statusCode).toBe(400);
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'transfer', summary: 'x', amount: 100, fromAccountId: a.id, toAccountId: a.id })).statusCode).toBe(400);
    expect((await post(`/api/accounts/${a.id}/archive`, {})).statusCode).toBe(409);
  });
});

describe('Excel 导入', () => {
  it('预览 -> 提交 -> 重复检测 -> 撤销', async () => {
    const acc = await makeAccount('招商银行', 0);
    const file = await xlsx([
      ['2026-02-01', '收入', 1000.5, '货款', '招商银行', '主营业务收入', 'A公司', ''],
      ['2026-02-02', '支出', '200', '办公用品', '招商银行', '办公费', '', '']
    ]);

    const m = multipart(file);
    const preview = (await ctx.app.inject({ method: 'POST', url: '/api/imports/preview', ...m })).json() as { valid: number; errors: unknown[] };
    expect(preview.valid).toBe(2);
    expect(preview.errors).toHaveLength(0);

    const commit = await ctx.app.inject({ method: 'POST', url: '/api/imports/commit', ...m });
    expect(commit.statusCode).toBe(201);
    const batch = commit.json() as { id: string; importedCount: number };
    expect(batch.importedCount).toBe(2);
    expect((await ctx.app.inject({ url: `/api/accounts/${acc.id}` })).json()).toMatchObject({ balance: 100_050 - 20_000 });

    // 同一文件再次导入被拒绝
    expect((await ctx.app.inject({ method: 'POST', url: '/api/imports/commit', ...m })).statusCode).toBe(409);

    // 内容相同但文件不同（多一行）：重复行被检测到
    const file2 = await xlsx([
      ['2026-02-01', '收入', 1000.5, '货款', '招商银行', '主营业务收入', 'A公司', ''],
      ['2026-02-03', '收入', 300, '新货款', '招商银行', '', '', '']
    ]);
    const m2 = multipart(file2, 'b.xlsx');
    expect((await ctx.app.inject({ method: 'POST', url: '/api/imports/commit', ...m2 })).statusCode).toBe(409);
    const skip = await ctx.app.inject({ method: 'POST', url: '/api/imports/commit?skipDuplicates=true', ...m2 });
    expect(skip.statusCode).toBe(201);
    expect((skip.json() as { importedCount: number }).importedCount).toBe(1);

    // 撤销第一批
    const revert = await post(`/api/imports/${batch.id}/revert`, {});
    expect(revert.statusCode).toBe(200);
    expect((await ctx.app.inject({ url: `/api/accounts/${acc.id}` })).json()).toMatchObject({ balance: 30_000 });
  });

  it('有错误行时拒绝导入且不写入任何数据', async () => {
    await makeAccount('招商银行', 0);
    const file = await xlsx([
      ['2026-02-01', '收入', 100, '正常行', '招商银行', '', '', ''],
      ['not-a-date', '收入', 100, '坏日期', '招商银行', '', '', ''],
      ['2026-02-03', '支出', 100, '坏账户', '不存在的账户', '', '', '']
    ]);
    const m = multipart(file);
    const preview = (await ctx.app.inject({ method: 'POST', url: '/api/imports/preview', ...m })).json() as { errors: unknown[] };
    expect(preview.errors).toHaveLength(2);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/imports/commit', ...m })).statusCode).toBe(422);
    expect(((await ctx.app.inject({ url: '/api/transactions' })).json() as { total: number }).total).toBe(0);
  });
});
