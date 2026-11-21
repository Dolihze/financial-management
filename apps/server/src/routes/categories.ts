import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';

const createSchema = z.object({
  name: z.string().trim().min(1).max(30),
  kind: z.enum(['income', 'expense']),
  parentId: z.string().nullable().optional()
});

const updateSchema = z.object({ name: z.string().trim().min(1).max(30) });

export function registerCategoryRoutes(app: FastifyInstance, { categories }: Services): void {
  app.get('/api/categories', async () => categories.list());
  app.post('/api/categories', async (req, reply) =>
    reply.status(201).send(categories.create(createSchema.parse(req.body)))
  );
  app.patch('/api/categories/:id', async (req) =>
    categories.update((req.params as { id: string }).id, updateSchema.parse(req.body))
  );
  /** 归档式删除：已使用的流水改挂内置兜底分类 */
  app.delete('/api/categories/:id', async (req) => categories.remove((req.params as { id: string }).id));
}
