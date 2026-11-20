import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';

const createSchema = z.object({
  name: z.string().trim().min(1).max(30),
  kind: z.enum(['income', 'expense']),
  parentId: z.string().nullable().optional()
});

export function registerCategoryRoutes(app: FastifyInstance, { categories }: Services): void {
  app.get('/api/categories', async () => categories.list());
  app.post('/api/categories', async (req, reply) =>
    reply.status(201).send(categories.create(createSchema.parse(req.body)))
  );
}
