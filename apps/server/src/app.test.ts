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
  const res = await post('/api/accounts', { name, type: 'bank', bankName: '测试银行', accountNo: '6222000011112222', openingBalance });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

async function xlsx(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(['日期', '类型', '金额', '账户', '分类', '往来单位', '备注']);
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

describe('账户类型与字段', () => {
  it('银行账户保存开户银行和银行卡号，缺少时返回 400', async () => {
    const ok = await post('/api/accounts', { name: '招行', type: 'bank', bankName: '招商银行', accountNo: '6225880000008826', openingBalance: 1000, note: '主户' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ type: 'bank', bankName: '招商银行', accountNo: '6225880000008826', openingBalance: 1000, balance: 1000, note: '主户' });

    expect((await post('/api/accounts', { name: '缺银行', type: 'bank', accountNo: '123' })).statusCode).toBe(400);
    expect((await post('/api/accounts', { name: '缺账号', type: 'bank', bankName: '招商银行' })).statusCode).toBe(400);
  });

  it('支付宝/微信账户只需名称、余额、备注，银行信息被忽略', async () => {
    const ali = await post('/api/accounts', { name: '支付宝企业', type: 'alipay', openingBalance: 500, note: '线上', bankName: '不应保存', accountNo: '999' });
    expect(ali.statusCode).toBe(201);
    expect(ali.json()).toMatchObject({ type: 'alipay', bankName: '', accountNo: '', balance: 500, note: '线上' });

    const wx = await post('/api/accounts', { name: '微信商户', type: 'wechat' });
    expect(wx.statusCode).toBe(201);
    expect(wx.json()).toMatchObject({ type: 'wechat', bankName: '', accountNo: '', balance: 0 });
  });
});

describe('账户类型限制', () => {
  it('只允许银行账户/支付宝/微信，已移除的类型返回 400', async () => {
    for (const type of ['cash', 'receivable', 'payable', 'other']) {
      expect((await post('/api/accounts', { name: `旧-${type}`, type })).statusCode).toBe(400);
    }
  });
});

describe('账户与余额', () => {
  it('余额 = 期初 + 流水；借款(借出)减少余额，贷款(借入)增加余额，且不计入收支统计', async () => {
    const a = await makeAccount('银行A', 100_000);
    const b = await makeAccount('现金', 0);

    const day = new Date().toISOString().slice(0, 8) + '01'; // 本月 1 号，保证落在「本月」统计内
    await post('/api/transactions', { occurredOn: day, type: 'income', amount: 50_000, accountId: a.id });
    await post('/api/transactions', { occurredOn: day, type: 'expense', amount: 20_000, accountId: a.id });
    const borrow = await post('/api/transactions', { occurredOn: day, type: 'borrow', amount: 30_000, accountId: a.id, counterpartyId: ((await post('/api/counterparties', { name: '张三' })).json() as { id: string }).id });
    expect(borrow.statusCode).toBe(201);
    expect((borrow.json() as { lines: Array<{ amount: number }> }).lines).toMatchObject([{ amount: -30_000 }]);
    const loan = await post('/api/transactions', { occurredOn: day, type: 'loan', amount: 200_000, accountId: b.id });
    expect(loan.statusCode).toBe(201);
    expect((loan.json() as { lines: Array<{ amount: number }> }).lines).toMatchObject([{ amount: 200_000 }]);

    const accounts = (await ctx.app.inject({ url: '/api/accounts' })).json() as Array<{ name: string; balance: number }>;
    expect(accounts.find((x) => x.name === '银行A')!.balance).toBe(100_000 + 50_000 - 20_000 - 30_000);
    expect(accounts.find((x) => x.name === '现金')!.balance).toBe(200_000);

    const overview = (await ctx.app.inject({ url: '/api/overview' })).json() as { totalBalance: number; monthIncome: number; monthExpense: number };
    expect(overview.totalBalance).toBe(100_000 + 50_000 - 20_000 - 30_000 + 200_000);
    expect(overview.monthIncome).toBe(50_000);
    expect(overview.monthExpense).toBe(20_000);

    const integrity = (await ctx.app.inject({ url: '/api/overview/integrity' })).json() as { ok: boolean };
    expect(integrity.ok).toBe(true);

    // 按类型筛选
    const onlyLoan = (await ctx.app.inject({ url: '/api/transactions?type=loan' })).json() as { total: number };
    expect(onlyLoan.total).toBe(1);
  });

  it('转账类型已移除，借款/贷款必须指定账户', async () => {
    const a = await makeAccount('银行A', 100_000);
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'transfer', amount: 100, accountId: a.id })).statusCode).toBe(400);
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'borrow', amount: 100 })).statusCode).toBe(400);
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'loan', amount: 100 })).statusCode).toBe(400);
  });

  it('作废交易后余额回退，且记录仍保留', async () => {
    const a = await makeAccount('银行A', 0);
    const tx = (await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', amount: 8_800, accountId: a.id })).json() as { id: string };

    const voided = await post(`/api/transactions/${tx.id}/void`, { reason: '录错' });
    expect(voided.statusCode).toBe(200);
    expect((await ctx.app.inject({ url: `/api/accounts/${a.id}` })).json()).toMatchObject({ balance: 0 });

    const withVoided = (await ctx.app.inject({ url: '/api/transactions?includeVoided=true' })).json() as { total: number };
    expect(withVoided.total).toBe(1);
    expect(((await ctx.app.inject({ url: '/api/transactions' })).json() as { total: number }).total).toBe(0);

    expect((await post(`/api/transactions/${tx.id}/void`, {})).statusCode).toBe(409);
  });

  it('校验：金额必须为正整数分，余额非 0 不能归档', async () => {
    const a = await makeAccount('银行A', 100);
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', amount: 12.5, accountId: a.id })).statusCode).toBe(400);
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'borrow', amount: 12.5, accountId: a.id })).statusCode).toBe(400);
    expect((await post(`/api/accounts/${a.id}/archive`, {})).statusCode).toBe(409);
  });
});

