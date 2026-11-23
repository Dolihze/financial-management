import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppConfig } from './config';
import { openDatabase, type Db } from './db/database';
import { registerAccountRoutes } from './routes/accounts';
import { registerCategoryRoutes } from './routes/categories';
import { registerContractRoutes } from './routes/contracts';
import { registerCounterpartyRoutes } from './routes/counterparties';
import { registerImportRoutes } from './routes/imports';
import { registerOverviewRoutes } from './routes/overview';
import { registerProjectRoutes } from './routes/projects';
import { registerTransactionRoutes } from './routes/transactions';
import { AccountService } from './services/accountService';
import { CategoryService } from './services/categoryService';
import { ContractService } from './services/contractService';
import { CounterpartyService } from './services/counterpartyService';
import { ImportService } from './services/importService';
import { OverviewService } from './services/overviewService';
import { ProjectService } from './services/projectService';
import { TransactionService } from './services/transactionService';
import { AppError } from './utils';

export interface Services {
  accounts: AccountService;
  categories: CategoryService;
  contracts: ContractService;
  counterparties: CounterpartyService;
  transactions: TransactionService;
  imports: ImportService;
  overview: OverviewService;
  projects: ProjectService;
}

export interface BuiltApp {
  app: FastifyInstance;
  db: Db;
  services: Services;
}

export async function buildApp(config: AppConfig, opts: { logger?: boolean } = {}): Promise<BuiltApp> {
  const db = openDatabase(config.dbPath);
  const services: Services = {
    accounts: new AccountService(db, config.deviceId),
    categories: new CategoryService(db, config.deviceId),
    contracts: new ContractService(db, config.deviceId),
    counterparties: new CounterpartyService(db, config.deviceId),
    transactions: new TransactionService(db, config.deviceId),
    imports: new ImportService(db, config.deviceId),
    overview: new OverviewService(db, config.deviceId),
    projects: new ProjectService(db, config.deviceId)
  };
  services.categories.seedDefaults();

  const app = Fastify({ logger: opts.logger ?? false });

  // Tauri WebView 的 Origin 为 tauri://localhost 或 http://tauri.localhost，开发时为 vite 端口
  await app.register(cors, { origin: true });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ code: err.code, message: err.message });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ code: 'VALIDATION', message: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    app.log.error(err);
    return reply.status(500).send({ code: 'INTERNAL', message: '服务器内部错误' });
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  registerAccountRoutes(app, services);
  registerCategoryRoutes(app, services);
  registerCounterpartyRoutes(app, services);
  registerTransactionRoutes(app, services);
  registerImportRoutes(app, services);
  registerOverviewRoutes(app, services);
  registerProjectRoutes(app, services);
  registerContractRoutes(app, services);

  app.addHook('onClose', async () => {
    db.close();
  });

  return { app, db, services };
}
