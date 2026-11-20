/**
 * 把后端打包成可随 Tauri 分发的目录：
 *   apps/desktop/src-tauri/server-dist/
 *     server.cjs                    esbuild 单文件产物（含全部纯 JS 依赖）
 *     node_modules/better-sqlite3   原生模块（含 .node 二进制与 bindings 依赖）
 *   apps/desktop/src-tauri/binaries/node-<target-triple>.exe   便携 Node 运行时（sidecar）
 *
 * 用法：npm run bundle -w @fm/server
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '../..');
const tauriDir = join(repoRoot, 'apps/desktop/src-tauri');
const outDir = join(tauriDir, 'server-dist');
const binDir = join(tauriDir, 'binaries');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
mkdirSync(binDir, { recursive: true });

// 1) esbuild 打包业务代码；better-sqlite3 保持 external，运行时从同级 node_modules 加载
await build({
  entryPoints: [join(serverRoot, 'src/main.ts')],
  outfile: join(outDir, 'server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['better-sqlite3'],
  sourcemap: false,
  minify: false,
  logLevel: 'info'
});

// 2) 拷贝 better-sqlite3 及其运行时依赖（bindings、file-uri-to-path）
const require = createRequire(join(serverRoot, 'package.json'));
const sqliteDir = dirname(require.resolve('better-sqlite3/package.json'));
const nm = join(outDir, 'node_modules');
const copyPkg = (name, from) => {
  const to = join(nm, name);
  mkdirSync(to, { recursive: true });
  for (const item of ['package.json', 'lib', 'build/Release/better_sqlite3.node']) {
    const src = join(from, item);
    if (!existsSync(src)) continue;
    const dst = join(to, item);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst, { recursive: true });
  }
};
copyPkg('better-sqlite3', sqliteDir);
for (const dep of ['bindings', 'file-uri-to-path']) {
  const p = dirname(require.resolve(`${dep}/package.json`, { paths: [sqliteDir] }));
  cpSync(p, join(nm, dep), { recursive: true });
}

// 3) 便携 Node 运行时作为 sidecar，命名需带 target triple（Tauri 约定）
const triple = execSync('rustc --print host-tuple').toString().trim();
const ext = process.platform === 'win32' ? '.exe' : '';
copyFileSync(process.execPath, join(binDir, `node-${triple}${ext}`));

writeFileSync(join(outDir, 'BUILD_INFO.json'), JSON.stringify({ node: process.version, triple, builtAt: new Date().toISOString() }, null, 2));
console.log(`\n后端打包完成: ${outDir}`);
console.log(`Node 运行时: ${join(binDir, `node-${triple}${ext}`)} (${process.version})`);
