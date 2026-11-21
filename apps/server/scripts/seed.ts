/**
 * 生成演示用假数据。
 *
 * 用法（在仓库根目录）：
 *   npm run seed -w @fm/server                 # 写入演示库 demo.db（已存在则报错，不覆盖）
 *   npm run seed -w @fm/server -- --reset      # 删除旧的 demo.db 后重新生成
 *   npm run seed -w @fm/server -- --count=3000 --months=24 --seed=7
 *
 * 预览演示库（会在 demo.db 不存在时自动调用本脚本）：
 *   npm run dev:demo
 *
 * 设计要点：
 * - 走服务层（AccountService / TransactionService），不直接写 SQL：数据与真实使用一致，
 *   有审计日志，余额由流水推导。
 * - 固定随机种子：同样参数每次生成完全相同的数据，便于复现问题。
 * - 金额一律整数分，不使用浮点做金额运算。
 * - 安全：拒绝写入默认的真实数据库（finance.db），只允许写 demo 库或显式指定的库。
 */
import { existsSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import type { AccountType, CreateTransactionInput } from '@fm/shared';
import { getDemoDbPath } from '../src/config';
import { openDatabase } from '../src/db/database';
import { AccountService } from '../src/services/accountService';
import { CategoryService } from '../src/services/categoryService';
import { CounterpartyService } from '../src/services/counterpartyService';
import { ImportService } from '../src/services/importService';
import { TransactionService } from '../src/services/transactionService';

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------
interface Options {
  reset: boolean;
  count: number;
  months: number;
  seed: number;
  db: string;
}

function parseArgs(argv: string[]): Options {
  const flag = (name: string) => argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  const value = (name: string, fallback: string) => {
    const f = flag(name);
    return f?.includes('=') ? f.slice(f.indexOf('=') + 1) : fallback;
  };
  const num = (name: string, fallback: number) => {
    const n = Number(value(name, String(fallback)));
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} 必须是正整数`);
    return n;
  };
  return {
    reset: Boolean(flag('reset')),
    count: num('count', 300),
    months: num('months', 12),
    seed: num('seed', 20260101),
    db: value('db', getDemoDbPath())
  };
}

// ---------------------------------------------------------------------------
// 可复现的伪随机数（mulberry32）
// ---------------------------------------------------------------------------
function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    /** [min, max] 闭区间整数 */
    int: (min: number, max: number) => Math.floor(next() * (max - min + 1)) + min,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(next() * arr.length)]!,
    /** 按权重挑选 */
    weighted: <T>(items: ReadonlyArray<readonly [T, number]>): T => {
      const total = items.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [item, w] of items) {
        r -= w;
        if (r <= 0) return item;
      }
      return items[items.length - 1]![0];
    }
  };
}

// ---------------------------------------------------------------------------
// 素材
// ---------------------------------------------------------------------------
const ACCOUNTS: Array<{ name: string; type: AccountType; opening: number; note: string }> = [
  { name: '招商银行基本户', type: 'bank', opening: 80_000_000, note: '主结算账户，尾号 8826' },
  { name: '工商银行一般户', type: 'bank', opening: 12_000_000, note: '工资代发、社保扣缴' },
  { name: '现金（备用金）', type: 'cash', opening: 500_000, note: '前台保管' },
  { name: '支付宝企业账户', type: 'alipay', opening: 2_000_000, note: '线上收款' },
  { name: '微信商户号', type: 'wechat', opening: 800_000, note: '小程序收款' },
  { name: '客户应收款', type: 'receivable', opening: 0, note: '赊销客户挂账' }
];

const CUSTOMERS = ['杭州云岚科技', '深圳启明电子', '上海瑞丰贸易', '北京远景咨询', '成都锦程物流', '苏州恒达制造', '广州博雅文化', '武汉楚天实业', '南京金陵软件', '宁波海润进出口'];
const SUPPLIERS = ['东莞精工五金', '宁波鑫达包装', '佛山永盛材料', '京东企业购', '得力办公直营', '顺丰速运', '中国移动', '国家电网', '链家地产', '阿里云'];
const STAFF = ['张伟', '王芳', '李娜', '刘洋', '陈静', '杨磊', '赵敏', '黄涛'];
const CITIES = ['上海', '深圳', '北京', '成都', '杭州', '西安'];

/** 固定月度支出（房租/工资等），作废环节需要排除它们；入库后摘要已移除，故按对象引用标记 */
const fixedPlanned = new WeakSet<CreateTransactionInput>();

type Kind = 'income' | 'expense';
interface Template {
  kind: Kind;
  category: string;
  weight: number;
  /** 金额范围（元），生成时转整数分 */
  range: readonly [number, number];
  /** 返回 [摘要, 往来单位] */
  make: (r: ReturnType<typeof makeRng>) => readonly [string, string];
  /** 常用账户名（按权重） */
  accounts: ReadonlyArray<readonly [string, number]>;
}

const TEMPLATES: Template[] = [
  {
    kind: 'income', category: '主营业务收入', weight: 38, range: [3_000, 180_000],
    make: (r) => { const c = r.pick(CUSTOMERS); return [`${c}货款`, c]; },
    accounts: [['招商银行基本户', 8], ['支付宝企业账户', 1], ['微信商户号', 1]]
  },
  {
    kind: 'income', category: '其他业务收入', weight: 6, range: [500, 20_000],
    make: (r) => { const c = r.pick(CUSTOMERS); return [`${c}技术服务费`, c]; },
    accounts: [['招商银行基本户', 1]]
  },
  {
    kind: 'income', category: '利息收入', weight: 2, range: [20, 900],
    make: () => ['活期存款利息', '招商银行'],
    accounts: [['招商银行基本户', 3], ['工商银行一般户', 1]]
  },
  {
    kind: 'income', category: '其他收入', weight: 2, range: [100, 3_000],
    make: () => ['废品处理收入', '回收站'],
    accounts: [['现金（备用金）', 1]]
  },
  {
    kind: 'expense', category: '其他支出', weight: 22, range: [2_000, 120_000],
    make: (r) => { const s = r.pick(SUPPLIERS.slice(0, 4)); return [`${s}采购原材料`, s]; },
    accounts: [['招商银行基本户', 9], ['工商银行一般户', 1]]
  },
  {
    kind: 'expense', category: '经营费', weight: 12, range: [30, 2_800],
    make: (r) => { const s = r.pick(['得力办公直营', '京东企业购']); return [r.pick(['打印纸与耗材', '办公椅采购', '文具用品', '饮用水与茶歇', '保洁用品']), s]; },
    accounts: [['现金（备用金）', 4], ['支付宝企业账户', 3], ['招商银行基本户', 1]]
  },
  {
    kind: 'expense', category: '差旅费', weight: 8, range: [200, 6_500],
    make: (r) => { const p = r.pick(STAFF); return [`${p}${r.pick(CITIES)}出差${r.pick(['机票', '高铁票', '住宿费', '餐补', '打车费'])}`, p]; },
    accounts: [['招商银行基本户', 3], ['现金（备用金）', 2], ['支付宝企业账户', 2]]
  },
  {
    kind: 'expense', category: '经营费', weight: 5, range: [800, 30_000],
    make: (r) => [r.pick(['信息流广告投放', '展会摊位费', '宣传物料制作', '短视频代运营']), r.pick(['巨量引擎', '会展中心', '广告公司'])],
    accounts: [['支付宝企业账户', 3], ['招商银行基本户', 2]]
  },
  {
    kind: 'expense', category: '其他支出', weight: 4, range: [50, 5_000],
    make: (r) => [r.pick(['快递费', '汽车加油', '团建活动', '维修费', '会务费']), r.pick(['顺丰速运', '中石化', '本地商户'])],
    accounts: [['现金（备用金）', 3], ['微信商户号', 2], ['招商银行基本户', 1]]
  }
];

// ---------------------------------------------------------------------------
// 日期工具（本地日期字符串，避免 toISOString 的时区偏移）
// ---------------------------------------------------------------------------
const pad = (n: number) => String(n).padStart(2, '0');
const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const lastDayOf = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/** 金额：元 -> 整数分，并抹成"像真账"的取整（多数为整十/整百，少数带角分） */
function yuanToCents(r: ReturnType<typeof makeRng>, min: number, max: number): number {
  const yuan = r.int(min, max);
  const style = r.next();
  if (style < 0.55) return Math.round(yuan / 100) * 100 * 100 || min * 100; // 整百
  if (style < 0.8) return Math.round(yuan / 10) * 10 * 100 || min * 100; // 整十
  return yuan * 100 + r.int(0, 99); // 带角分
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const opt = parseArgs(process.argv.slice(2));

  // 安全：绝不写默认的真实库
  if (basename(opt.db).toLowerCase() === 'finance.db') {
    throw new Error('拒绝写入 finance.db（真实数据库）。请使用默认的 demo.db，或用 --db 指定其他文件。');
  }
  if (existsSync(opt.db)) {
    if (!opt.reset) throw new Error(`${opt.db} 已存在。加 --reset 删除后重新生成。`);
    for (const suffix of ['', '-wal', '-shm']) rmSync(opt.db + suffix, { force: true });
  }

  const deviceId = 'seed';
  const db = openDatabase(opt.db);
  const accounts = new AccountService(db, deviceId);
  const categories = new CategoryService(db, deviceId);
  const counterparties = new CounterpartyService(db, deviceId);
  const txs = new TransactionService(db, deviceId);
  const imports = new ImportService(db, deviceId);
  categories.seedDefaults();
  // 默认只有「其他收入」；演示库额外新增几个用户自定义收入分类
  for (const name of ['主营业务收入', '其他业务收入', '利息收入']) categories.create({ name, kind: 'income' });

  const r = makeRng(opt.seed);

  // 1) 账户
  const accId = new Map<string, string>();
  for (const a of ACCOUNTS) {
    accId.set(a.name, accounts.create({ name: a.name, type: a.type, openingBalance: a.opening, note: a.note }).id);
  }
  const catId = new Map(categories.list().map((c) => [`${c.kind}:${c.name}`, c.id] as const));
  const A = (name: string) => accId.get(name)!;
  // 往来单位按名称取，不存在则经服务层创建（保证有审计日志）
  const cpIds = new Map<string, string>();
  const CP = (name: string) => {
    let id = cpIds.get(name);
    if (!id) cpIds.set(name, (id = counterparties.create({ name }).id));
    return id;
  };

  // 2) 流水：开始日期 = 今天往前 months 个月
  const today = new Date();
  const start = new Date(today.getFullYear(), today.getMonth() - opt.months + 1, 1);
  const spanDays = Math.max(1, Math.round((today.getTime() - start.getTime()) / 86_400_000));

  const planned: CreateTransactionInput[] = [];

  // 2a) 固定的月度支出：房租、工资、社保、税费(其他支出)、云服务（让总览趋势有规律）
  for (let i = 0; i < opt.months; i++) {
    const ym = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const y = ym.getFullYear();
    const m = ym.getMonth();
    const day = (d: number) => fmt(new Date(y, m, Math.min(d, lastDayOf(y, m))));
    const notFuture = (s: string) => s <= fmt(today);
    const fixed: Array<{ d: number; who: string; cat: string; yuan: number; acc: string }> = [
      { d: 1, who: '链家地产', cat: '房租水电', yuan: 18_000, acc: '招商银行基本户' },
      { d: 10, who: '全体员工', cat: '工资薪酬', yuan: 52_000 + r.int(-3, 3) * 1_000, acc: '工商银行一般户' },
      { d: 12, who: '社保局', cat: '社保', yuan: 14_800, acc: '工商银行一般户' },
      { d: 15, who: '税务局', cat: '其他支出', yuan: 6_000 + r.int(0, 12) * 500, acc: '招商银行基本户' },
      { d: 20, who: '阿里云', cat: '经营费', yuan: 1_280 + r.int(0, 8) * 10, acc: '支付宝企业账户' }
    ];
    for (const f of fixed) {
      if (!notFuture(day(f.d))) continue;
      const tx: CreateTransactionInput = {
        occurredOn: day(f.d), type: 'expense', amount: f.yuan * 100,
        accountId: A(f.acc), categoryId: catId.get(`expense:${f.cat}`) ?? null, counterpartyId: CP(f.who)
      };
      fixedPlanned.add(tx);
      planned.push(tx);
    }
  }

  // 2b) 随机的日常收支
  const randomCount = Math.max(0, opt.count - planned.length);
  const loanShare = 0.07; // 借款/贷款占随机流水的比例
  const incomeTemplates = TEMPLATES.filter((t) => t.kind === 'income');
  const expenseTemplates = TEMPLATES.filter((t) => t.kind === 'expense');
  // 收入占比略低于支出，但单笔更大，整体让现金流为正
  const pickTemplate = () =>
    r.next() < 0.42
      ? r.weighted(incomeTemplates.map((t) => [t, t.weight] as const))
      : r.weighted(expenseTemplates.map((t) => [t, t.weight] as const));

  for (let i = 0; i < randomCount; i++) {
    const date = fmt(addDays(start, r.int(0, spanDays)));
    if (r.next() < loanShare) {
      // 借款（借出，出账）/ 贷款（借入，入账）
      const flow = r.pick([
        ['borrow', '招商银行基本户', '员工'],
        ['borrow', '招商银行基本户', '合作方'],
        ['loan', '招商银行基本户', '招商银行'],
        ['loan', '工商银行一般户', '股东']
      ] as const);
      planned.push({
        occurredOn: date, type: flow[0], amount: yuanToCents(r, 500, 30_000),
        accountId: A(flow[1]), counterpartyId: CP(flow[2])
      });
      continue;
    }
    const t = pickTemplate();
    const [, who] = t.make(r); // 模板仍返回摘要以保持随机序列不变，但摘要已不再入库
    planned.push({
      occurredOn: date, type: t.kind, amount: yuanToCents(r, t.range[0], t.range[1]),
      accountId: A(r.weighted(t.accounts)), categoryId: catId.get(`${t.kind}:${t.category}`) ?? null, counterpartyId: CP(who)
    });
  }

  // 按日期排序后入账，让 created_at 与业务日期大致同序，列表更自然
  planned.sort((a, b) => a.occurredOn.localeCompare(b.occurredOn));

  // 保护：避免个别账户（如现金）被随机支出刷成大额负数，先试算，不足则补一笔「贷款」（借入资金）
  const running = new Map(ACCOUNTS.map((a) => [a.name, a.opening] as const));
  const idToName = new Map([...accId].map(([n, id]) => [id, n] as const));
  const ensured: CreateTransactionInput[] = [];
  for (const p of planned) {
    const name = idToName.get(p.accountId!)!;
    const delta = p.type === 'income' || p.type === 'loan' ? p.amount : -p.amount;
    if (delta < 0 && (running.get(name) ?? 0) + delta < 0 && name !== '招商银行基本户') {
      const topUp = Math.ceil((-(running.get(name)! + delta) + 200_000) / 10_000) * 10_000;
      ensured.push({
        occurredOn: p.occurredOn, type: 'loan',
        amount: topUp, accountId: A(name), counterpartyId: CP('股东')
      });
      running.set(name, running.get(name)! + topUp);
    }
    ensured.push(p);
    running.set(name, (running.get(name) ?? 0) + delta);
  }

  // 3) 入库（整批一个事务，速度快且要么全成功）
  const created: string[] = [];
  db.transaction(() => {
    for (const p of ensured) created.push(txs.insertWithinTx(p));
  })();

  // 4) 几笔作废（演示"作废不删除"）。
  //    只挑随机产生的日常收支：固定的月度支出（房租/工资/社保/税费/云服务）作废后该月会缺项，数据不自洽；
  //    借款/贷款作废也不在这里演示（用于防透支的补充贷款作废会让余额变负）。
  //    原因按收入/支出区分，保证"原因"与交易本身讲得通。
  const voidable = created.filter((_, i) => {
    const p = ensured[i]!;
    return (p.type === 'income' || p.type === 'expense') && !fixedPlanned.has(p);
  });
  const expenseVoidReasons = ['重复录入', '金额录错', '供应商退款冲回'];
  const incomeVoidReasons = ['重复录入', '客户退款冲回', '对方未实际付款'];
  const voidCount = Math.min(6, Math.floor(voidable.length / 30));
  for (let i = 0; i < voidCount; i++) {
    const id = voidable[Math.floor(((i + 1) * voidable.length) / (voidCount + 1))]!;
    const src = ensured[created.indexOf(id)]!;
    txs.void(id, r.pick(src.type === 'income' ? incomeVoidReasons : expenseVoidReasons));
  }

  // 5) 归档一个零余额的旧账户，演示"归档"（不影响总览）
  const old = accounts.create({ name: '原中国银行账户（已销户）', type: 'bank', openingBalance: 0, note: '2024 年销户' });
  accounts.archive(old.id);

  // 6) 一个"已撤销"的导入批次：生成真实 Excel -> 提交 -> 撤销，演示导入历史
  const wb = await buildSampleWorkbook(r, A('招商银行基本户'), accounts);
  imports.revert((await imports.commit(wb, '2026年Q3银行流水.xlsx', { skipDuplicates: true })).id);

  // 汇总
  const list = accounts.list();
  const all = txs.list({ includeVoided: true, limit: 1 });
  console.log(`\n演示库: ${opt.db}`);
  console.log(`种子=${opt.seed}  时间跨度=${opt.months} 个月  流水=${all.total} 笔（含 ${voidCount} 笔手工作废、1 个已撤销导入批次）\n`);
  console.log('账户余额：');
  for (const a of list) console.log(`  ${a.name.padEnd(14, '　')} ${(a.balance / 100).toFixed(2).padStart(14)} 元`);
  const total = list.reduce((s, a) => s + a.balance, 0);
  console.log(`  ${'合计'.padEnd(14, '　')} ${(total / 100).toFixed(2).padStart(14)} 元`);
  const negative = list.filter((a) => a.balance < 0 && a.type !== 'payable');
  if (negative.length) console.log(`\n提示：${negative.map((a) => a.name).join('、')} 余额为负，可换 --seed 重新生成`);
  console.log('\n预览：');
  console.log(`  $env:FM_DB_PATH="${opt.db}"; npm run dev`);

  db.close();
}

/** 生成一份只含收入/支出的 Excel（用于演示导入历史），所有账户必须已存在 */
async function buildSampleWorkbook(r: ReturnType<typeof makeRng>, _bankId: string, _accounts: AccountService): Promise<Buffer> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('流水导入');
  ws.addRow(['日期', '类型', '金额', '账户', '分类', '往来单位', '备注']);
  for (let i = 0; i < 12; i++) {
    const d = fmt(addDays(new Date(), -r.int(200, 330)));
    const income = r.next() < 0.5;
    ws.addRow([
      d, income ? '收入' : '支出', yuanToCents(r, 800, 40_000) / 100,
      '招商银行基本户', income ? '主营业务收入' : '其他支出',
      income ? r.pick(CUSTOMERS) : r.pick(SUPPLIERS), '银行流水导入'
    ]);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

main().catch((e) => {
  console.error(`\n生成失败: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
