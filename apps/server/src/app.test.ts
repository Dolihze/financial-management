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

const PROJECT_HEADERS = ['合同编号', '批次', '区域', '项目名称', '合同价', '企信实收', '企信支付下家分包费', '陈沛', '企信利润', '项目结算', '支付下家', '支付陈沛', '备注'];

/** 项目导入 Excel：第 1 行表头，第 2 行合计（项目名称为「合计」），之后为数据 */
async function projectXlsx(rows: unknown[][], headers: string[] = PROJECT_HEADERS): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(headers);
  // 合计行按表头名放置（项目名称 = 合计，金额列填数字），不依赖列顺序
  const sum: Record<string, unknown> = { 项目名称: '合计', 合同价: 999999, 企信实收: 999999, 企信支付下家分包费: 999999, 陈沛: 999999, 企信利润: 999999 };
  ws.addRow(headers.map((h) => sum[h] ?? ''));
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('项目管理（Excel 导入）', () => {
  const importUrl = (action: 'preview' | 'commit') => `/api/projects/import/${action}`;

  it('忽略合计行；金额转整数分；是否字段仅「是」为真，其他一律为否', async () => {
    const m = multipart(
      await projectXlsx([
        ['HT-001', '第15批', '华东', '办公楼装修', 1000000.5, '800,000', 400000, 50000, 200000, '是', '是', '否'],
        ['HT-002', 15, '华南', '展厅设计', 500000, 200000, 200000, 50000, 100000, '否', '已付', ''],
        ['HT-003', '', '', '仓库改造', null, null, null, null, null, 'yes', '是 ', '√']
      ])
    );
    const preview = (await ctx.app.inject({ method: 'POST', url: importUrl('preview'), ...m })).json() as Record<string, unknown>;
    expect(preview).toMatchObject({ total: 3, toCreate: 3, toUpdate: 0, errors: [] });

    const commit = await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m });
    expect(commit.statusCode).toBe(201);
    expect(commit.json()).toEqual({ total: 3, created: 3, updated: 0, skippedPosted: 0 });

    const list = (await ctx.app.inject({ url: '/api/projects' })).json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3); // 合计行没有被导入
    const by = (no: string) => list.find((p) => p.contractNo === no)!;
    expect(by('HT-001')).toMatchObject({
      batchNo: 15, region: '华东', name: '办公楼装修',
      contractPrice: 100_000_050, qxReceived: 80_000_000, qxSubcontractFee: 40_000_000, chenPei: 5_000_000, qxProfit: 20_000_000,
      qxMoneyReceived: true, paidSubcontractor: true, paidChenPei: false
    });
    expect(by('HT-002')).toMatchObject({ qxMoneyReceived: false, paidSubcontractor: false, paidChenPei: false });
    // 空金额按 0；「yes」「√」等非「是」内容按否；「是 」去掉空白后为是
    expect(by('HT-003')).toMatchObject({
      contractPrice: 0, qxReceived: 0, qxProfit: 0, qxMoneyReceived: false, paidSubcontractor: true, paidChenPei: false
    });

    const id = by('HT-001').id as string;
    expect((await ctx.app.inject({ url: `/api/projects/${id}` })).json()).toMatchObject({ id, contractNo: 'HT-001' });
    expect((await ctx.app.inject({ url: '/api/projects/nope' })).statusCode).toBe(404);
  });

  it('以项目名称为唯一键：同名则更新（含合同编号），不同名则新增，合同编号可重复', async () => {
    await ctx.app.inject({
      method: 'POST', url: importUrl('commit'),
      ...multipart(await projectXlsx([['HT-001', '第14批', '华东', '项目甲', 100, 0, 0, 0, 0, '否', '否', '否']]))
    });
    const m2 = multipart(
      await projectXlsx([
        ['HT-009', ' 第 15 批 ', '华北', '项目甲', 200, 150, 0, 0, 50, '是', '否', '否'], // 同名 -> 更新，合同编号随之更新
        ['HT-001', '', '', '项目乙', 300, 0, 0, 0, 0, '否', '否', '否'], // 合同编号与库里已有的相同，但名称不同 -> 新增
        ['HT-001', '', '', '项目丙', 400, 0, 0, 0, 0, '否', '否', '否'], // 同文件内合同编号重复 -> 允许
        ['', '', '', '项目丁', 500, 0, 0, 0, 0, '否', '否', '否'] // 合同编号为空 -> 允许
      ])
    );
    expect((await ctx.app.inject({ method: 'POST', url: importUrl('preview'), ...m2 })).json()).toMatchObject({
      total: 4, toCreate: 3, toUpdate: 1, errors: []
    });
    const res = await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m2 });
    expect(res.json()).toEqual({ total: 4, created: 3, updated: 1, skippedPosted: 0 });

    const list = (await ctx.app.inject({ url: '/api/projects' })).json() as Array<Record<string, unknown>>;
    expect(list).toHaveLength(4);
    const by = (name: string) => list.find((p) => p.name === name)!;
    expect(by('项目甲')).toMatchObject({
      contractNo: 'HT-009', batchNo: 15, region: '华北', contractPrice: 20_000, qxReceived: 15_000, qxMoneyReceived: true
    });
    expect(by('项目乙').contractNo).toBe('HT-001');
    expect(by('项目丙').contractNo).toBe('HT-001');
    expect(by('项目丁').contractNo).toBe('');
  });

  it('同一文件内项目名称重复属于错误；其他错误行同样报告，整批不入库', async () => {
    const m = multipart(
      await projectXlsx([
        ['HT-001', '', '', '正常项目', 100, 0, 0, 0, 0, '是', '是', '是'], // Excel 第 3 行
        ['HT-002', '', '', '', 100, 0, 0, 0, 0, '', '', ''], // 第 4 行：缺项目名称
        ['HT-003', '', '', '金额非法', 'abc', 0, 0, 0, 0, '', '', ''], // 第 5 行
        ['HT-004', '', '', '正常项目', 100, 0, 0, 0, 0, '', '', ''] // 第 6 行：项目名称与第 3 行重复
      ])
    );
    const preview = (await ctx.app.inject({ method: 'POST', url: importUrl('preview'), ...m })).json() as {
      errors: Array<{ row: number; message: string }>;
    };
    expect(preview.errors.map((e) => e.row)).toEqual([4, 5, 6]);
    expect(preview.errors[0]!.message).toContain('项目名称不能为空');
    expect(preview.errors[2]!.message).toContain('项目名称「正常项目」与第 3 行重复');
    expect((await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m })).statusCode).toBe(422);
    expect((await ctx.app.inject({ url: '/api/projects' })).json()).toEqual([]);
  });

  it('批次：「第15批」记为批次号 15；数字、带空白同样识别；留空为 null；其他写法报错', async () => {
    const m = multipart(
      await projectXlsx([
        ['', '第15批', '', '甲', 0, 0, 0, 0, 0, '', '', ''],
        ['', 16, '', '乙', 0, 0, 0, 0, 0, '', '', ''],
        ['', '第 7 批', '', '丙', 0, 0, 0, 0, 0, '', '', ''],
        ['', '', '', '丁', 0, 0, 0, 0, 0, '', '', '']
      ])
    );
    expect((await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m })).statusCode).toBe(201);
    const list = (await ctx.app.inject({ url: '/api/projects' })).json() as Array<{ name: string; batchNo: number | null }>;
    const no = (name: string) => list.find((p) => p.name === name)!.batchNo;
    expect([no('甲'), no('乙'), no('丙'), no('丁')]).toEqual([15, 16, 7, null]);

    const bad = multipart(
      await projectXlsx([
        ['', '第十五批', '', '戊', 0, 0, 0, 0, 0, '', '', ''],
        ['', '第15期', '', '己', 0, 0, 0, 0, 0, '', '', ''],
        ['', '15.5', '', '庚', 0, 0, 0, 0, 0, '', '', '']
      ])
    );
    const preview = (await ctx.app.inject({ method: 'POST', url: importUrl('preview'), ...bad })).json() as {
      errors: Array<{ row: number; message: string }>;
    };
    expect(preview.errors.map((e) => e.row)).toEqual([3, 4, 5]);
    expect(preview.errors[0]!.message).toContain('批次格式无法识别');
  });

  it('兼容「表头 + 说明行 + 合计行 + 数据」的三行表头结构：说明行与合计行都被忽略，行号对应 Excel 实际行', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.addRow(PROJECT_HEADERS); // 第 1 行：表头
    ws.addRow(['', '', '', '项目名称', '合同价', '', '', '', '', '', '', '']); // 第 2 行：重复表头的说明行
    ws.addRow(['', '', '', '合计', 300, 0, 0, 0, 0, '', '', '']); // 第 3 行：合计
    ws.addRow(['HT-1', '第14批', '陇南', '真实项目一', 100, 0, 0, 0, 0, '√', '账清', '']); // 第 4 行
    ws.addRow(['HT-1', '第15批', '陇南', '真实项目二', 200, 0, 0, 0, 0, '', '', '']); // 第 5 行
    ws.addRow(['HT-1', '第15批', '陇南', '', 0, 0, 0, 0, 0, '', '', '']); // 第 6 行：缺项目名称
    const m = multipart(Buffer.from(await wb.xlsx.writeBuffer()));

    const preview = (await ctx.app.inject({ method: 'POST', url: importUrl('preview'), ...m })).json() as {
      total: number; errors: Array<{ row: number }>;
    };
    expect(preview.total).toBe(3); // 只统计真实数据行
    expect(preview.errors.map((e) => e.row)).toEqual([6]);
  });

  it('缺少必填表头（项目名称 / 合同价）返回 422；按表头名定位列，列顺序可以不同；空行不计', async () => {
    for (const must of ['项目名称', '合同价']) {
      const lacking = multipart(await projectXlsx([], PROJECT_HEADERS.filter((h) => h !== must)));
      const res = await ctx.app.inject({ method: 'POST', url: importUrl('preview'), ...lacking });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ code: 'IMPORT_HEADER_MISSING', message: expect.stringContaining(must) });
    }

    const reordered = ['项目名称', '合同编号', ...PROJECT_HEADERS.filter((h) => h !== '项目名称' && h !== '合同编号')];
    const m = multipart(await projectXlsx([['乱序项目', 'HT-009', '', '', 100, 0, 0, 0, 0, '', '', '', ''], [], [null]], reordered));
    expect((await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m })).json()).toEqual({ total: 1, created: 1, updated: 0, skippedPosted: 0 });
    expect(((await ctx.app.inject({ url: '/api/projects' })).json() as Array<{ contractNo: string; name: string }>)[0]).toMatchObject({
      contractNo: 'HT-009', name: '乱序项目'
    });
  });

  describe('只有部分列的 Excel（如未结算项目：区域 / 项目名称 / 合同价 / 备注）', () => {
    /** 任意表头的 Excel，不带合计行 */
    async function sheet(headers: string[], rows: unknown[][]): Promise<Buffer> {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('s');
      ws.addRow(headers);
      rows.forEach((r) => ws.addRow(r));
      return Buffer.from(await wb.xlsx.writeBuffer());
    }
    const commit = (buf: Buffer) => ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...multipart(buf) });
    const list = async () =>
      (await ctx.app.inject({ url: '/api/projects' })).json() as Array<Record<string, unknown> & { id: string; name: string }>;

    it('只有「区域 / 项目名称 / 合同价 / 备注」4 列可直接导入：新增项目，其余字段取默认值，备注被保存', async () => {
      const res = await commit(await sheet(['区域', '项目名称', '合同价', '备注'], [
        ['陇南', '礼县光网项目', '118000', ''],
        ['天水', '麦积基站项目', 13000.5, '加急']
      ]));
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ total: 2, created: 2, updated: 0, skippedPosted: 0 });
      const a = (await list()).find((p) => p.name === '礼县光网项目')!;
      expect(a).toMatchObject({
        region: '陇南', contractPrice: 11_800_000, note: '', contractId: null, contractNo: '', batchNo: null,
        qxReceived: 0, qxSubcontractFee: 0, chenPei: 0, qxProfit: 0,
        qxMoneyReceived: false, paidSubcontractor: false, paidChenPei: false
      });
      expect((await list()).find((p) => p.name === '麦积基站项目')).toMatchObject({ contractPrice: 1_300_050, note: '加急' });
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM contract').get()).toEqual({ n: 0 }); // 没有合同编号列，不会建合同
    });

    it('项目名称、合同价是必填列：缺列 422；列在但合同价写错/名称为空按行报错', async () => {
      const noPrice = await ctx.app.inject({ method: 'POST', url: importUrl('preview'), ...multipart(await sheet(['区域', '项目名称'], [['陇南', 'x']])) });
      expect(noPrice.statusCode).toBe(422);
      expect(noPrice.json()).toMatchObject({ code: 'IMPORT_HEADER_MISSING', message: expect.stringContaining('合同价') });

      const bad = await ctx.app.inject({
        method: 'POST', url: importUrl('preview'),
        ...multipart(await sheet(['项目名称', '合同价'], [['好项目', '100'], ['坏项目', 'abc'], ['', '5']]))
      });
      expect(bad.statusCode).toBe(200);
      expect(bad.json().errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
      expect((await commit(await sheet(['项目名称', '合同价'], [['坏项目', 'abc']]))).statusCode).toBe(422);
    });

    it('更新已有项目：Excel 没有的列保持库里原值，不会被清零；有的列照常更新', async () => {
      // 先用完整表头导入一个有数据的项目
      await commit(await projectXlsx([['HT-1', '第7批', '兰州', '已有项目', 1000, 800, 400, 50, 350, '是', '是', '否', '原备注']]));
      const before = (await list())[0]!;
      expect(before).toMatchObject({ contractNo: 'HT-1', batchNo: 7, region: '兰州', qxReceived: 80_000, qxMoneyReceived: true, note: '原备注' });

      // 再用只有 4 列的文件更新：只改区域、合同价、备注
      const res = await commit(await sheet(['区域', '项目名称', '合同价', '备注'], [['白银', '已有项目', 2000, '新备注']]));
      expect(res.json()).toMatchObject({ created: 0, updated: 1 });
      const after = (await list())[0]!;
      expect(after).toMatchObject({
        region: '白银', contractPrice: 200_000, note: '新备注', // 有的列：更新
        contractNo: 'HT-1', contractId: before.contractId, batchNo: 7, // 没有的列：保持原值（含合同归属）
        qxReceived: 80_000, qxSubcontractFee: 40_000, chenPei: 5_000, qxProfit: 35_000,
        qxMoneyReceived: true, paidSubcontractor: true, paidChenPei: false
      });
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM contract').get()).toEqual({ n: 1 });
    });

    it('「没有这一列」和「有这一列但单元格为空」不同：后者是明确的置空/置零', async () => {
      await commit(await projectXlsx([['HT-1', '第7批', '兰州', '已有项目', 1000, 800, 400, 50, 350, '是', '是', '否', '原备注']]));
      // 有「区域」「备注」「企信实收」列但单元格为空 -> 清空
      await commit(await sheet(['项目名称', '合同价', '区域', '备注', '企信实收'], [['已有项目', 1000, '', '', '']]));
      expect((await list())[0]).toMatchObject({ region: '', note: '', qxReceived: 0, qxProfit: 35_000, batchNo: 7, contractNo: 'HT-1' });
    });

    it('已入账的字段不被覆盖：即使 Excel 里写了不同的值（与缺列规则互不冲突）', async () => {
      await commit(await projectXlsx([['', '第1批', '兰州', '入账项目', 1000, 800, 0, 0, 0, '否', '否', '否', '']]));
      const id = (await list())[0]!.id;
      const acc = await makeAccount('入账户', 0);
      const body = {
        batchNo: 1, region: '兰州', name: '入账项目', contractPrice: 100_000, qxReceived: 80_000, qxSubcontractFee: 0, chenPei: 0, qxProfit: 0,
        qxMoneyReceived: true, paidSubcontractor: false, paidChenPei: false, postingAccountId: acc.id
      };
      expect((await ctx.app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: body })).statusCode).toBe(200);
      // 用「企信实收 = 1、项目结算 = 否」的文件去导入
      await commit(await sheet(['项目名称', '合同价', '企信实收', '项目结算'], [['入账项目', 1000, 1, '否']]));
      expect((await list())[0]).toMatchObject({ qxReceived: 80_000, qxMoneyReceived: true, postedKinds: ['qx_received'] });
    });

    it('备注：详情页可修改；PATCH 省略 note 时保持原值；超长返回 400', async () => {
      await commit(await sheet(['项目名称', '合同价', '备注'], [['备注项目', 100, '导入备注']]));
      const p = (await list())[0]!;
      const base = {
        batchNo: null, region: '', name: '备注项目', contractPrice: 10_000, qxReceived: 0, qxSubcontractFee: 0, chenPei: 0, qxProfit: 0,
        qxMoneyReceived: false, paidSubcontractor: false, paidChenPei: false
      };
      const patchP = (b: object) => ctx.app.inject({ method: 'PATCH', url: `/api/projects/${p.id}`, payload: b });
      expect((await patchP(base)).json()).toMatchObject({ note: '导入备注' }); // 省略 -> 不变
      expect((await patchP({ ...base, note: '  手工备注  ' })).json()).toMatchObject({ note: '手工备注' });
      expect((await patchP({ ...base, note: '' })).json()).toMatchObject({ note: '' }); // 明确清空
      expect((await patchP({ ...base, note: 'x'.repeat(501) })).statusCode).toBe(400);
    });

    it('预览与导入使用同一套规则：4 列文件预览不报错，新增/更新数量正确', async () => {
      await commit(await sheet(['项目名称', '合同价'], [['旧项目', 1]]));
      const pv = await ctx.app.inject({
        method: 'POST', url: importUrl('preview'),
        ...multipart(await sheet(['区域', '项目名称', '合同价', '备注'], [['a', '旧项目', 2, ''], ['b', '新项目', 3, '']]))
      });
      expect(pv.statusCode).toBe(200);
      expect(pv.json()).toMatchObject({ total: 2, toCreate: 1, toUpdate: 1, errors: [] });
    });
  });

  describe('详情页：修改与删除（归档）', () => {
    const patch = (id: string, body: unknown) =>
      ctx.app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: body as object });
    const baseBody = {
      batchNo: 15, region: '陇南', name: '改名后的项目',
      contractPrice: 1000, qxReceived: 800, qxSubcontractFee: 400, chenPei: 50, qxProfit: 200,
      qxMoneyReceived: false, paidSubcontractor: false, paidChenPei: false // 不涉及入账；入账见下方「入账与回退」
    };
    const seed = async () => {
      await ctx.app.inject({
        method: 'POST', url: importUrl('commit'),
        ...multipart(await projectXlsx([
          ['HT-1', '第14批', '天水', '项目甲', 100, 0, 0, 0, 0, '否', '否', '否'],
          ['HT-2', '第14批', '天水', '项目乙', 200, 0, 0, 0, 0, '否', '否', '否']
        ]))
      });
      const list = (await ctx.app.inject({ url: '/api/projects' })).json() as Array<{ id: string; name: string }>;
      return { a: list.find((p) => p.name === '项目甲')!.id, b: list.find((p) => p.name === '项目乙')!.id };
    };

    it('修改成功：所有字段保存，金额为整数分，写入审计日志', async () => {
      const { a } = await seed();
      const res = await patch(a, baseBody);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject(baseBody);
      expect((await ctx.app.inject({ url: `/api/projects/${a}` })).json()).toMatchObject(baseBody);
      const audit = ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='project' AND entity_id=? AND action='update'").get(a);
      expect(audit).toEqual({ n: 1 });
    });

    it('合同归属不能通过项目接口修改：即使请求里带了 contractNo 也被忽略', async () => {
      const { a } = await seed();
      const res = await patch(a, { ...baseBody, contractNo: 'HT-HACK' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ contractNo: 'HT-1' });
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM contract WHERE contract_no='HT-HACK'").get()).toEqual({ n: 0 });
    });

    it('详情页不再提供「项目结算」：PATCH 省略 qxMoneyReceived 时保持原值，不入账、不回退，其他字段照常保存', async () => {
      // 一个已结算（导入时填「是」）的项目和一个未结算的项目
      await ctx.app.inject({
        method: 'POST', url: importUrl('commit'),
        ...multipart(await projectXlsx([
          ['', '第1批', '天水', '已结算项目', 100, 80, 0, 0, 0, '是', '否', '否', ''],
          ['', '第1批', '天水', '未结算项目', 100, 80, 0, 0, 0, '否', '否', '否', '']
        ]))
      });
      const all = (await ctx.app.inject({ url: '/api/projects' })).json() as Array<{ id: string; name: string }>;
      const settled = all.find((p) => p.name === '已结算项目')!.id;
      const open = all.find((p) => p.name === '未结算项目')!.id;
      const { qxMoneyReceived: _omit, ...withoutFlag } = baseBody;
      const txBefore = ctx.db.prepare('SELECT COUNT(*) AS n FROM tx').get();

      const r1 = await patch(settled, { ...withoutFlag, name: '已结算项目', region: '改区域1' });
      expect(r1.statusCode).toBe(200);
      expect(r1.json()).toMatchObject({ region: '改区域1', qxMoneyReceived: true, postedKinds: [] }); // 仍是已结算
      const r2 = await patch(open, { ...withoutFlag, name: '未结算项目', region: '改区域2' });
      expect(r2.statusCode).toBe(200);
      expect(r2.json()).toMatchObject({ region: '改区域2', qxMoneyReceived: false, postedKinds: [] }); // 仍是未结算
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tx').get()).toEqual(txBefore); // 没有产生任何流水
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_posting').get()).toEqual({ n: 0 });
    });

    it('已入账的企信实收：省略 qxMoneyReceived 保存不会回退入账；金额仍被锁定（409），其他字段可改', async () => {
      const acc = await makeAccount('入账户', 0);
      const { a } = await seed();
      const withFlag = { ...baseBody, name: '项目甲', qxReceived: 800, qxMoneyReceived: true, postingAccountId: acc.id };
      expect((await patch(a, withFlag)).statusCode).toBe(200); // 先通过入参入账一笔（接口仍支持）
      const { qxMoneyReceived: _o, postingAccountId: _p, ...rest } = withFlag;
      const ok = await patch(a, { ...rest, region: '新区域' });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ region: '新区域', qxMoneyReceived: true, postedKinds: ['qx_received'] }); // 没被回退
      const locked = await patch(a, { ...rest, qxReceived: 999 });
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ code: 'POSTED_AMOUNT_LOCKED' });
      expect((await ctx.app.inject({ url: '/api/accounts' })).json().find((x: { id: string }) => x.id === acc.id)).toMatchObject({ balance: 800 });
    });

    it('批次号可清空为 null；保留自己的名称不算重名', async () => {
      const { a } = await seed();
      const res = await patch(a, { ...baseBody, name: '项目甲', batchNo: null });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: '项目甲', batchNo: null });
    });

    it('与其他项目重名返回 409；校验失败返回 400；不存在返回 404', async () => {
      const { a } = await seed();
      const dup = await patch(a, { ...baseBody, name: '项目乙' });
      expect(dup.statusCode).toBe(409);
      expect(dup.json()).toMatchObject({ code: 'DUPLICATE_NAME' });
      expect((await patch(a, { ...baseBody, name: '  ' })).statusCode).toBe(400);
      expect((await patch(a, { ...baseBody, contractPrice: 10.5 })).statusCode).toBe(400); // 金额必须是整数分
      expect((await patch(a, { ...baseBody, contractPrice: -1 })).statusCode).toBe(400);
      expect((await patch(a, { ...baseBody, batchNo: 1.5 })).statusCode).toBe(400);
      expect((await patch(a, { ...baseBody, qxMoneyReceived: 'yes' })).statusCode).toBe(400);
      expect((await patch('nope', baseBody)).statusCode).toBe(404);
      // 失败的修改不改动数据
      expect((await ctx.app.inject({ url: `/api/projects/${a}` })).json()).toMatchObject({ name: '项目甲', contractPrice: 10_000 });
    });

    it('删除 = 归档：不物理删除，列表和详情不再可见，写审计；重复删除返回 404', async () => {
      const { a, b } = await seed();
      const archived = await post(`/api/projects/${a}/archive`, {});
      expect(archived.statusCode).toBe(200);
      expect(archived.json()).toMatchObject({ id: a, name: '项目甲' }); // 返回 JSON，前端 handle() 才能解析
      expect((await ctx.app.inject({ url: `/api/projects/${a}` })).statusCode).toBe(404);
      const names = ((await ctx.app.inject({ url: '/api/projects' })).json() as Array<{ name: string }>).map((p) => p.name);
      expect(names).toEqual(['项目乙']);
      expect(ctx.db.prepare('SELECT archived FROM project WHERE id=?').get(a)).toEqual({ archived: 1 }); // 数据还在
      expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_id=? AND action='archive'").get(a)).toEqual({ n: 1 });
      expect((await post(`/api/projects/${a}/archive`, {})).statusCode).toBe(404);
      expect((await ctx.app.inject({ url: `/api/projects/${b}` })).statusCode).toBe(200);
    });

    it('归档后名称可复用：再次导入同名项目会新增而不是更新已归档的', async () => {
      const { a } = await seed();
      await post(`/api/projects/${a}/archive`, {});
      const m = multipart(await projectXlsx([['HT-1', '第15批', '天水', '项目甲', 300, 0, 0, 0, 0, '否', '否', '否']]));
      expect((await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m })).json()).toEqual({ total: 1, created: 1, updated: 0, skippedPosted: 0 });
      const list = (await ctx.app.inject({ url: '/api/projects' })).json() as Array<{ id: string; name: string; contractPrice: number }>;
      const again = list.find((p) => p.name === '项目甲')!;
      expect(again.id).not.toBe(a);
      expect(again.contractPrice).toBe(30_000);
    });

    it('手工修改会被再次导入的 Excel 覆盖（同名匹配）', async () => {
      const { a } = await seed();
      await patch(a, { ...baseBody, name: '项目甲', region: '手工改的区域', contractPrice: 999 });
      const m = multipart(await projectXlsx([['HT-1', '第14批', '天水', '项目甲', 100, 0, 0, 0, 0, '否', '否', '否']]));
      expect((await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m })).json()).toMatchObject({ updated: 1 });
      expect((await ctx.app.inject({ url: `/api/projects/${a}` })).json()).toMatchObject({ region: '天水', contractPrice: 10_000 });
    });
  });

  describe('是/否 切换：入账与回退', () => {
    const patch = (id: string, body: unknown) =>
      ctx.app.inject({ method: 'PATCH', url: `/api/projects/${id}`, payload: body as object });
    const full = (over: Record<string, unknown> = {}) => ({
      contractNo: 'HT-1', batchNo: 15, region: '陇南', name: '入账项目',
      contractPrice: 100_000, qxReceived: 80_000, qxSubcontractFee: 40_000, chenPei: 5_000, qxProfit: 35_000,
      qxMoneyReceived: false, paidSubcontractor: false, paidChenPei: false,
      ...over
    });
    const setup = async () => {
      const acc = await makeAccount('入账账户', 1_000_000);
      await ctx.app.inject({
        method: 'POST', url: importUrl('commit'),
        ...multipart(await projectXlsx([['HT-1', '第15批', '陇南', '入账项目', 1000, 800, 400, 50, 350, '否', '否', '否']]))
      });
      const list = (await ctx.app.inject({ url: '/api/projects' })).json() as Array<{ id: string }>;
      return { acc: acc.id, id: list[0]!.id };
    };
    const balance = async (accId: string) => ((await ctx.app.inject({ url: `/api/accounts/${accId}` })).json() as { balance: number }).balance;
    const txOf = async (accId: string) =>
      ((await ctx.app.inject({ url: `/api/transactions?accountId=${accId}&includeVoided=true&limit=100` })).json() as {
        items: Array<{ id: string; type: string; status: string; lines: Array<{ amount: number }>; note: string }>;
      }).items;

    it('否 -> 是：企信收到钱记收入、支付下家/陈沛记支出，金额取对应列，余额随之变化', async () => {
      const { acc, id } = await setup();
      const res = await patch(id, full({ qxMoneyReceived: true, paidSubcontractor: true, paidChenPei: true, postingAccountId: acc }));
      expect(res.statusCode).toBe(200);
      expect((res.json() as { postedKinds: string[] }).postedKinds.sort()).toEqual(['paid_chen_pei', 'paid_subcontractor', 'qx_received']);

      const txs = await txOf(acc);
      expect(txs).toHaveLength(3);
      const sum = (type: string) => txs.filter((t) => t.type === type).map((t) => t.lines[0]!.amount).sort((a, b) => a - b);
      expect(sum('income')).toEqual([80_000]); // 企信实收
      expect(sum('expense')).toEqual([-40_000, -5_000]); // 分包费 + 陈沛，支出为负
      expect(await balance(acc)).toBe(1_000_000 + 80_000 - 40_000 - 5_000);
      expect(txs.every((t) => t.note.includes('入账项目'))).toBe(true);
    });

    it('是 -> 否：作废对应流水（不物理删除），余额回退，其他字段的流水不受影响', async () => {
      const { acc, id } = await setup();
      await patch(id, full({ qxMoneyReceived: true, paidSubcontractor: true, postingAccountId: acc }));
      expect(await balance(acc)).toBe(1_000_000 + 80_000 - 40_000);

      const res = await patch(id, full({ qxMoneyReceived: false, paidSubcontractor: true }));
      expect(res.statusCode).toBe(200);
      expect((res.json() as { postedKinds: string[] }).postedKinds).toEqual(['paid_subcontractor']);
      expect(await balance(acc)).toBe(1_000_000 - 40_000); // 收入回退，支出保留

      const txs = await txOf(acc);
      expect(txs).toHaveLength(2); // 流水还在
      expect(txs.find((t) => t.type === 'income')!.status).toBe('voided'); // 只是作废
      expect(txs.find((t) => t.type === 'expense')!.status).toBe('normal');
      const link = ctx.db.prepare("SELECT active, reverted_at AS r FROM project_posting WHERE project_id=? AND kind='qx_received'").get(id) as { active: number; r: string | null };
      expect(link.active).toBe(0);
      expect(link.r).not.toBeNull();
    });

    it('回退后可再次入账，且按当时的金额重新生成一笔新流水', async () => {
      const { acc, id } = await setup();
      await patch(id, full({ qxMoneyReceived: true, postingAccountId: acc }));
      await patch(id, full({ qxMoneyReceived: false }));
      await patch(id, full({ qxMoneyReceived: false, qxReceived: 90_000 })); // 回退后可以改金额
      await patch(id, full({ qxMoneyReceived: true, qxReceived: 90_000, postingAccountId: acc }));
      expect(await balance(acc)).toBe(1_000_000 + 90_000);
      const txs = await txOf(acc);
      expect(txs).toHaveLength(2);
      expect(txs.filter((t) => t.status === 'normal').map((t) => t.lines[0]!.amount)).toEqual([90_000]);
    });

    it('缺少入账账户 / 金额为 0 / 账户已归档：拒绝，且项目与流水都不变（原子性）', async () => {
      const { acc, id } = await setup();
      const noAcc = await patch(id, full({ qxMoneyReceived: true, region: '不应保存' }));
      expect(noAcc.statusCode).toBe(400);
      expect(noAcc.json()).toMatchObject({ code: 'POSTING_ACCOUNT_REQUIRED' });

      const zero = await patch(id, full({ qxMoneyReceived: true, qxReceived: 0, postingAccountId: acc }));
      expect(zero.statusCode).toBe(400);

      const bad = await patch(id, full({ qxMoneyReceived: true, postingAccountId: 'not-exist', region: '不应保存' }));
      expect(bad.statusCode).toBe(404);

      // 同时有两个字段入账，第二笔失败（账户不存在）：第一笔也必须回滚
      expect((await txOf(acc))).toHaveLength(0);
      const p = (await ctx.app.inject({ url: `/api/projects/${id}` })).json() as { region: string; qxMoneyReceived: boolean; postedKinds: string[] };
      expect(p).toMatchObject({ region: '陇南', qxMoneyReceived: false, postedKinds: [] });
      expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM project_posting').get()).toEqual({ n: 0 });
      expect(await balance(acc)).toBe(1_000_000);
    });

    it('已入账的字段不能直接改对应金额（409），未入账字段的金额照常可改', async () => {
      const { acc, id } = await setup();
      await patch(id, full({ qxMoneyReceived: true, postingAccountId: acc }));
      const locked = await patch(id, full({ qxMoneyReceived: true, qxReceived: 99_999 }));
      expect(locked.statusCode).toBe(409);
      expect(locked.json()).toMatchObject({ code: 'POSTED_AMOUNT_LOCKED' });
      // 其他金额（未入账）可以改
      const ok = await patch(id, full({ qxMoneyReceived: true, qxSubcontractFee: 41_000, contractPrice: 123 }));
      expect(ok.statusCode).toBe(200);
      expect(await balance(acc)).toBe(1_000_000 + 80_000);
    });

    it('已入账的项目不能删除（409），回退后才能删除', async () => {
      const { acc, id } = await setup();
      await patch(id, full({ paidChenPei: true, postingAccountId: acc }));
      const blocked = await post(`/api/projects/${id}/archive`, {});
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ code: 'PROJECT_HAS_POSTINGS' });
      await patch(id, full({ paidChenPei: false }));
      expect((await post(`/api/projects/${id}/archive`, {})).statusCode).toBe(200);
    });

    it('历史「是」标记（Excel 导入、无流水）：切回否只改标记，不报错、不动账', async () => {
      const acc = await makeAccount('历史账户', 500_000);
      await ctx.app.inject({
        method: 'POST', url: importUrl('commit'),
        ...multipart(await projectXlsx([['HT-2', '第15批', '陇南', '历史项目', 1000, 800, 400, 50, 350, '是', '是', '否']]))
      });
      const proj = ((await ctx.app.inject({ url: '/api/projects' })).json() as Array<{ id: string; qxMoneyReceived: boolean; postedKinds: string[] }>)[0]!;
      expect(proj.qxMoneyReceived).toBe(true);
      expect(proj.postedKinds).toEqual([]); // 导入不记账
      expect(await txOf(acc.id)).toHaveLength(0);
      const res = await patch(proj.id, full({ name: '历史项目', qxMoneyReceived: false, paidSubcontractor: true }));
      expect(res.statusCode).toBe(200);
      expect(await txOf(acc.id)).toHaveLength(0);
      expect(await balance(acc.id)).toBe(500_000);
    });

    it('再次导入：已入账字段的标记与金额不被覆盖，其余字段照常覆盖；导入不生成流水', async () => {
      const { acc, id } = await setup();
      await patch(id, full({ qxMoneyReceived: true, postingAccountId: acc }));
      const m = multipart(await projectXlsx([['HT-NEW', '第16批', '天水', '入账项目', 2000, 1, 999, 77, 666, '否', '是', '否']]));
      const pre = (await ctx.app.inject({ method: 'POST', url: importUrl('preview'), ...m })).json() as Record<string, unknown>;
      expect(pre).toMatchObject({ toUpdate: 1, toUpdatePartially: 1 });
      const res = await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m });
      expect(res.json()).toMatchObject({ updated: 1, skippedPosted: 1 });

      const p = (await ctx.app.inject({ url: `/api/projects/${id}` })).json() as Record<string, unknown>;
      expect(p).toMatchObject({
        qxMoneyReceived: true, qxReceived: 80_000, // 已入账：标记与金额保持
        contractNo: 'HT-NEW', region: '天水', contractPrice: 200_000, qxSubcontractFee: 99_900, chenPei: 7_700, // 其余被覆盖
        paidSubcontractor: true // 未入账的字段按 Excel 覆盖，但只是标记
      });
      expect(await txOf(acc)).toHaveLength(1); // 导入没有新增流水
      expect(await balance(acc)).toBe(1_000_000 + 80_000);
    });

    it('入账日期：流水的发生日期取 postingDate（多笔共用），省略时用当天；非法日期返回 400 且不入账', async () => {
      const { acc, id } = await setup();
      const res = await patch(id, full({ qxMoneyReceived: true, paidSubcontractor: true, postingAccountId: acc, postingDate: '2026-03-15' }));
      expect(res.statusCode).toBe(200);
      const txs = await txOf(acc);
      expect(txs).toHaveLength(2);
      const dates = ctx.db.prepare('SELECT occurred_on AS d FROM tx WHERE id IN (' + txs.map(() => '?').join(',') + ')').all(...txs.map((t) => t.id)) as Array<{ d: string }>;
      expect(dates.map((r) => r.d)).toEqual(['2026-03-15', '2026-03-15']);
      const audit = JSON.parse((ctx.db.prepare("SELECT payload FROM audit_log WHERE entity_id=? AND action='update' ORDER BY rowid DESC LIMIT 1").get(id) as { payload: string }).payload) as {
        postings: Array<{ date?: string }>;
      };
      expect(audit.postings.map((x) => x.date)).toEqual(['2026-03-15', '2026-03-15']);

      // 再入账一笔、不传日期：用服务器当天（本地日期）
      const d = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const localToday = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      await patch(id, full({ qxMoneyReceived: true, paidSubcontractor: true, paidChenPei: true, postingAccountId: acc }));
      const row = ctx.db.prepare("SELECT t.occurred_on AS d FROM project_posting p JOIN tx t ON t.id=p.tx_id WHERE p.project_id=? AND p.kind='paid_chen_pei'").get(id) as { d: string };
      expect(row.d).toBe(localToday);

      // 非法日期：格式不对、2月30日、空串。先回退上面的入账，再用非法日期尝试，应全部被拒且不产生新流水
      await patch(id, full({ qxMoneyReceived: false, paidSubcontractor: false, paidChenPei: false }));
      const before = (await txOf(acc)).length;
      for (const bad of ['2026/03/15', '2026-02-30', '2026-13-01', '', '昨天']) {
        const r = await patch(id, full({ qxMoneyReceived: true, postingAccountId: acc, postingDate: bad }));
        expect(r.statusCode, `postingDate=${JSON.stringify(bad)}`).toBe(400);
      }
      expect(await txOf(acc)).toHaveLength(before);
    });

    it('审计：入账与回退都记录在项目的 update 审计里（含流水 id、金额、动作）', async () => {
      const { acc, id } = await setup();
      await patch(id, full({ qxMoneyReceived: true, postingAccountId: acc }));
      await patch(id, full({ qxMoneyReceived: false }));
      const rows = ctx.db.prepare("SELECT payload FROM audit_log WHERE entity='project' AND entity_id=? AND action='update' ORDER BY created_at, rowid").all(id) as Array<{ payload: string }>;
      expect(rows).toHaveLength(2);
      const [a, b] = rows.map((r) => JSON.parse(r.payload) as { postings: Array<{ kind: string; action: string; txId: string; amount: number }> });
      expect(a!.postings).toEqual([expect.objectContaining({ kind: 'qx_received', action: 'post', amount: 80_000 })]);
      expect(b!.postings).toEqual([expect.objectContaining({ kind: 'qx_received', action: 'revert', amount: 80_000 })]);
      expect(a!.postings[0]!.txId).toBe(b!.postings[0]!.txId); // 回退的正是入账的那一笔
    });
  });

  it('不再提供手工新增项目接口；可下载导入模板', async () => {
    expect((await post('/api/projects', { name: 'x' })).statusCode).toBe(404);
    const tpl = await ctx.app.inject({ url: '/api/projects/import/template' });
    expect(tpl.statusCode).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(tpl.rawPayload as unknown as ArrayBuffer);
    expect(wb.worksheets[0]!.getRow(1).values).toEqual([undefined, ...PROJECT_HEADERS]);
    // 模板本身必须能被导入
    const m = multipart(Buffer.from(tpl.rawPayload));
    expect((await ctx.app.inject({ method: 'POST', url: importUrl('commit'), ...m })).json()).toMatchObject({ created: 2 });
  });
});

