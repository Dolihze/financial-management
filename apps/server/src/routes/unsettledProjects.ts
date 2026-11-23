import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';

/** 金额：整数分，非负，不超过安全整数 */
const cents = (label: string) =>
  z
    .number({ invalid_type_error: `${label}必须是数字` })
    .int(`${label}必须是整数分`)
    .min(0, `${label}不能为负数`)
    .max(Number.MAX_SAFE_INTEGER, `${label}过大`);

const bodySchema = z.object({
  region: z.string({ invalid_type_error: '区域必须是文本' }).trim().max(100, '区域不能超过 100 个字符'),
  name: z.string({ required_error: '项目名称不能为空' }).trim().min(1, '项目名称不能为空').max(200, '项目名称不能超过 200 个字符'),
  contractPrice: cents('合同价'),
  qxReceived: cents('企信实收'),
  qxSubcontractFee: cents('企信支付下家分包费'),
  chenPei: cents('陈沛'),
  qxProfit: cents('企信利润')
});

export function registerUnsettledProjectRoutes(app: FastifyInstance, { unsettledProjects }: Services): void {
  app.get('/api/unsettled-projects', async () => unsettledProjects.list());

  // 注意：固定路径必须先于 /api/unsettled-projects/:id 注册
  /** 可选区域列表（已结算 + 未结算项目的区域并集，去重），供区域下拉选择 */
  app.get('/api/unsettled-projects/regions', async () => unsettledProjects.regions());

  app.get('/api/unsettled-projects/:id', async (req) => unsettledProjects.get((req.params as { id: string }).id));

  app.post('/api/unsettled-projects', async (req, reply) =>
    reply.status(201).send(unsettledProjects.create(bodySchema.parse(req.body)))
  );

  app.patch('/api/unsettled-projects/:id', async (req) =>
    unsettledProjects.update((req.params as { id: string }).id, bodySchema.parse(req.body))
  );

  /** 「删除」：不物理删除，仅归档 */
  app.post('/api/unsettled-projects/:id/archive', async (req) => unsettledProjects.remove((req.params as { id: string }).id));
}
