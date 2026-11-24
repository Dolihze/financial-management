import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type BuiltApp } from './app';
import { sanitizeFileName } from './services/attachmentService';

let ctx: BuiltApp;
let dir: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fm-att-test-'));
  ctx = await buildApp({ host: '127.0.0.1', port: 0, dbPath: ':memory:', deviceId: 'test', attachmentsDir: dir });
});
afterEach(async () => {
  await ctx.app.close();
  rmSync(dir, { recursive: true, force: true });
});

const post = (url: string, payload: unknown) => ctx.app.inject({ method: 'POST', url, payload: payload as object });

function multipart(file: Buffer, filename: string, mime: string) {
  const boundary = '----fmatt';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, file, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }
  };
}

async function makeTx(): Promise<string> {
  const acc = (await post('/api/accounts', { name: '账户', type: 'bank', bankName: '行', accountNo: '1', openingBalance: 0 })).json() as { id: string };
  const tx = await post('/api/transactions', { occurredOn: '2026-05-01', type: 'expense', amount: 1000, accountId: acc.id });
  expect(tx.statusCode).toBe(201);
  return (tx.json() as { id: string }).id;
}

const upload = (txId: string, data: Buffer, name: string, mime: string) =>
  ctx.app.inject({ method: 'POST', url: `/api/transactions/${txId}/attachments`, ...multipart(data, name, mime) });

describe('流水附件（图片/文件）', () => {
  it('新增流水默认没有附件', async () => {
    const id = await makeTx();
    const tx = (await ctx.app.inject({ url: `/api/transactions/${id}` })).json() as { attachments: unknown[] };
    expect(tx.attachments).toEqual([]);
  });

  it('上传图片：返回元数据，落盘，列表与详情都带出附件，写审计', async () => {
    const id = await makeTx();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const res = await upload(id, png, '发票.png', 'image/png');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ txId: id, fileName: '发票.png', mimeType: 'image/png', size: 8 });

    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.png$/);

    const list = (await ctx.app.inject({ url: '/api/transactions' })).json() as { items: Array<{ attachments: Array<{ fileName: string }> }> };
    expect(list.items[0]!.attachments.map((a) => a.fileName)).toEqual(['发票.png']);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='tx' AND action='attach' AND entity_id=?").get(id)).toEqual({ n: 1 });
  });

  it('多个文件按上传顺序排列；PDF 和其他类型文件也可上传', async () => {
    const id = await makeTx();
    await upload(id, Buffer.from('%PDF-1.4'), '合同.pdf', 'application/pdf');
    await upload(id, Buffer.from('a,b'), '明细.csv', 'text/csv');
    const tx = (await ctx.app.inject({ url: `/api/transactions/${id}` })).json() as { attachments: Array<{ fileName: string }> };
    expect(tx.attachments.map((a) => a.fileName)).toEqual(['合同.pdf', '明细.csv']);
  });

  it('下载：内容与上传一致；图片/PDF 内联预览，其他类型强制下载；带 nosniff；中文文件名编码', async () => {
    const id = await makeTx();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);
    const a = (await upload(id, png, '发票.png', 'image/png')).json() as { id: string };
    const img = await ctx.app.inject({ url: `/api/attachments/${a.id}/file` });
    expect(img.statusCode).toBe(200);
    expect(img.rawPayload.equals(png)).toBe(true);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['content-disposition']).toBe(`inline; filename*=UTF-8''${encodeURIComponent('发票.png')}`);
    expect(img.headers['x-content-type-options']).toBe('nosniff');

    // 可执行内容（HTML）不能被当作页面打开：一律按下载 + octet-stream
    const h = (await upload(id, Buffer.from('<script>alert(1)</script>'), 'x.html', 'text/html')).json() as { id: string };
    const html = await ctx.app.inject({ url: `/api/attachments/${h.id}/file` });
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(String(html.headers['content-disposition'])).toMatch(/^attachment;/);
  });

  it('文件名中的路径成分被去掉，磁盘文件名由 id 生成（防路径穿越）', async () => {
    const id = await makeTx();
    const res = await upload(id, Buffer.from('x'), '..\\..\\evil/../../票据.JPG', 'image/jpeg');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ fileName: '票据.JPG' });
    const [stored] = readdirSync(dir);
    expect(stored).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(sanitizeFileName('a/b\\c.txt')).toBe('c.txt');
    expect(sanitizeFileName('  ')).toBe('未命名文件');
    expect(sanitizeFileName('x'.repeat(300) + '.pdf')).toHaveLength(120);
  });

  it('校验：流水不存在 404；空文件 400；没有文件 400；超过 20MB 返回 413 且不落盘不入库', async () => {
    expect((await upload('nope', Buffer.from('x'), 'a.png', 'image/png')).statusCode).toBe(404);
    const id = await makeTx();
    expect((await upload(id, Buffer.alloc(0), 'a.png', 'image/png')).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: `/api/transactions/${id}/attachments`, payload: {} })).statusCode).toBeGreaterThanOrEqual(400);

    const big = await upload(id, Buffer.alloc(20 * 1024 * 1024 + 1, 1), 'big.bin', 'application/octet-stream');
    expect(big.statusCode).toBe(413);
    expect(readdirSync(dir)).toHaveLength(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM tx_attachment').get()).toEqual({ n: 0 });
  });

  it('一笔流水最多 20 个文件', async () => {
    const id = await makeTx();
    for (let i = 0; i < 20; i++) expect((await upload(id, Buffer.from(String(i)), `${i}.txt`, 'text/plain')).statusCode).toBe(201);
    const over = await upload(id, Buffer.from('x'), 'over.txt', 'text/plain');
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ code: 'TOO_MANY_ATTACHMENTS' });
  });

  it('作废流水后附件仍保留且可查看；文件丢失时下载返回 404', async () => {
    const id = await makeTx();
    const a = (await upload(id, Buffer.from('hello'), 'a.txt', 'text/plain')).json() as { id: string };
    expect((await post(`/api/transactions/${id}/void`, { reason: 'x' })).statusCode).toBe(200);
    const voided = (await ctx.app.inject({ url: `/api/transactions/${id}` })).json() as { status: string; attachments: unknown[] };
    expect(voided.status).toBe('voided');
    expect(voided.attachments).toHaveLength(1);
    expect((await ctx.app.inject({ url: `/api/attachments/${a.id}/file` })).statusCode).toBe(200);

    rmSync(dir, { recursive: true, force: true });
    const missing = await ctx.app.inject({ url: `/api/attachments/${a.id}/file` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'FILE_MISSING' });
    expect((await ctx.app.inject({ url: '/api/attachments/nope/file' })).statusCode).toBe(404);
  });
});