describe('合同管理', () => {
  const patch = (url: string, body: unknown) => ctx.app.inject({ method: 'PATCH', url, payload: body as object });
  const get = async (url: string) => (await ctx.app.inject({ url })).json();

  /** 导入若干项目：合同编号为空 = 未结算 */
  async function importProjects(rows: unknown[][]) {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/projects/import/commit', ...multipart(await projectXlsx(rows)) });
    expect(res.statusCode).toBe(201);
    const list = (await get('/api/projects')) as Array<{ id: string; name: string }>;
    return (name: string) => list.find((p) => p.name === name)!.id;
  }
  const row = (contractNo: string, name: string, price = 0) => [contractNo, '第1批', '天水', name, price, 0, 0, 0, 0, '否', '否', '否'];

  it('新增合同：从未结算项目里挑选并设置合同价，合同总价 = 各项目合同价之和（整数分）；不改变项目结算状态', async () => {
    const id = await importProjects([row('', '项目甲'), row('', '项目乙'), row('', '项目丙')]);
    const res = await post('/api/contracts', {
      contractNo: 'HT-100',
      projects: [{ projectId: id('项目甲'), contractPrice: 100_010 }, { projectId: id('项目乙'), contractPrice: 20_005 }]
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ contractNo: 'HT-100', totalPrice: 120_015, projectCount: 2 });
    expect(res.json().projects.map((p: { name: string }) => p.name).sort()).toEqual(['项目乙', '项目甲']);

    // 项目：归入合同、合同价被设置；项目结算保持原样（否），不会悄悄生成收入流水；未选的项目不受影响
    expect(await get(`/api/projects/${id('项目甲')}`)).toMatchObject({ contractNo: 'HT-100', contractPrice: 100_010, qxMoneyReceived: false, postedKinds: [] });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tx').get()).toEqual({ n: 0 });
    expect(await get(`/api/projects/${id('项目丙')}`)).toMatchObject({ contractId: null, contractNo: '', qxMoneyReceived: false });
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='contract' AND action='create'").get()).toEqual({ n: 1 });
  });

  it('新增合同的校验：编号必填且唯一、至少一个项目、项目必须存在且未归入其他合同、不能重复选同一项目', async () => {
    const id = await importProjects([row('', '项目甲'), row('', '项目乙')]);
    const one = [{ projectId: id('项目甲'), contractPrice: 100 }];
    expect((await post('/api/contracts', { contractNo: '  ', projects: one })).statusCode).toBe(400);
    expect((await post('/api/contracts', { contractNo: 'HT-1', projects: [] })).statusCode).toBe(400);
    expect((await post('/api/contracts', { contractNo: 'HT-1', projects: [{ projectId: 'nope', contractPrice: 1 }] })).statusCode).toBe(404);
    expect((await post('/api/contracts', { contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 1.5 }] })).statusCode).toBe(400);
    expect((await post('/api/contracts', { contractNo: 'HT-1', projects: [...one, ...one] })).statusCode).toBe(400);
    expect((await get('/api/contracts')).length).toBe(0); // 失败都不落库

    expect((await post('/api/contracts', { contractNo: 'HT-1', projects: one })).statusCode).toBe(201);
    const dupNo = await post('/api/contracts', { contractNo: 'HT-1', projects: [{ projectId: id('项目乙'), contractPrice: 1 }] });
    expect(dupNo.statusCode).toBe(409);
    expect(dupNo.json()).toMatchObject({ code: 'DUPLICATE_CONTRACT_NO' });
    const taken = await post('/api/contracts', { contractNo: 'HT-2', projects: one });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toMatchObject({ code: 'PROJECT_ALREADY_IN_CONTRACT' });
    expect((await get('/api/contracts')).length).toBe(1);
  });

  it('新增合同只能挑「项目结算 = 否」的项目：已结算项目返回 409，且不落库', async () => {
    // 导入时「项目结算」填「是」= 已结算
    await ctx.app.inject({
      method: 'POST', url: '/api/projects/import/commit',
      ...multipart(await projectXlsx([['', '第1批', '天水', '已结算项目', 100, 0, 0, 0, 0, '是', '否', '否']]))
    });
    const sid = ((await get('/api/projects')) as Array<{ id: string }>)[0]!.id;
    const res = await post('/api/contracts', { contractNo: 'HT-S', projects: [{ projectId: sid, contractPrice: 100 }] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'PROJECT_ALREADY_SETTLED' });
    expect((await get('/api/contracts')).length).toBe(0);
    expect(await get(`/api/projects/${sid}`)).toMatchObject({ contractId: null });
  });

  it('Excel 导入仍认旧表头「企信是否收到钱」（旧文件可继续导入），新表头「项目结算」同样可用', async () => {
    const legacy = PROJECT_HEADERS.map((h) => (h === '项目结算' ? '企信是否收到钱' : h));
    const r1 = await ctx.app.inject({
      method: 'POST', url: '/api/projects/import/commit',
      ...multipart(await projectXlsx([['', '第1批', '天水', '旧表头项目', 1, 0, 0, 0, 0, '是', '否', '否']], legacy))
    });
    expect(r1.statusCode).toBe(201);
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/api/projects/import/commit',
      ...multipart(await projectXlsx([['', '第1批', '天水', '新表头项目', 1, 0, 0, 0, 0, '是', '否', '否']]))
    });
    expect(r2.statusCode).toBe(201);
    const list = (await get('/api/projects')) as Array<{ name: string; qxMoneyReceived: boolean }>;
    expect(list.find((p) => p.name === '旧表头项目')!.qxMoneyReceived).toBe(true);
    expect(list.find((p) => p.name === '新表头项目')!.qxMoneyReceived).toBe(true);
  });

  it('列表与详情：详情包含其下所有项目；不存在返回 404', async () => {
    const id = await importProjects([row('', '项目甲'), row('', '项目乙')]);
    const created = (await post('/api/contracts', {
      contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 300 }, { projectId: id('项目乙'), contractPrice: 700 }]
    })).json();
    const list = await get('/api/contracts');
    expect(list).toEqual([expect.objectContaining({ id: created.id, contractNo: 'HT-1', totalPrice: 1000, projectCount: 2 })]);
    const detail = await get(`/api/contracts/${created.id}`);
    expect(detail.projects).toHaveLength(2);
    expect(detail.projects[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), contractPrice: expect.any(Number) });
    expect((await ctx.app.inject({ url: '/api/contracts/nope' })).statusCode).toBe(404);
  });

  it('编辑合同：可加入未结算且未归属的已有项目；已归属其他合同/已结算/不存在的被拒绝，且整体不落库', async () => {
    await ctx.app.inject({
      method: 'POST', url: '/api/projects/import/commit',
      ...multipart(await projectXlsx([
        ['', '第1批', '天水', '项目甲', 0, 0, 0, 0, 0, '否', '否', '否'],
        ['', '第1批', '天水', '项目乙', 250, 0, 0, 0, 0, '否', '否', '否'],
        ['', '第1批', '天水', '项目丙', 0, 0, 0, 0, 0, '否', '否', '否'],
        ['', '第1批', '天水', '已结算项目', 0, 0, 0, 0, 0, '是', '否', '否']
      ]))
    });
    const list = (await get('/api/projects')) as Array<{ id: string; name: string }>;
    const id = (n: string) => list.find((p) => p.name === n)!.id;
    const c = (await post('/api/contracts', { contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 1_000 }] })).json();
    const other = (await post('/api/contracts', { contractNo: 'HT-2', projects: [{ projectId: id('项目丙'), contractPrice: 50 }] })).json();

    // 失败：已归属其他合同 409、已结算 409、不存在 404；同一请求里合法的新增项目也不应落库
    const bad = (projectId: string) => patch(`/api/contracts/${c.id}`, {
      contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 1_000 }, { projectId: id('项目乙'), contractPrice: 1 }, { projectId, contractPrice: 1 }]
    });
    expect((await bad(id('项目丙'))).json()).toMatchObject({ code: 'PROJECT_ALREADY_IN_CONTRACT' });
    expect((await bad(id('已结算项目'))).json()).toMatchObject({ code: 'PROJECT_ALREADY_SETTLED' });
    expect((await bad('nope')).statusCode).toBe(404);
    expect(await get(`/api/projects/${id('项目乙')}`)).toMatchObject({ contractId: null, contractNo: '', contractPrice: 25_000 });
    expect(await get(`/api/contracts/${c.id}`)).toMatchObject({ projectCount: 1, totalPrice: 1_000 });
    expect(await get(`/api/contracts/${other.id}`)).toMatchObject({ projectCount: 1, totalPrice: 50 });

    // 成功：加入项目乙并改编号；总价 = 各项目合同价之和；项目结算状态不变、不产生流水
    const ok = await patch(`/api/contracts/${c.id}`, {
      contractNo: 'HT-1B', projects: [{ projectId: id('项目甲'), contractPrice: 1_000 }, { projectId: id('项目乙'), contractPrice: 30_005 }]
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ contractNo: 'HT-1B', projectCount: 2, totalPrice: 31_005 });
    expect(await get(`/api/projects/${id('项目乙')}`)).toMatchObject({ contractId: c.id, contractNo: 'HT-1B', contractPrice: 30_005, qxMoneyReceived: false });
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tx').get()).toEqual({ n: 0 });
    const audit = ctx.db.prepare("SELECT payload FROM audit_log WHERE entity='contract' AND entity_id=? AND action='update'").get(c.id) as { payload: string };
    expect(JSON.parse(audit.payload).addedProjects).toEqual([id('项目乙')]);

    // 请求里未出现的已有项目保持不变（不会被移除）
    const keep = await patch(`/api/contracts/${c.id}`, { contractNo: 'HT-1B', projects: [{ projectId: id('项目乙'), contractPrice: 1 }] });
    expect(keep.json()).toMatchObject({ projectCount: 2, totalPrice: 1_001 });
  });

  it('合同价异常输入：负数、小数分、字符串、null、超大值一律 400，不落库（新增与编辑都校验）', async () => {
    const id = await importProjects([row('', '项目甲'), row('', '项目乙')]);
    const c = (await post('/api/contracts', { contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 100 }] })).json();
    const bads: unknown[] = [-1, 1.5, '100', null, undefined, true, [], 1e15, Number.MAX_SAFE_INTEGER, 10_000_000_000 * 100 + 1];
    for (const bad of bads) {
      const body = { contractNo: 'HT-9', projects: [{ projectId: id('项目乙'), contractPrice: bad }] };
      expect((await post('/api/contracts', body)).statusCode, `create ${String(bad)}`).toBe(400);
      expect((await patch(`/api/contracts/${c.id}`, { ...body, contractNo: 'HT-1' })).statusCode, `update ${String(bad)}`).toBe(400);
    }
    // 非法 JSON 数值（NaN / 溢出）不会进入服务层：返回 4xx 而不是 500
    for (const raw of ['{"contractNo":"HT-9","projects":[{"projectId":"x","contractPrice":NaN}]}', '{"contractNo":"HT-9","projects":[{"projectId":"x","contractPrice":1e999}]}']) {
      const res = await ctx.app.inject({ method: 'POST', url: '/api/contracts', headers: { 'content-type': 'application/json' }, payload: raw });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }
    expect((await get('/api/contracts')).length).toBe(1);
    expect(await get(`/api/projects/${id('项目乙')}`)).toMatchObject({ contractId: null });
    expect(await get(`/api/contracts/${c.id}`)).toMatchObject({ totalPrice: 100, projectCount: 1 });

    // 边界值合法：0 与上限
    expect((await patch(`/api/contracts/${c.id}`, { contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 0 }] })).statusCode).toBe(200);
    expect((await patch(`/api/contracts/${c.id}`, { contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 10_000_000_000 * 100 }] })).statusCode).toBe(200);
  });

  it('编辑合同：改合同编号同步到项目，改各项目合同价后总价随之变化', async () => {
    const id = await importProjects([row('', '项目甲'), row('', '项目乙'), row('', '项目丙')]);
    const c = (await post('/api/contracts', {
      contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 300 }, { projectId: id('项目乙'), contractPrice: 700 }]
    })).json();
    await post('/api/contracts', { contractNo: 'HT-2', projects: [{ projectId: id('项目丙'), contractPrice: 50 }] });

    const res = await patch(`/api/contracts/${c.id}`, {
      contractNo: 'HT-1B', projects: [{ projectId: id('项目甲'), contractPrice: 400 }, { projectId: id('项目乙'), contractPrice: 700 }]
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ contractNo: 'HT-1B', totalPrice: 1100 });
    expect(await get(`/api/projects/${id('项目乙')}`)).toMatchObject({ contractNo: 'HT-1B', contractPrice: 700 });

    expect((await patch(`/api/contracts/${c.id}`, { contractNo: 'HT-2', projects: [] })).statusCode).toBe(409); // 与其他合同重号
    expect((await patch(`/api/contracts/${c.id}`, { contractNo: 'HT-1B', projects: [{ projectId: id('项目丙'), contractPrice: 1 }] })).statusCode).toBe(409); // 项目丙属于其他合同，不能抢过来
    expect((await patch('/api/contracts/nope', { contractNo: 'X', projects: [] })).statusCode).toBe(404);
    expect(await get(`/api/projects/${id('项目丙')}`)).toMatchObject({ contractPrice: 50 }); // 失败不改动
  });

  it('删除合同 = 归档：项目与其流水保留，项目合同归属清空回到未结算；合同编号可复用；写审计', async () => {
    const id = await importProjects([row('', '项目甲')]);
    const c = (await post('/api/contracts', { contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 300 }] })).json();
    const del = await post(`/api/contracts/${c.id}/archive`, {});
    expect(del.statusCode).toBe(200);
    expect((await get('/api/contracts')).length).toBe(0);
    expect((await ctx.app.inject({ url: `/api/contracts/${c.id}` })).statusCode).toBe(404);
    expect((await post(`/api/contracts/${c.id}/archive`, {})).statusCode).toBe(404);
    expect(await get(`/api/projects/${id('项目甲')}`)).toMatchObject({ contractId: null, contractNo: '', contractPrice: 300 });
    expect(ctx.db.prepare('SELECT archived FROM contract WHERE id = ?').get(c.id)).toEqual({ archived: 1 }); // 物理上仍在
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='contract' AND action='archive'").get()).toEqual({ n: 1 });
    expect((await post('/api/contracts', { contractNo: 'HT-1', projects: [{ projectId: id('项目甲'), contractPrice: 1 }] })).statusCode).toBe(201);
  });

  it('Excel 导入：合同编号不存在时自动创建合同并归入；已存在则复用；编号为空保持未结算；合同总价随之汇总', async () => {
    await importProjects([row('HT-1', '项目甲', 100), row('HT-1', '项目乙', 200), row('HT-2', '项目丙', 50), row('', '项目丁', 9)]);
    const list = (await get('/api/contracts')) as Array<{ contractNo: string; totalPrice: number; projectCount: number }>;
    expect(list.map((c) => c.contractNo).sort()).toEqual(['HT-1', 'HT-2']);
    expect(list.find((c) => c.contractNo === 'HT-1')).toMatchObject({ totalPrice: 30_000, projectCount: 2 }); // 100、200 元 = 整数分
    const unsettled = ((await get('/api/projects')) as Array<{ name: string; contractId: string | null }>).filter((p) => !p.contractId);
    expect(unsettled.map((p) => p.name)).toEqual(['项目丁']);

    // 再次导入同一合同编号：复用，不重复创建
    await importProjects([row('HT-1', '项目戊', 1)]);
    expect((await get('/api/contracts')).length).toBe(2);
    expect(((await get('/api/contracts')) as Array<{ contractNo: string; projectCount: number }>).find((c) => c.contractNo === 'HT-1')!.projectCount).toBe(3);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='contract' AND action='import_create'").get()).toEqual({ n: 2 });
  });
});

