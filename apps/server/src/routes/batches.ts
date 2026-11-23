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

export function registerBatchRoutes(app: FastifyInstance, { batches }: Services): void {
  app.get('/api/batches', async () => batches.list());

  app.get('/api/batches/:id', async (req) => batches.get((req.params as { id: string }).id));

  app.post('/api/batches', async (req, reply) => reply.status(201).send(batches.create(bodySchema.parse(req.body))));

  app.patch('/api/batches/:id', async (req) => batches.update((req.params as { id: string }).id, bodySchema.parse(req.body)));

  /** 「删除」批次：不物理删除，仅归档；批次下有合同时拒绝 */
  app.post('/api/batches/:id/archive', async (req) => batches.remove((req.params as { id: string }).id));
}
