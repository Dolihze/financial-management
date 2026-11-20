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

/**
 * 开发版固定端口。发布版由 Tauri 选好空闲端口并通过 FM_PORT 传入。
 * 修改时需同步 src-tauri/src/lib.rs 的 DEV_BACKEND_PORT 和 apps/desktop/src/api/http.ts 的 DEV_BASE。
 */
export const DEFAULT_PORT = 17890;

function defaultDataDir(): string {
  const base = process.env.APPDATA ?? join(homedir(), '.config');
  return join(base, 'financial-management');
}

/**
 * 演示库路径：与真实库放在同一数据目录，但文件名不同。
 * 只取决于数据目录，不受 FM_DB_PATH 影响（FM_DB_PATH 可能已被指向演示库本身）。
 * 根目录 scripts/dev-demo.mjs 里有同样的规则，修改时需同步。
 */
export function getDemoDbPath(): string {
  return join(process.env.FM_DATA_DIR ?? defaultDataDir(), 'demo.db');
}

/** 解析端口：未设置时用默认值；非法值直接报错，避免带着 NaN 去监听 */
export function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`FM_PORT 必须是 1-65535 的整数，当前值: ${JSON.stringify(raw)}`);
  }
  return port;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = process.env.FM_DATA_DIR ?? defaultDataDir();
  return {
    // 仅监听本机回环地址，避免局域网内被访问
    host: process.env.FM_HOST ?? '127.0.0.1',
    port: parsePort(process.env.FM_PORT),
    dbPath: process.env.FM_DB_PATH ?? join(dataDir, 'finance.db'),
    deviceId: process.env.FM_DEVICE_ID ?? 'desktop-local',
    ...overrides
  };
}
