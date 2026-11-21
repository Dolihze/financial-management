import type { FastifyInstance } from 'fastify';
import { PROJECT_STATUSES } from '@fm/shared';
import { z } from 'zod';
import type { Services } from '../app';

const createSchema = z.object({
  name: z.string().trim().min(1).max(100),
  designNo: z.string().trim().max(50).default(''),
  contractNo: z.string().trim().max(50).default(''),
  status: z.enum(PROJECT_STATUSES).default('unsettled')
});

export function registerProjectRoutes(app: FastifyInstance, { projects }: Services): void {
  app.get('/api/projects', async () => projects.list());
  app.get('/api/projects/:id', async (req) => projects.get((req.params as { id: string }).id));
  app.post('/api/projects', async (req, reply) =>
    reply.status(201).send(projects.create(createSchema.parse(req.body)))
  );
}