describe('Excel 导入', () => {
  it('预览 -> 提交 -> 重复检测 -> 撤销', async () => {
    const acc = await makeAccount('招商银行', 0);
    const file = await xlsx([
      ['2026-02-01', '收入', 1000.5, '招商银行', '其他收入', 'A公司', ''],
      ['2026-02-02', '支出', '200', '招商银行', '经营费', '', '']
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
      ['2026-02-01', '收入', 1000.5, '招商银行', '其他收入', 'A公司', ''],
      ['2026-02-03', '收入', 300, '招商银行', '', '', '']
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
      ['2026-02-01', '收入', 100, '招商银行', '', '', ''],
      ['not-a-date', '收入', 100, '招商银行', '', '', ''],
      ['2026-02-03', '支出', 100, '不存在的账户', '', '', '']
    ]);
    const m = multipart(file);
    const preview = (await ctx.app.inject({ method: 'POST', url: '/api/imports/preview', ...m })).json() as { errors: unknown[] };
    expect(preview.errors).toHaveLength(2);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/imports/commit', ...m })).statusCode).toBe(422);
    expect(((await ctx.app.inject({ url: '/api/transactions' })).json() as { total: number }).total).toBe(0);
  });
});

async function patchJson(url: string, payload: unknown) {
  return ctx.app.inject({ method: 'PATCH', url, payload: payload as object });
}

