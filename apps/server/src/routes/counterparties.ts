import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';

const bodySchema = z.object({ name: z.string().trim().min(1).max(100) });

export function registerCounterpartyRoutes(app: FastifyInstance, { counterparties }: Services): void {
  app.get('/api/counterparties', async () => counterparties.list());
  app.post('/api/counterparties', async (req, reply) =>
    reply.status(201).send(counterparties.create(bodySchema.parse(req.body)))
  );
  app.patch('/api/counterparties/:id', async (req) =>
    counterparties.update((req.params as { id: string }).id, bodySchema.parse(req.body))
  );
  /** 归档式删除：关联流水解除关联但保留名称快照 */
  app.delete('/api/counterparties/:id', async (req) => counterparties.remove((req.params as { id: string }).id));
}
