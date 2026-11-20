import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppConfig {
  host: string;
  port: number;
  /** SQLite 数据库文件路径，":memory:" 用于测试 */
  dbPath: string;
  /** 设备 ID，后期多端同步时用于标记数据来源 */
  deviceId: string;
}

function defaultDataDir(): string {
  const base = process.env.APPDATA ?? join(homedir(), '.config');
  return join(base, 'financial-management');
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = process.env.FM_DATA_DIR ?? defaultDataDir();
  return {
    // 仅监听本机回环地址，避免局域网内被访问
    host: process.env.FM_HOST ?? '127.0.0.1',
    port: Number(process.env.FM_PORT ?? 17890),
    dbPath: process.env.FM_DB_PATH ?? join(dataDir, 'finance.db'),
    deviceId: process.env.FM_DEVICE_ID ?? 'desktop-local',
    ...overrides
  };
}
