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

/** 结算入账：项目归入合同即结算，需要入账账户；日期 YYYY-MM-DD 且必须是真实存在的日期，省略时用服务器当天 */
const settlementSchema = z.object({
  accountId: z.string().min(1, '请选择入账账户'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '入账日期格式应为 YYYY-MM-DD')
    .refine((s) => {
      const d = new Date(s + 'T00:00:00Z');
      return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
    }, '入账日期不是有效日期')
    .optional()
});

const baseSchema = z.object({
  contractNo: z.string().trim().min(1, '合同编号不能为空').max(50),
  projects: z.array(projectEntry).max(1000),
  settlement: settlementSchema.optional()
});
/** 新增合同必须指定所属批次 */
const createSchema = baseSchema.extend({ batchId: z.string().min(1, '请选择所属批次') });
/** 修改合同：batchId 可省略（保持不变），指定则移到该批次 */
const updateSchema = baseSchema.extend({ batchId: z.string().min(1).optional() });

export function registerContractRoutes(app: FastifyInstance, { contracts }: Services): void {
  /** 合同列表；?batchId=xxx 只返回该批次下的合同 */
  app.get('/api/contracts', async (req) => {
    const { batchId } = z.object({ batchId: z.string().min(1).optional() }).parse(req.query);
    return contracts.list(batchId);
  });

  app.get('/api/contracts/:id', async (req) => contracts.get((req.params as { id: string }).id));

  /** 新增合同：归属某个批次，从未结算项目里挑选并设置合同价 */
  app.post('/api/contracts', async (req, reply) => {
    const created = contracts.create(createSchema.parse(req.body));
    return reply.status(201).send(created);
  });

  /** 修改合同编号 / 所属批次与其下项目的合同价 */
  app.patch('/api/contracts/:id', async (req) =>
    contracts.update((req.params as { id: string }).id, updateSchema.parse(req.body))
  );

  /** 「删除」合同：不物理删除，仅归档，并清空其下项目的合同归属 */
  app.post('/api/contracts/:id/archive', async (req) => contracts.archive((req.params as { id: string }).id));
}