describe('收入分类管理', () => {
  const incomeCats = async () =>
    ((await ctx.app.inject({ url: '/api/categories' })).json() as Array<{ id: string; name: string; kind: string; builtin: boolean }>).filter(
      (c) => c.kind === 'income'
    );

  it('默认只有内置的「其他收入」', async () => {
    const list = await incomeCats();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: '其他收入', builtin: true });
  });

  it('可新增、重命名自定义分类；重名被拒绝；内置分类不可编辑', async () => {
    const created = await post('/api/categories', { name: '咨询收入', kind: 'income' });
    expect(created.statusCode).toBe(201);
    const cat = created.json() as { id: string; builtin: boolean };
    expect(cat.builtin).toBe(false);

    expect((await post('/api/categories', { name: '咨询收入', kind: 'income' })).statusCode).toBe(409);

    const renamed = await patchJson(`/api/categories/${cat.id}`, { name: '顾问收入' });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ name: '顾问收入' });

    // 与已有分类重名
    expect((await patchJson(`/api/categories/${cat.id}`, { name: '其他收入' })).statusCode).toBe(409);
    // 空名称
    expect((await patchJson(`/api/categories/${cat.id}`, { name: '  ' })).statusCode).toBe(400);

    const builtin = (await incomeCats()).find((c) => c.builtin)!;
    expect((await patchJson(`/api/categories/${builtin.id}`, { name: '改名' })).statusCode).toBe(403);
    expect((await patchJson('/api/categories/nope', { name: 'x' })).statusCode).toBe(404);
  });

  it('重命名后历史流水显示新名称，并写入审计', async () => {
    const a = await makeAccount('银行A', 0);
    const cat = (await post('/api/categories', { name: '咨询收入', kind: 'income' })).json() as { id: string };
    await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', amount: 100, accountId: a.id, categoryId: cat.id });
    await patchJson(`/api/categories/${cat.id}`, { name: '顾问收入' });

    const items = ((await ctx.app.inject({ url: '/api/transactions' })).json() as { items: Array<{ categoryName: string }> }).items;
    expect(items[0]!.categoryName).toBe('顾问收入');
    const audit = ctx.db.prepare("SELECT action FROM audit_log WHERE entity='category' AND entity_id=? ORDER BY created_at").all(cat.id);
    expect(audit).toEqual([{ action: 'create' }, { action: 'update' }]);
  });
});
describe('删除收入分类（归档式）', () => {
  const del = (id: string) => ctx.app.inject({ method: 'DELETE', url: `/api/categories/${id}` });
  const incomeCats = async () =>
    ((await ctx.app.inject({ url: '/api/categories' })).json() as Array<{ id: string; name: string; kind: string; builtin: boolean; usageCount: number }>).filter(
      (c) => c.kind === 'income'
    );

  it('未使用的分类可删除：从列表消失，名称仍被占用，写审计，不能再编辑/重复删除', async () => {
    const cat = (await post('/api/categories', { name: '咨询收入', kind: 'income' })).json() as { id: string };
    const res = await del(cat.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ movedTransactions: 0 });

    expect((await incomeCats()).map((c) => c.name)).toEqual(['其他收入']);
    // 行仍保留（不物理删除）
    expect(ctx.db.prepare('SELECT archived FROM category WHERE id = ?').get(cat.id)).toEqual({ archived: 1 });
    expect(ctx.db.prepare("SELECT action FROM audit_log WHERE entity='category' AND entity_id=? ORDER BY created_at").all(cat.id)).toEqual([
      { action: 'create' },
      { action: 'delete' }
    ]);
    expect((await post('/api/categories', { name: '咨询收入', kind: 'income' })).statusCode).toBe(409);
    expect((await del(cat.id)).statusCode).toBe(404);
    expect((await patchJson(`/api/categories/${cat.id}`, { name: 'x' })).statusCode).toBe(404);
  });

  it('已被流水使用的分类删除后，流水（含已作废）改挂「其他收入」，余额不变', async () => {
    const a = await makeAccount('银行A', 0);
    const cat = (await post('/api/categories', { name: '咨询收入', kind: 'income' })).json() as { id: string };
    const t1 = (await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', amount: 100, accountId: a.id, categoryId: cat.id })).json() as { id: string };
    await post('/api/transactions', { occurredOn: '2026-01-11', type: 'income', amount: 200, accountId: a.id, categoryId: cat.id });
    await post(`/api/transactions/${t1.id}/void`, {});

    expect((await incomeCats()).find((c) => c.id === cat.id)!.usageCount).toBe(2);
    const res = await del(cat.id);
    expect(res.json()).toEqual({ movedTransactions: 2 });

    const items = ((await ctx.app.inject({ url: '/api/transactions?includeVoided=true' })).json() as { items: Array<{ categoryName: string }> }).items;
    expect(items.map((i) => i.categoryName)).toEqual(['其他收入', '其他收入']);
    expect(((await ctx.app.inject({ url: `/api/accounts/${a.id}` })).json() as { balance: number }).balance).toBe(200);
  });

  it('内置分类不可删除；不存在的分类 404', async () => {
    const builtin = (await incomeCats()).find((c) => c.builtin)!;
    expect((await del(builtin.id)).statusCode).toBe(403);
    expect((await del('nope')).statusCode).toBe(404);
  });
});
describe('往来单位管理', () => {
  const del = (id: string) => ctx.app.inject({ method: 'DELETE', url: `/api/counterparties/${id}` });
  const list = async () => (await ctx.app.inject({ url: '/api/counterparties' })).json() as Array<{ id: string; name: string; usageCount: number }>;
  const mk = async (name: string) => (await post('/api/counterparties', { name })).json() as { id: string };

  it('新增、重命名、重名与空名校验', async () => {
    const cp = await mk('杭州云岚');
    expect((await post('/api/counterparties', { name: '杭州云岚' })).statusCode).toBe(409);
    expect((await post('/api/counterparties', { name: '  ' })).statusCode).toBe(400);

    const renamed = await patchJson(`/api/counterparties/${cp.id}`, { name: '云岚科技' });
    expect(renamed.json()).toMatchObject({ name: '云岚科技' });
    const other = await mk('深圳启明');
    expect((await patchJson(`/api/counterparties/${other.id}`, { name: '云岚科技' })).statusCode).toBe(409);
    expect((await patchJson('/api/counterparties/nope', { name: 'x' })).statusCode).toBe(404);
  });

  it('流水关联往来单位；重命名后流水名称同步；按往来单位筛选', async () => {
    const a = await makeAccount('银行A', 0);
    const cp = await mk('杭州云岚');
    const tx = (await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', amount: 100, accountId: a.id, counterpartyId: cp.id })).json() as {
      counterpartyId: string;
      counterparty: string;
    };
    expect(tx).toMatchObject({ counterpartyId: cp.id, counterparty: '杭州云岚' });

    await patchJson(`/api/counterparties/${cp.id}`, { name: '云岚科技' });
    const items = ((await ctx.app.inject({ url: `/api/transactions?counterpartyId=${cp.id}` })).json() as { items: Array<{ counterparty: string }> }).items;
    expect(items.map((i) => i.counterparty)).toEqual(['云岚科技']);
    expect((await list()).find((c) => c.id === cp.id)!.usageCount).toBe(1);

    // 不存在的往来单位被拒绝
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', amount: 100, accountId: a.id, counterpartyId: 'nope' })).statusCode).toBe(404);
  });

  it('归档式删除：流水解除关联但保留名称快照，名称仍被占用，写审计', async () => {
    const a = await makeAccount('银行A', 0);
    const cp = await mk('杭州云岚');
    await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', amount: 100, accountId: a.id, counterpartyId: cp.id });

    const res = await del(cp.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ unlinkedTransactions: 1 });

    expect(await list()).toEqual([]);
    const items = ((await ctx.app.inject({ url: '/api/transactions' })).json() as { items: Array<{ counterparty: string; counterpartyId: string | null }> }).items;
    expect(items[0]).toMatchObject({ counterparty: '杭州云岚', counterpartyId: null });
    expect(ctx.db.prepare('SELECT archived FROM counterparty WHERE id = ?').get(cp.id)).toEqual({ archived: 1 });
    expect(ctx.db.prepare("SELECT action FROM audit_log WHERE entity='counterparty' AND entity_id=? ORDER BY created_at").all(cp.id)).toEqual([
      { action: 'create' },
      { action: 'delete' }
    ]);
    expect((await post('/api/counterparties', { name: '杭州云岚' })).statusCode).toBe(409);
    expect((await del(cp.id)).statusCode).toBe(404);
    expect((await post('/api/transactions', { occurredOn: '2026-01-10', type: 'income', amount: 100, accountId: a.id, counterpartyId: cp.id })).statusCode).toBe(404);
  });

  it('Excel 导入：往来单位按名称匹配已有，不存在则自动创建；预览不写库', async () => {
    await makeAccount('招商银行', 0);
    const existing = await mk('A公司');
    const file = await xlsx([
      ['2026-02-01', '收入', 100, '招商银行', '其他收入', 'A公司', ''],
      ['2026-02-02', '收入', 200, '招商银行', '', 'B公司', ''],
      ['2026-02-03', '收入', 300, '招商银行', '', 'B公司', '']
    ]);
    const m = multipart(file);
    await ctx.app.inject({ method: 'POST', url: '/api/imports/preview', ...m });
    expect((await list()).map((c) => c.name)).toEqual(['A公司']); // 预览不创建

    expect((await ctx.app.inject({ method: 'POST', url: '/api/imports/commit', ...m })).statusCode).toBe(201);
    const cps = await list();
    expect(cps.map((c) => c.name)).toEqual(['A公司', 'B公司']);
    expect(cps.find((c) => c.id === existing.id)!.usageCount).toBe(1);
    expect(cps.find((c) => c.name === 'B公司')!.usageCount).toBe(2);
  });
});
describe('支出分类管理', () => {
  const cats = async () =>
    (await ctx.app.inject({ url: '/api/categories' })).json() as Array<{ id: string; name: string; kind: string; builtin: boolean }>;
  const expenseCats = async () => (await cats()).filter((c) => c.kind === 'expense');
  const del = (id: string) => ctx.app.inject({ method: 'DELETE', url: `/api/categories/${id}` });

  it('默认只有 7 个内置支出分类，且全部锁定（不可编辑/删除）', async () => {
    const list = await expenseCats();
    expect(list.map((c) => c.name).sort()).toEqual(['工资薪酬', '社保', '差旅费', '房租水电', '经营费', '员工报销', '其他支出'].sort());
    expect(list.every((c) => c.builtin)).toBe(true);
    for (const c of list) {
      expect((await patchJson(`/api/categories/${c.id}`, { name: '改名' })).statusCode).toBe(403);
      expect((await del(c.id)).statusCode).toBe(403);
    }
  });

  it('可新增支出分类并编辑；重名按类型区分；删除后流水改挂「其他支出」而非「其他收入」', async () => {
    const a = await makeAccount('银行A', 1000);
    const created = await post('/api/categories', { name: '培训费', kind: 'expense' });
    expect(created.statusCode).toBe(201);
    const cat = created.json() as { id: string; builtin: boolean };
    expect(cat.builtin).toBe(false);
    expect((await post('/api/categories', { name: '培训费', kind: 'expense' })).statusCode).toBe(409);
    expect((await post('/api/categories', { name: '培训费', kind: 'income' })).statusCode).toBe(201); // 收入同名不冲突

    expect((await patchJson(`/api/categories/${cat.id}`, { name: '培训支出' })).json()).toMatchObject({ name: '培训支出' });

    await post('/api/transactions', { occurredOn: '2026-01-10', type: 'expense', amount: 100, accountId: a.id, categoryId: cat.id });
    expect((await del(cat.id)).json()).toEqual({ movedTransactions: 1 });
    const items = ((await ctx.app.inject({ url: '/api/transactions' })).json() as { items: Array<{ categoryName: string }> }).items;
    expect(items[0]!.categoryName).toBe('其他支出');
    expect((await expenseCats()).map((c) => c.name)).not.toContain('培训支出');
  });
});