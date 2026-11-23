import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';
import { AppError } from '../utils';

/** 金额一律整数分（前端用 toCents 转换后再提交） */
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const updateSchema = z.object({
  batchNo: z.number().int().min(0).nullable(),
  region: z.string().trim().max(50),
  name: z.string().trim().min(1).max(100),
  contractPrice: cents,
  qxReceived: cents,
  qxSubcontractFee: cents,
  chenPei: cents,
  qxProfit: cents,
  /** 项目结算：可省略，省略时保持原值（不入账/不回退） */
  qxMoneyReceived: z.boolean().optional(),
  paidSubcontractor: z.boolean(),
  paidChenPei: z.boolean(),
  /** 备注：可省略，省略时保持库里原值 */
  note: z.string().trim().max(500).optional(),
  /** 本次保存有字段从否切到是（入账）时必填，在服务层校验 */
  postingAccountId: z.string().min(1).optional(),
  /** 入账日期，YYYY-MM-DD，且必须是真实存在的日期 */
  postingDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '入账日期格式应为 YYYY-MM-DD')
    .refine((s) => {
      const d = new Date(s + 'T00:00:00Z');
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, '入账日期不是有效日期')
    .optional()
});

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

  /** 修改项目（整体保存）。手工修改会在下次导入同名项目时被 Excel 覆盖 */
  app.patch('/api/projects/:id', async (req) =>
    projects.update((req.params as { id: string }).id, updateSchema.parse(req.body))
  );

  /** 「删除」项目：不物理删除，仅归档 */
  app.post('/api/projects/:id/archive', async (req) => projects.archive((req.params as { id: string }).id));
}