describe('批次附件（相关文件）', () => {
  const makeBatch = async (batchNo = 1): Promise<string> => {
    const res = await post('/api/batches', { batchNo, note: '' });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  };
  const uploadBatch = (batchId: string, data: Buffer, name: string, mime: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/batches/${batchId}/attachments`, ...multipart(data, name, mime) });

  it('新增批次默认没有附件', async () => {
    const id = await makeBatch();
    const b = (await ctx.app.inject({ url: `/api/batches/${id}` })).json() as { attachments: unknown[] };
    expect(b.attachments).toEqual([]);
  });

  it('上传：返回元数据，落盘，批次列表与详情带出附件，按上传顺序，写审计', async () => {
    const id = await makeBatch();
    const res = await uploadBatch(id, Buffer.from('%PDF-1.4'), '合同.pdf', 'application/pdf');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ batchId: id, fileName: '合同.pdf', mimeType: 'application/pdf', size: 8 });
    await uploadBatch(id, Buffer.from('a,b'), '明细.csv', 'text/csv');

    expect(readdirSync(dir)).toHaveLength(2);
    const list = (await ctx.app.inject({ url: '/api/batches' })).json() as Array<{ id: string; attachments: Array<{ fileName: string }> }>;
    expect(list.find((b) => b.id === id)!.attachments.map((a) => a.fileName)).toEqual(['合同.pdf', '明细.csv']);
    const one = (await ctx.app.inject({ url: `/api/batches/${id}/attachments` })).json() as Array<{ fileName: string }>;
    expect(one.map((a) => a.fileName)).toEqual(['合同.pdf', '明细.csv']);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='batch' AND action='attach' AND entity_id=?").get(id)).toEqual({ n: 2 });
  });

  it('下载：内容一致；PDF 内联，HTML 强制下载；带 nosniff；不存在 404；文件丢失 FILE_MISSING', async () => {
    const id = await makeBatch();
    const pdf = Buffer.from('%PDF-1.4 x');
    const a = (await uploadBatch(id, pdf, '合同.pdf', 'application/pdf')).json() as { id: string };
    const ok = await ctx.app.inject({ url: `/api/batch-attachments/${a.id}/file` });
    expect(ok.statusCode).toBe(200);
    expect(ok.rawPayload.equals(pdf)).toBe(true);
    expect(ok.headers['content-type']).toBe('application/pdf');
    expect(ok.headers['x-content-type-options']).toBe('nosniff');

    const h = (await uploadBatch(id, Buffer.from('<script>1</script>'), 'x.html', 'text/html')).json() as { id: string };
    const html = await ctx.app.inject({ url: `/api/batch-attachments/${h.id}/file` });
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(String(html.headers['content-disposition'])).toMatch(/^attachment;/);

    expect((await ctx.app.inject({ url: '/api/batch-attachments/nope/file' })).statusCode).toBe(404);
    rmSync(dir, { recursive: true, force: true });
    const missing = await ctx.app.inject({ url: `/api/batch-attachments/${a.id}/file` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'FILE_MISSING' });
  });

  it('校验：批次不存在 404；空文件 400；超过 20MB 413 且不落盘不入库；最多 20 个', async () => {
    expect((await uploadBatch('nope', Buffer.from('x'), 'a.png', 'image/png')).statusCode).toBe(404);
    const id = await makeBatch();
    expect((await uploadBatch(id, Buffer.alloc(0), 'a.png', 'image/png')).statusCode).toBe(400);
    const big = await uploadBatch(id, Buffer.alloc(20 * 1024 * 1024 + 1, 1), 'big.bin', 'application/octet-stream');
    expect(big.statusCode).toBe(413);
    expect(readdirSync(dir)).toHaveLength(0);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM batch_attachment').get()).toEqual({ n: 0 });

    for (let i = 0; i < 20; i++) expect((await uploadBatch(id, Buffer.from(String(i)), `${i}.txt`, 'text/plain')).statusCode).toBe(201);
    const over = await uploadBatch(id, Buffer.from('x'), 'over.txt', 'text/plain');
    expect(over.statusCode).toBe(400);
    expect(over.json()).toMatchObject({ code: 'TOO_MANY_ATTACHMENTS' });
  });

  it('删除文件 = 软删除：列表/下载不再返回，记录与磁盘文件保留，写审计，释放名额；重复删除 404', async () => {
    const id = await makeBatch();
    const a = (await uploadBatch(id, Buffer.from('aaa'), 'a.txt', 'text/plain')).json() as { id: string };
    const b = (await uploadBatch(id, Buffer.from('bbb'), 'b.txt', 'text/plain')).json() as { id: string };

    const res = await post(`/api/batch-attachments/${a.id}/remove`, {});
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.id, fileName: 'a.txt' });

    const detail = (await ctx.app.inject({ url: `/api/batches/${id}` })).json() as { attachments: Array<{ id: string }> };
    expect(detail.attachments.map((x) => x.id)).toEqual([b.id]);
    const list = (await ctx.app.inject({ url: `/api/batches/${id}/attachments` })).json() as Array<{ id: string }>;
    expect(list.map((x) => x.id)).toEqual([b.id]);
    expect((await ctx.app.inject({ url: `/api/batch-attachments/${a.id}/file` })).statusCode).toBe(404);

    // 不物理删除：行和磁盘文件都还在
    expect(ctx.db.prepare('SELECT deleted_at IS NOT NULL AS d FROM batch_attachment WHERE id = ?').get(a.id)).toEqual({ d: 1 });
    expect(readdirSync(dir)).toHaveLength(2);
    expect(ctx.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='batch' AND action='detach' AND entity_id=?").get(id)).toEqual({ n: 1 });

    expect((await post(`/api/batch-attachments/${a.id}/remove`, {})).statusCode).toBe(404);
    expect((await post('/api/batch-attachments/nope/remove', {})).statusCode).toBe(404);
  });

  it('已删除的文件不占 20 个名额，删除后可补传', async () => {
    const id = await makeBatch();
    const first = (await uploadBatch(id, Buffer.from('0'), '0.txt', 'text/plain')).json() as { id: string };
    for (let i = 1; i < 20; i++) expect((await uploadBatch(id, Buffer.from(String(i)), `${i}.txt`, 'text/plain')).statusCode).toBe(201);
    expect((await uploadBatch(id, Buffer.from('x'), 'over.txt', 'text/plain')).statusCode).toBe(400);
    await post(`/api/batch-attachments/${first.id}/remove`, {});
    expect((await uploadBatch(id, Buffer.from('x'), 'again.txt', 'text/plain')).statusCode).toBe(201);
  });

  it('批次删除（归档）后附件记录仍保留', async () => {
    const id = await makeBatch();
    const a = (await uploadBatch(id, Buffer.from('hello'), 'a.txt', 'text/plain')).json() as { id: string };
    expect((await post(`/api/batches/${id}/archive`, {})).statusCode).toBe(200);
    expect(ctx.db.prepare('SELECT COUNT(*) AS n FROM batch_attachment WHERE id = ?').get(a.id)).toEqual({ n: 1 });
    expect((await ctx.app.inject({ url: `/api/batch-attachments/${a.id}/file` })).statusCode).toBe(200);
  });
});
