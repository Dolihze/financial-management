import type { FastifyInstance } from 'fastify';
import type { Services } from '../app';
import { AppError } from '../utils';

export function registerProjectRoutes(app: FastifyInstance, { projects }: Services): void {
  app.get('/api/projects', async () => projects.list());

  // 注意：固定路径必须先于 /api/projects/:id 注册
  app.get('/api/projects/import/template', async (_req, reply) => {
    const buf = await projects.buildTemplate();
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent('项目导入模板.xlsx')}`)
      .send(buf);
  });

  /** 预览：multipart 上传 file，不写库 */
  app.post('/api/projects/import/preview', async (req) => {
    const file = await req.file();
    if (!file) throw new AppError('请上传 Excel 文件');
    return projects.preview(await file.toBuffer());
  });

  /** 确认导入：合同编号已存在则更新，否则新增 */
  app.post('/api/projects/import/commit', async (req, reply) => {
    const file = await req.file();
    if (!file) throw new AppError('请上传 Excel 文件');
    const result = await projects.commit(await file.toBuffer(), file.filename);
    return reply.status(201).send(result);
  });

  app.get('/api/projects/:id', async (req) => projects.get((req.params as { id: string }).id));
}
