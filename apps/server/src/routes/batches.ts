import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';
import { MAX_BATCH_NO } from '../services/batchService';

const bodySchema = z.object({
  batchNo: z
    .number({ invalid_type_error: '批次号必须是数字' })
    .int('批次号必须是整数')
    .min(0, '批次号不能为负数')
    .max(MAX_BATCH_NO, '批次号过大'),
  note: z.string().trim().max(200, '备注不能超过 200 个字符').optional()
});

const sealSchema = z.object({
  batchIds: z.array(z.string().min(1)).min(1, '请至少选择一个批次').max(1000)
});

export function registerBatchRoutes(app: FastifyInstance, { batches }: Services): void {
  /** 批次列表；?sealed=false 只返回正在结算中的批次，?sealed=true 只返回存档的批次，省略 = 全部 */
  app.get('/api/batches', async (req) => {
    const { sealed } = z.object({ sealed: z.enum(['true', 'false']).optional() }).parse(req.query);
    return batches.list(sealed === undefined ? undefined : sealed === 'true');
  });

  /**
   * 存档：手动挑选若干批次；存档时再校验一次，批次下所有项目的上海院已支付 / 支付下家 / 支付陈沛必须全部为是，
   * 任一批次不满足则 409 并整体拒绝（都不存档）。固定路径，先于 /api/batches/:id 注册。
   */
  app.post('/api/batches/seal', async (req) => batches.seal(sealSchema.parse(req.body).batchIds));

  /** 取消存档：把批次放回正在结算中 */
  app.post('/api/batches/:id/unseal', async (req) => batches.unseal((req.params as { id: string }).id));

  app.get('/api/batches/:id', async (req) => batches.get((req.params as { id: string }).id));

  app.post('/api/batches', async (req, reply) => reply.status(201).send(batches.create(bodySchema.parse(req.body))));

  app.patch('/api/batches/:id', async (req) => batches.update((req.params as { id: string }).id, bodySchema.parse(req.body)));

  /** 「删除」批次：不物理删除，仅归档；批次下有合同时拒绝 */
  app.post('/api/batches/:id/archive', async (req) => batches.remove((req.params as { id: string }).id));
}
