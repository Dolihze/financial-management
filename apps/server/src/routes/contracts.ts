import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';

/** 金额一律整数分（前端用 toCents 转换后再提交） */
const cents = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

const projectEntry = z.object({
  projectId: z.string().min(1),
  contractPrice: cents
});

const bodySchema = z.object({
  contractNo: z.string().trim().min(1, '合同编号不能为空').max(50),
  projects: z.array(projectEntry).max(1000)
});

export function registerContractRoutes(app: FastifyInstance, { contracts }: Services): void {
  app.get('/api/contracts', async () => contracts.list());

  app.get('/api/contracts/:id', async (req) => contracts.get((req.params as { id: string }).id));

  /** 新增合同：从未结算项目里挑选并设置合同价 */
  app.post('/api/contracts', async (req, reply) => {
    const created = contracts.create(bodySchema.parse(req.body));
    return reply.status(201).send(created);
  });

  /** 修改合同编号与其下项目的合同价 */
  app.patch('/api/contracts/:id', async (req) =>
    contracts.update((req.params as { id: string }).id, bodySchema.parse(req.body))
  );

  /** 「删除」合同：不物理删除，仅归档，并清空其下项目的合同归属 */
  app.post('/api/contracts/:id/archive', async (req) => contracts.archive((req.params as { id: string }).id));
}
