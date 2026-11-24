import type { FastifyInstance } from 'fastify';
import { TRANSACTION_TYPES } from '@fm/shared';
import { z } from 'zod';
import type { Services } from '../app';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

const createSchema = z.object({
  occurredOn: dateSchema,
  type: z.enum(TRANSACTION_TYPES),
  amount: z.number().int().positive(),
  accountId: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  counterpartyId: z.string().nullable().optional(),
  note: z.string().max(500).optional()
});

const querySchema = z.object({
  accountId: z.string().optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  categoryId: z.string().optional(),
  counterpartyId: z.string().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  keyword: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

export function registerTransactionRoutes(app: FastifyInstance, { transactions }: Services): void {
  app.get('/api/transactions', async (req) => {
    const q = querySchema.parse(req.query);
    return transactions.list(q);
  });

  // 与列表相同的筛选条件，返回全部命中数据（不分页）的盈亏统计
  app.get('/api/transactions/summary', async (req) => {
    const q = querySchema.parse(req.query);
    return transactions.summary(q);
  });

  app.get('/api/transactions/:id', async (req) => transactions.get((req.params as { id: string }).id));

  app.post('/api/transactions', async (req, reply) =>
    reply.status(201).send(transactions.create(createSchema.parse(req.body)))
  );

  // 编辑：全部字段整体提交（与新增同一套校验）；附件的增删走附件接口
  app.patch('/api/transactions/:id', async (req) =>
    transactions.update((req.params as { id: string }).id, createSchema.parse(req.body))
  );

  // 删除：物理删除（分录、附件一并删除），写审计
  app.delete('/api/transactions/:id', async (req) => {
    transactions.remove((req.params as { id: string }).id);
    return { ok: true };
  });
}
