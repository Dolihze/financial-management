import type { FastifyInstance } from 'fastify';
import { ACCOUNT_TYPES } from '@fm/shared';
import { z } from 'zod';
import type { Services } from '../app';

const createSchema = z.object({
  name: z.string().trim().min(1).max(50),
  type: z.enum(ACCOUNT_TYPES),
  openingBalance: z.number().int().default(0),
  currency: z.string().default('CNY'),
  bankName: z.string().trim().max(100).default(''),
  accountNo: z.string().trim().max(50).default(''),
  note: z.string().max(200).default('')
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(50).optional(),
  type: z.enum(ACCOUNT_TYPES).optional(),
  note: z.string().max(200).optional()
});

export function registerAccountRoutes(app: FastifyInstance, { accounts }: Services): void {
  app.get('/api/accounts', async (req) => {
    const { includeArchived } = z.object({ includeArchived: z.coerce.boolean().optional() }).parse(req.query);
    return accounts.list(includeArchived ?? false);
  });

  app.get('/api/accounts/:id', async (req) => accounts.get((req.params as { id: string }).id));

  app.post('/api/accounts', async (req, reply) => {
    const created = accounts.create(createSchema.parse(req.body));
    return reply.status(201).send(created);
  });

  app.patch('/api/accounts/:id', async (req) =>
    accounts.update((req.params as { id: string }).id, updateSchema.parse(req.body))
  );

  app.post('/api/accounts/:id/archive', async (req) => accounts.archive((req.params as { id: string }).id));
}
