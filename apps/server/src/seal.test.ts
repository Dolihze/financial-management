import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from './app';

/**
 * 批次存档：手动挑选批次进入存档，存档时校验批次下所有项目「上海院已支付 / 支付下家 / 支付陈沛」全为是；
 * 存档批次整批只读（批次、合同、项目、文件、Excel 导入），取消存档后恢复可编辑。
 */
let ctx: BuiltApp;
beforeEach(async () => {
  ctx = await buildApp({ host: '127.0.0.1', port: 0, dbPath: ':memory:', deviceId: 'test' });
});
afterEach(async () => {
  await ctx.app.close();
});

const post = (url: string, payload: unknown = {}) => ctx.app.inject({ method: 'POST', url, payload: payload as object });
const patch = (url: string, payload: unknown) => ctx.app.inject({ method: 'PATCH', url, payload: payload as object });
const get = async (url: string) => (await ctx.app.inject({ url })).json();

function multipart(file: Buffer, filename = 'a.xlsx', contentType = 'application/octet-stream') {
  const boundary = '----fmtest';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return { payload: Buffer.concat([head, file, tail]), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

async function projectXlsx(rows: unknown[][]): Promise<Buffer> {
  const headers = ['合同编号', '批次', '区域', '项目名称', '合同价'];
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('s');
  ws.addRow(headers);
  ws.addRow(['', '', '', '合计', 999]);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

let accountId = '';
beforeEach(async () => {
  const res = await post('/api/accounts', { name: '入账户', type: 'bank', bankName: '测试银行', accountNo: '6222000011112222', openingBalance: 0 });
  accountId = (res.json() as { id: string }).id;
});

interface Seeded {
  batchId: string;
  contractId: string;
  projectIds: string[];
}

/** 建一个批次 + 一个合同 + n 个项目；flags 为每个项目的三项流程（上海院已支付 / 支付下家 / 支付陈沛）是否为是 */
async function seed(batchNo: number, flags: Array<[boolean, boolean, boolean]>, contractNo = `HT-${batchNo}`): Promise<Seeded> {
  const batchId = ((await post('/api/batches', { batchNo })).json() as { id: string }).id;
  const projectIds: string[] = [];
  for (const [i] of flags.entries()) {
    const p = (await post('/api/projects', {
      region: '天水', name: `项目${batchNo}-${i + 1}`, contractPrice: 1000, qxReceived: 800, qxSubcontractFee: 400, chenPei: 50, qxProfit: 350
    })).json() as { id: string };
    projectIds.push(p.id);
  }
  const contract = (await post('/api/contracts', {
    batchId, contractNo, projects: projectIds.map((projectId) => ({ projectId, contractPrice: 1000 }))
  })).json() as { id: string };
  for (const [i, f] of flags.entries()) await setFlags(projectIds[i]!, f);
  return { batchId, contractId: contract.id, projectIds };
}

/** 把项目三项流程设为指定值（需要入账的字段带入账账户） */
async function setFlags(projectId: string, [sh, sub, chen]: [boolean, boolean, boolean]) {
  const p = await get(`/api/projects/${projectId}`);
  const res = await patch(`/api/projects/${projectId}`, {
    ...p, shPaid: sh, paidSubcontractor: sub, paidChenPei: chen, postingAccountId: accountId, postingDate: '2026-03-15'
  });
  expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
}

const DONE: [boolean, boolean, boolean] = [true, true, true];
const sealed = async (v: boolean) => ((await get(`/api/batches?sealed=${v}`)) as Array<{ id: string; batchNo: number }>).map((b) => b.batchNo).sort((a, b) => a - b);

describe('存档：挑选批次 + 校验', () => {
  it('新批次默认在「正在结算中」（sealedAt 为 null）；?sealed 过滤：false = 正在结算中，true = 存档，省略 = 全部', async () => {
    const a = await seed(1, [DONE]);
    await seed(2, [DONE]);
    expect(await sealed(false)).toEqual([1, 2]);
    expect(await sealed(true)).toEqual([]);
    expect(await get(`/api/batches/${a.batchId}`)).toMatchObject({ sealedAt: null });

    const res = await post('/api/batches/seal', { batchIds: [a.batchId] });
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ id: a.batchId, batchNo: 1 });
    expect(res.json()[0].sealedAt).toEqual(expect.any(String));
    expect(await sealed(false)).toEqual([2]);
    expect(await sealed(true)).toEqual([1]);
    expect(((await get('/api/batches')) as unknown[]).length).toBe(2); // 省略 = 全部
    expect((await ctx.app.inject({ url: '/api/batches?sealed=maybe' })).statusCode).toBe(400);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='batch' AND action='seal'").get()).toEqual({ n: 1 });
  });

  it('校验：批次下有项目三项没走完 -> 409 拒绝并指出是哪个项目、缺哪一步；批次保持未存档', async () => {
    const b = await seed(3, [DONE, [true, false, true], [false, false, false]]);
    const res = await post('/api/batches/seal', { batchIds: [b.batchId] });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'BATCH_NOT_FINISHED' });
    const msg = res.json().message as string;
    expect(msg).toContain('第 3 批');
    expect(msg).toContain('2 个项目');
    expect(msg).toContain('项目3-2'); // 缺「支付下家」
    expect(msg).toMatch(/项目3-2.*支付下家/);
    expect(msg).toContain('项目3-3'); // 三项都缺
    expect(msg).toMatch(/项目3-3.*上海院已支付、支付下家、支付陈沛/);
    expect(msg).not.toContain('项目3-1'); // 走完的不列出
    expect(await sealed(true)).toEqual([]);
  });

  it('三项里任意一项为否都算没走完：逐项验证', async () => {
    const cases: Array<[number, [boolean, boolean, boolean], string]> = [
      [10, [false, true, true], '上海院已支付'],
      [11, [true, false, true], '支付下家'],
      [12, [true, true, false], '支付陈沛']
    ];
    for (const [no, flags, missing] of cases) {
      const b = await seed(no, [flags]);
      const res = await post('/api/batches/seal', { batchIds: [b.batchId] });
      expect(res.statusCode, `batch ${no}`).toBe(409);
      expect(res.json().message).toContain(`未完成：${missing}）`);
    }
  });

  it('补完最后一项后即可存档（校验按存档当下的数据）', async () => {
    const b = await seed(4, [[true, true, false]]);
    expect((await post('/api/batches/seal', { batchIds: [b.batchId] })).statusCode).toBe(409);
    await setFlags(b.projectIds[0]!, DONE);
    expect((await post('/api/batches/seal', { batchIds: [b.batchId] })).statusCode).toBe(200);
  });

  it('一次挑选多个批次：任一不满足则整体拒绝，满足的也都不存档（事务）', async () => {
    const ok = await seed(5, [DONE, DONE]);
    const bad = await seed(6, [DONE, [true, true, false]]);
    const res = await post('/api/batches/seal', { batchIds: [ok.batchId, bad.batchId] });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('第 6 批');
    expect(res.json().message).not.toContain('第 5 批');
    expect(await sealed(true)).toEqual([]); // 第 5 批也没存档

    const both = await post('/api/batches/seal', { batchIds: [ok.batchId] });
    expect(both.statusCode).toBe(200);
    expect(await sealed(true)).toEqual([5]);
  });

  it('一次挑选多个都满足的批次：全部存档；重复的 id 只算一次', async () => {
    const a = await seed(7, [DONE]);
    const b = await seed(8, [DONE]);
    const res = await post('/api/batches/seal', { batchIds: [a.batchId, b.batchId, a.batchId] });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
    expect(await sealed(true)).toEqual([7, 8]);
  });

  it('空批次（没有任何合同/项目）可以存档；已被删除（归档）的项目不计入校验', async () => {
    const empty = ((await post('/api/batches', { batchNo: 20 })).json() as { id: string }).id;
    expect((await post('/api/batches/seal', { batchIds: [empty] })).statusCode).toBe(200);

    // 未走完的项目被删除后，不再阻碍存档
    const b = await seed(21, [DONE, [false, false, false]]);
    expect((await post('/api/batches/seal', { batchIds: [b.batchId] })).statusCode).toBe(409);
    expect((await post(`/api/projects/${b.projectIds[1]}/archive`)).statusCode).toBe(200);
    expect((await post('/api/batches/seal', { batchIds: [b.batchId] })).statusCode).toBe(200);
  });

  it('入参校验：不能为空；批次不存在 404；已是存档状态再存档 409；不落库', async () => {
    expect((await post('/api/batches/seal', { batchIds: [] })).statusCode).toBe(400);
    expect((await post('/api/batches/seal', {})).statusCode).toBe(400);
    expect((await post('/api/batches/seal', { batchIds: ['nope'] })).statusCode).toBe(404);
    const b = await seed(22, [DONE]);
    expect((await post('/api/batches/seal', { batchIds: [b.batchId] })).statusCode).toBe(200);
    const again = await post('/api/batches/seal', { batchIds: [b.batchId] });
    expect(again.statusCode).toBe(409);
    expect(again.json().message).toContain('已经是存档状态');
  });
});

