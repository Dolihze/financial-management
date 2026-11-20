import type { FastifyInstance } from 'fastify';
import { TRANSACTION_TYPES } from '@fm/shared';
import { z } from 'zod';
import type { Services } from '../app';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

const createSchema = z.object({
  occurredOn: dateSchema,
  type: z.enum(TRANSACTION_TYPES),
  summary: z.string().trim().min(1).max(200),
  amount: z.number().int().positive(),
  accountId: z.string().optional(),
  fromAccountId: z.string().optional(),
  toAccountId: z.string().optional(),
  categoryId: z.string().nullable().optional(),
  counterparty: z.string().max(100).optional(),
  note: z.string().max(500).optional()
});

const querySchema = z.object({
  accountId: z.string().optional(),
  type: z.enum(TRANSACTION_TYPES).optional(),
  categoryId: z.string().optional(),
  from: dateSchema.optional(),
  to: dateSchema.optional(),
  keyword: z.string().optional(),
  includeVoided: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional()
});

export function registerTransactionRoutes(app: FastifyInstance, { transactions }: Services): void {
  app.get('/api/transactions', async (req) => {
    const q = querySchema.parse(req.query);
    return transactions.list({ ...q, includeVoided: q.includeVoided === 'true' });
  });

  app.get('/api/transactions/:id', async (req) => transactions.get((req.params as { id: string }).id));

  app.post('/api/transactions', async (req, reply) =>
    reply.status(201).send(transactions.create(createSchema.parse(req.body)))
  );

  app.post('/api/transactions/:id/void', async (req) => {
    const { reason } = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
    return transactions.void((req.params as { id: string }).id, reason);
  });
}
