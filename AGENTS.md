# AGENTS.md

公司财务桌面软件。npm workspaces monorepo：`packages/shared`、`apps/server`、`apps/desktop`。详见 README.md。

## 必须遵守的规则

- 金额一律「整数分」，只用 `@fm/shared` 的 `toCents/fromCents/formatMoney` 转换；不要在任何地方用浮点做金额运算。
- 余额由流水推导，不要新增存储余额的列。
- 不物理删除财务数据：交易「作废」、账户「归档」；写操作需同时 `writeAudit`。
- `apps/server/src/db/migrations.ts` 只追加新 version，不修改已有迁移。
- 新增/修改接口需在 `apps/server/src/app.test.ts`（或同目录新测试）补测试。
- 前端不直接写 fetch，统一走 `apps/desktop/src/api/`。
- 后端只监听 127.0.0.1。

## 命令

- 测试：`npm test`；类型检查：`npm run typecheck`
- 开发统一入口：`npm run dev`（后端 + 前端 + Tauri 桌面窗口一起启动，关窗口即全部退出）
- 单独启动：`npm run dev:server` / `npm run dev:web` / `npm run tauri:dev`（需后端已运行）
- 前端构建验证：`npm run build:web`
- 打包后端 sidecar：`npm run bundle -w @fm/server`

## 注意

- Node 24 + npm 11：安装脚本需显式批准（`npm approve-scripts`），better-sqlite3 / esbuild 已批准。
- 命令行用 PowerShell 5.1 调接口传中文需显式 UTF-8 字节，否则会出现 `????`（客户端编码问题，非服务端问题）。