describe('存档批次整批只读', () => {
  const sealOne = async (flags: Array<[boolean, boolean, boolean]> = [DONE], no = 30) => {
    const s = await seed(no, flags);
    expect((await post('/api/batches/seal', { batchIds: [s.batchId] })).statusCode).toBe(200);
    return s;
  };
  const expectSealed = (res: { statusCode: number; json: () => unknown }) => {
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'BATCH_SEALED' });
  };

  it('批次：不能改批次号/备注、不能删除', async () => {
    const s = await sealOne();
    expectSealed(await patch(`/api/batches/${s.batchId}`, { batchNo: 30, note: '改备注' }));
    expectSealed(await post(`/api/batches/${s.batchId}/archive`));
    expect(await get(`/api/batches/${s.batchId}`)).toMatchObject({ note: '' });
  });

  it('合同：不能编辑、不能删除、不能加入项目；也不能往存档批次里新增合同，或把合同移进来', async () => {
    const s = await sealOne();
    expectSealed(await patch(`/api/contracts/${s.contractId}`, { contractNo: 'HT-改', projects: [] }));
    expectSealed(await post(`/api/contracts/${s.contractId}/archive`));
    const extra = (await post('/api/projects', { region: '', name: '新项目', contractPrice: 1, qxReceived: 0, qxSubcontractFee: 0, chenPei: 0, qxProfit: 0 })).json() as { id: string };
    expectSealed(await patch(`/api/contracts/${s.contractId}`, { contractNo: 'HT-30', projects: [{ projectId: extra.id, contractPrice: 1 }] }));
    expectSealed(await post('/api/contracts', { batchId: s.batchId, contractNo: 'HT-新', projects: [{ projectId: extra.id, contractPrice: 1 }] }));

    // 把别的批次里的合同移进存档批次也不行
    const other = await seed(31, [DONE]);
    expectSealed(await patch(`/api/contracts/${other.contractId}`, { batchId: s.batchId, contractNo: 'HT-31', projects: [] }));
    expect(await get(`/api/projects/${extra.id}`)).toMatchObject({ contractId: null }); // 都没生效
    expect(await get(`/api/contracts/${s.contractId}`)).toMatchObject({ contractNo: 'HT-30', projectCount: 1 });
  });

  it('项目：不能编辑（包括切换三项流程）、不能删除、不能换到存档批次下的合同；未归入合同的项目不受影响', async () => {
    const s = await sealOne();
    const pid = s.projectIds[0]!;
    const p = await get(`/api/projects/${pid}`);
    expectSealed(await patch(`/api/projects/${pid}`, { ...p, region: '改区域' }));
    expectSealed(await patch(`/api/projects/${pid}`, { ...p, shPaid: false })); // 想回退入账也不行
    expectSealed(await post(`/api/projects/${pid}/archive`));
    expect(await get(`/api/projects/${pid}`)).toMatchObject({ region: '天水', shPaid: true, paidSubcontractor: true, paidChenPei: true });

    // 其他批次下的项目不能被换进存档批次的合同
    const other = await seed(32, [DONE]);
    const op = await get(`/api/projects/${other.projectIds[0]}`);
    expectSealed(await patch(`/api/projects/${other.projectIds[0]}`, { ...op, contractId: s.contractId }));

    // 未归入合同的项目不属于任何批次：照常可编辑
    const free = (await post('/api/projects', { region: '', name: '自由项目', contractPrice: 1, qxReceived: 0, qxSubcontractFee: 0, chenPei: 0, qxProfit: 0 })).json() as { id: string };
    const { contractId: _none, ...fp } = (await get(`/api/projects/${free.id}`)) as Record<string, unknown>; // contractId 为 null 时不能原样回传
    expect((await patch(`/api/projects/${free.id}`, { ...fp, region: '新区域' })).statusCode).toBe(200);
  });

  it('批次相关文件：不能上传、不能删除；已有文件仍可查看', async () => {
    const s = await seed(33, [DONE]);
    const up = await ctx.app.inject({ method: 'POST', url: `/api/batches/${s.batchId}/attachments`, ...multipart(Buffer.from('hello'), 'a.txt', 'text/plain') });
    expect(up.statusCode).toBe(201);
    const fileId = (up.json() as { id: string }).id;
    expect((await post('/api/batches/seal', { batchIds: [s.batchId] })).statusCode).toBe(200);

    expectSealed(await ctx.app.inject({ method: 'POST', url: `/api/batches/${s.batchId}/attachments`, ...multipart(Buffer.from('x'), 'b.txt', 'text/plain') }));
    expectSealed(await post(`/api/batch-attachments/${fileId}/remove`));
    expect(((await get(`/api/batches/${s.batchId}`)) as { attachments: unknown[] }).attachments).toHaveLength(1);
    expect((await ctx.app.inject({ url: `/api/batch-attachments/${fileId}/file` })).statusCode).toBe(200); // 仍可查看/下载
  });

  it('存档批次仍可读取：批次、合同、项目列表与详情都正常返回', async () => {
    const s = await sealOne([DONE, DONE]);
    expect(await get(`/api/batches/${s.batchId}`)).toMatchObject({ batchNo: 30, contractCount: 1, projectCount: 2 });
    expect(((await get(`/api/contracts?batchId=${s.batchId}`)) as unknown[]).length).toBe(1);
    expect(((await get(`/api/projects?contractId=${s.contractId}`)) as unknown[]).length).toBe(2);
  });

  it('Excel 导入不能触碰存档批次：更新其下项目 / 引用其合同编号 / 在其中新建合同，都按行报错且整批不入库', async () => {
    const s = await sealOne([DONE], 40);
    const commit = async (rows: unknown[][]) =>
      ctx.app.inject({ method: 'POST', url: '/api/projects/import/commit', ...multipart(await projectXlsx(rows)) });
    const preview = async (rows: unknown[][]) =>
      (await ctx.app.inject({ method: 'POST', url: '/api/projects/import/preview', ...multipart(await projectXlsx(rows)) })).json() as {
        errors: Array<{ row: number; message: string }>;
      };
    const projectCount = () => (ctx.db.prepare('SELECT COUNT(*) AS n FROM project').get() as { n: number }).n;
    const before = projectCount();

    const rows = [
      ['', '', '天水', '正常新项目', 100], // 第 3 行：没有合同，合法
      ['HT-40', '', '天水', '项目40-1', 999], // 第 4 行：更新存档批次下的项目（合同编号不变）
      ['HT-40', '', '天水', '引用存档合同', 100], // 第 5 行：新项目引用存档批次的合同
      ['HT-新合同', 40, '天水', '建在存档批次里', 100] // 第 6 行：新合同按 Excel 批次落在存档批次
    ];
    const pv = await preview(rows);
    expect(pv.errors.map((e) => e.row)).toEqual([4, 5, 6]);
    expect(pv.errors[0]!.message).toContain('已存档');
    expect(pv.errors[0]!.message).toContain('第 40 批');
    expect(pv.errors[2]!.message).toContain('将创建在已存档的「第 40 批」');
    const res = await commit(rows);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'IMPORT_INVALID' });
    expect(projectCount()).toBe(before); // 合法的第 3 行也没入库
    expect(await get(`/api/projects/${s.projectIds[0]}`)).toMatchObject({ contractPrice: 1000 });

    // 导入到别的批次 / 没有合同的行不受影响
    expect((await commit([['', '', '天水', '正常新项目', 100], ['HT-别处', 41, '天水', '别处项目', 100]])).statusCode).toBe(201);
  });
});

