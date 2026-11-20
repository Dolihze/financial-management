/**
 * npm run dev:demo —— 用演示数据库启动完整开发环境（后端 + 前端 + Tauri 桌面窗口）。
 *
 * 做三件事：
 *   1. 演示库 demo.db 不存在时，自动生成假数据（npm run seed -w @fm/server）
 *   2. 把 FM_DB_PATH 指向 demo.db（仅对本次启动的子进程生效，不会改动你的真实库 finance.db）
 *   3. 转交给 `npm run dev`，其余行为与正常开发完全一致
 *
 * 用法：
 *   npm run dev:demo                  # 首次自动造数据，之后直接用
 *   npm run dev:demo -- --reset       # 先重新生成演示库再启动
 *   npm run dev:demo -- --reset --count=3000 --months=24 --seed=7   # 附带参数会传给 seed
 *
 * 路径规则需与 apps/server/src/config.ts 的 getDemoDbPath() 保持一致：
 *   <FM_DATA_DIR 或 %APPDATA%\financial-management>\demo.db
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function demoDbPath() {
  const dataDir = process.env.FM_DATA_DIR ?? join(process.env.APPDATA ?? join(homedir(), '.config'), 'financial-management');
  return join(dataDir, 'demo.db');
}

function run(args, env = process.env) {
  // Windows 上 .cmd 必须经 shell 运行（Node 的安全修复要求），参数都是固定字面量或已校验的 seed 参数
  return spawnSync(npm, args, { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' });
}

const args = process.argv.slice(2);
// 白名单：--reset 无值；其余只允许纯数字值。值不放行任意字符，因为 Windows 下命令经 shell 执行
const seedArgs = args.filter((a) => /^--reset$/.test(a) || /^--(count|months|seed)=\d+$/.test(a));
const unknown = args.filter((a) => !seedArgs.includes(a));
if (unknown.length) {
  console.error(`[dev:demo] 不认识的参数：${unknown.join(' ')}\n可用：--reset --count=N --months=N --seed=N`);
  process.exit(1);
}

// 防呆：用户手动指定了 FM_DB_PATH 时，不要悄悄改掉它，否则会分不清到底用的哪个库
if (process.env.FM_DB_PATH && process.env.FM_DB_PATH !== demoDbPath()) {
  console.error(
    `[dev:demo] 检测到环境变量 FM_DB_PATH=${process.env.FM_DB_PATH}\n` +
      `           dev:demo 会覆盖它并改用演示库，为避免混淆请先清除：Remove-Item Env:FM_DB_PATH`
  );
  process.exit(1);
}

const db = demoDbPath();
const needSeed = seedArgs.includes('--reset') || !existsSync(db);

if (needSeed) {
  console.log(`[dev:demo] ${existsSync(db) ? '重新生成' : '演示库不存在，正在生成'}：${db}`);
  // seed 的 --db 默认就是 demo.db；这里不传 --db，保证与 config.ts 的规则一致
  const seed = run(['run', 'seed', '-w', '@fm/server', '--', ...seedArgs]);
  if (seed.status !== 0) {
    console.error('[dev:demo] 生成演示数据失败，已中止启动');
    process.exit(seed.status ?? 1);
  }
} else {
  console.log(`[dev:demo] 使用已有演示库：${db}（加 --reset 可重新生成）`);
}

console.log('[dev:demo] 启动开发环境（后端使用演示库，不会改动真实库 finance.db）\n');
const dev = run(['run', 'dev'], { ...process.env, FM_DB_PATH: db });
process.exit(dev.status ?? 0);
