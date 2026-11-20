import type { FastifyInstance } from 'fastify';
import type { Services } from '../app';
import { AppError } from '../utils';

export function registerImportRoutes(app: FastifyInstance, { imports }: Services): void {
  app.get('/api/imports/template', async (_req, reply) => {
    const buf = await imports.buildTemplate();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('流水导入模板.xlsx')}`)
      .send(buf);
  });

  app.get('/api/imports', async () => imports.listBatches());

  /** 预览：multipart 上传 file，不写库 */
  app.post('/api/imports/preview', async (req) => {
    const file = await req.file();
    if (!file) throw new AppError('请上传 Excel 文件');
    return imports.preview(await file.toBuffer());
  });

  /** 确认导入：query skipDuplicates=true 时跳过与已有流水重复的行 */
  app.post('/api/imports/commit', async (req, reply) => {
    const file = await req.file();
    if (!file) throw new AppError('请上传 Excel 文件');
    const skipDuplicates = (req.query as { skipDuplicates?: string }).skipDuplicates === 'true';
    const batch = await imports.commit(await file.toBuffer(), file.filename, { skipDuplicates });
    return reply.status(201).send(batch);
  });

  app.post('/api/imports/:id/revert', async (req) => imports.revert((req.params as { id: string }).id));
}
