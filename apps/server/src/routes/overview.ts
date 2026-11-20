import type { FastifyInstance } from 'fastify';
import type { Services } from '../app';

export function registerOverviewRoutes(app: FastifyInstance, { overview }: Services): void {
  app.get('/api/overview', async () => overview.summary());
  app.get('/api/overview/integrity', async () => overview.integrityCheck());
}