describe('取消存档', () => {
  it('取消后回到正在结算中，恢复可编辑；写审计；非存档状态取消 409；不存在 404', async () => {
    const s = await seed(50, [DONE]);
    expect((await post(`/api/batches/${s.batchId}/unseal`)).statusCode).toBe(409); // 还没存档
    expect((await post('/api/batches/seal', { batchIds: [s.batchId] })).statusCode).toBe(200);
    expect((await patch(`/api/batches/${s.batchId}`, { batchNo: 50, note: 'x' })).statusCode).toBe(409);

    const res = await post(`/api/batches/${s.batchId}/unseal`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: s.batchId, sealedAt: null });
    expect(await sealed(false)).toEqual([50]);
    expect(await sealed(true)).toEqual([]);
    expect((await patch(`/api/batches/${s.batchId}`, { batchNo: 50, note: '取消后可改' })).statusCode).toBe(200);
    const p = await get(`/api/projects/${s.projectIds[0]}`);
    expect((await patch(`/api/projects/${s.projectIds[0]}`, { ...p, region: '改区域' })).statusCode).toBe(200);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='batch' AND action='unseal'").get()).toEqual({ n: 1 });
    expect((await post('/api/batches/nope/unseal')).statusCode).toBe(404);
  });

  it('取消存档后项目可改回未走完，此时再存档要重新校验', async () => {
    const s = await seed(51, [DONE]);
    await post('/api/batches/seal', { batchIds: [s.batchId] });
    await post(`/api/batches/${s.batchId}/unseal`);
    await setFlags(s.projectIds[0]!, [true, true, false]); // 回退「支付陈沛」
    const res = await post('/api/batches/seal', { batchIds: [s.batchId] });
    expect(res.statusCode).toBe(409);
    expect(res.json().message).toContain('未完成：支付陈沛');
  });
});
