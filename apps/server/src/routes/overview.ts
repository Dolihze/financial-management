import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const periodQuery = z
  .object({ from: dateSchema.optional(), to: dateSchema.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, { message: '开始日期不能晚于结束日期' });

export function registerOverviewRoutes(app: FastifyInstance, { overview }: Services): void {
  app.get('/api/overview', async () => overview.summary());
  // 指定时间段的收支统计与去向（from/to 含首尾，缺省一端不限）
  app.get('/api/overview/period', async (req) => overview.periodSummary(periodQuery.parse(req.query)));
  app.get('/api/overview/integrity', async () => overview.integrityCheck());
}