describe('账户类型限制', () => {
  it('只允许银行账户/支付宝/微信，已移除的类型返回 400', async () => {
    for (const type of ['cash', 'receivable', 'payable', 'other']) {
      expect((await post('/api/accounts', { name: `旧-${type}`, type })).statusCode).toBe(400);
    }
  });
});

describe('流水盈亏统计', () => {
  it('按与列表相同的筛选条件统计全部命中数据（不受分页影响）：盈亏 = 收入 − 支出，借贷与作废不计入', async () => {
    const a = await makeAccount('甲');
    const b = await makeAccount('乙');
    await post('/api/transactions', { occurredOn: '2026-11-01', type: 'income', amount: 100_000, accountId: a.id });
    await post('/api/transactions', { occurredOn: '2026-11-02', type: 'income', amount: 50_050, accountId: b.id });
    await post('/api/transactions', { occurredOn: '2026-11-03', type: 'expense', amount: 30_025, accountId: a.id });
    await post('/api/transactions', { occurredOn: '2026-12-01', type: 'expense', amount: 200_000, accountId: a.id });
    await post('/api/transactions', { occurredOn: '2026-11-04', type: 'loan', amount: 900_000, accountId: a.id });
    await post('/api/transactions', { occurredOn: '2026-11-05', type: 'borrow', amount: 700_000, accountId: a.id });
    const voided = (await post('/api/transactions', { occurredOn: '2026-11-06', type: 'income', amount: 12_345, accountId: a.id })).json() as { id: string };
    await post(`/api/transactions/${voided.id}/void`, { reason: '测试' });

    const get = async (qs = '') => (await ctx.app.inject({ url: `/api/transactions/summary${qs}` })).json() as { income: number; expense: number; profit: number; count: number };

    expect(await get()).toEqual({ income: 150_050, expense: 230_025, profit: -79_975, count: 4 });
    // 分页参数不影响统计
    expect(await get('?limit=1&offset=2')).toMatchObject({ income: 150_050, expense: 230_025 });
    // 勾选「显示已作废」也不把作废流水计入盈亏
    expect(await get('?includeVoided=true')).toMatchObject({ income: 150_050, profit: -79_975 });
    // 日期、账户、类型筛选
    expect(await get('?from=2026-11-01&to=2026-11-30')).toEqual({ income: 150_050, expense: 30_025, profit: 120_025, count: 3 });
    expect(await get(`?accountId=${b.id}`)).toEqual({ income: 50_050, expense: 0, profit: 50_050, count: 1 });
    expect(await get('?type=expense')).toEqual({ income: 0, expense: 230_025, profit: -230_025, count: 2 });
    expect(await get('?type=loan')).toEqual({ income: 0, expense: 0, profit: 0, count: 0 });
    // 没有命中数据
    expect(await get('?from=2030-01-01')).toEqual({ income: 0, expense: 0, profit: 0, count: 0 });
  });
});
describe('总览：指定时间段统计', () => {
  it('统计时间段（含首尾）内的收入/支出及按分类、往来单位的去向；借贷与作废不计入', async () => {
    const a = await makeAccount('甲');
    const cats = (await ctx.app.inject({ url: '/api/categories' })).json() as Array<{ id: string; name: string; kind: string }>;
    const exp1 = cats.find((c) => c.kind === 'expense')!;
    const exp2 = cats.filter((c) => c.kind === 'expense')[1]!;
    const inc1 = cats.find((c) => c.kind === 'income')!;
    const tx = (body: object) => post('/api/transactions', { accountId: a.id, ...body });
    await tx({ occurredOn: '2026-10-01', type: 'income', amount: 100_000, categoryId: inc1.id });
    await tx({ occurredOn: '2026-10-31', type: 'expense', amount: 3_000, categoryId: exp1.id }); // 边界：含首尾
    await tx({ occurredOn: '2026-11-01', type: 'expense', amount: 10_000, categoryId: exp1.id });
    await tx({ occurredOn: '2026-11-15', type: 'expense', amount: 25_050, categoryId: exp2.id });
    await tx({ occurredOn: '2026-11-30', type: 'expense', amount: 700, categoryId: exp2.id });
    await tx({ occurredOn: '2026-11-20', type: 'income', amount: 80_000, categoryId: inc1.id });
    await tx({ occurredOn: '2026-11-21', type: 'loan', amount: 900_000 });
    await tx({ occurredOn: '2026-11-22', type: 'borrow', amount: 800_000 });
    const voided = (await tx({ occurredOn: '2026-11-10', type: 'expense', amount: 999_999, categoryId: exp1.id })).json() as { id: string };
    await post(`/api/transactions/${voided.id}/void`, { reason: '测试' });

    type Period = {
      income: number; expense: number; profit: number; count: number;
      expenseByCategory: Array<{ categoryName: string; amount: number; count: number }>;
      incomeByCategory: Array<{ categoryName: string; amount: number; count: number }>;
      expenseByCounterparty: Array<{ name: string; amount: number; count: number }>;
    };
    const period = async (qs = '') => (await ctx.app.inject({ url: `/api/overview/period${qs}` })).json() as Period;

    const nov = await period('?from=2026-11-01&to=2026-11-30');
    expect(nov).toMatchObject({ income: 80_000, expense: 35_750, profit: 44_250, count: 4 });
    expect(nov.expenseByCategory).toEqual([
      { categoryId: exp2.id, categoryName: exp2.name, amount: 25_750, count: 2 },
      { categoryId: exp1.id, categoryName: exp1.name, amount: 10_000, count: 1 }
    ]);
    expect(nov.incomeByCategory).toMatchObject([{ categoryName: inc1.name, amount: 80_000, count: 1 }]);
    // 未填往来单位的流水归入「未填写」
    expect(nov.expenseByCounterparty).toEqual([{ name: '未填写', amount: 35_750, count: 3 }]);

    // 首尾日期都包含
    expect(await period('?from=2026-10-31&to=2026-11-01')).toMatchObject({ expense: 13_000, income: 0, count: 2 });
    // 只给一端 / 都不给 = 不限
    expect(await period('?from=2026-11-15')).toMatchObject({ income: 80_000, expense: 25_750 });
    expect(await period()).toMatchObject({ income: 180_000, expense: 38_750, profit: 141_250, count: 6 });
    // 没有数据
    expect(await period('?from=2030-01-01&to=2030-12-31')).toMatchObject({ income: 0, expense: 0, profit: 0, count: 0, expenseByCategory: [] });
    // 参数校验
    expect((await ctx.app.inject({ url: '/api/overview/period?from=2026-12-01&to=2026-11-01' })).statusCode).toBe(400);
    expect((await ctx.app.inject({ url: '/api/overview/period?from=bad' })).statusCode).toBe(400);
  });

  it('按往来单位汇总支出去向', async () => {
    const a = await makeAccount('甲');
    const cp = (await post('/api/counterparties', { name: '阿里云' })).json() as { id: string };
    await post('/api/transactions', { occurredOn: '2026-11-02', type: 'expense', amount: 1_000, accountId: a.id, counterpartyId: cp.id });
    await post('/api/transactions', { occurredOn: '2026-11-03', type: 'expense', amount: 2_500, accountId: a.id, counterpartyId: cp.id });
    await post('/api/transactions', { occurredOn: '2026-11-04', type: 'expense', amount: 400, accountId: a.id });
    const res = (await ctx.app.inject({ url: '/api/overview/period?from=2026-11-01&to=2026-11-30' })).json() as {
      expenseByCounterparty: Array<{ name: string; amount: number; count: number }>;
    };
    expect(res.expenseByCounterparty).toEqual([
      { name: '阿里云', amount: 3_500, count: 2 },
      { name: '未填写', amount: 400, count: 1 }
    ]);
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

  it('列表中内置分类在前，自定义分类按新增时间倒序', async () => {
    await post('/api/categories', { name: '甲收入', kind: 'income' });
    await post('/api/categories', { name: '乙收入', kind: 'income' });
    await post('/api/categories', { name: '丙收入', kind: 'income' });
    expect((await incomeCats()).map((c) => c.name)).toEqual(['其他收入', '丙收入', '乙收入', '甲收入']);
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

  it('列表按新增时间倒序，最新新增的排在最前', async () => {
    await mk('甲公司');
    await mk('乙公司');
    await mk('丙公司');
    expect((await list()).map((c) => c.name)).toEqual(['丙公司', '乙公司', '甲公司']);
  });

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
    expect(cps.map((c) => c.name)).toEqual(['B公司', 'A公司']); // 倒序：导入时新建的 B公司 在最前
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
