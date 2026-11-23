import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Services } from '../app';

/** 单个项目合同价上限（分）：100 亿元。与前端 MAX_CONTRACT_PRICE_YUAN 保持一致 */
const MAX_CONTRACT_PRICE_CENTS = 10_000_000_000 * 100;

/** 金额一律整数分（前端用 toCents 转换后再提交）；拒绝小数、负数、NaN/Infinity 与过大的值 */
const cents = z
  .number({ invalid_type_error: '合同价必须是数字' })
  .int('合同价必须是整数分')
  .min(0, '合同价不能为负数')
  .max(MAX_CONTRACT_PRICE_CENTS, '合同价过大');

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
