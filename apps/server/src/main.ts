import { buildApp } from './app';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = await buildApp(config, { logger: true });

  const shutdown = async (signal: string) => {
    app.log.info(`收到 ${signal}，正在关闭...`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  // Tauri 在关闭窗口时会关闭 sidecar 的 stdin；监听到即退出，避免残留后台进程
  if (process.env.FM_EXIT_ON_STDIN_CLOSE === '1') {
    process.stdin.resume();
    process.stdin.on('end', () => void shutdown('stdin-closed'));
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(`数据库: ${config.dbPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
