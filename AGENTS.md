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
- 一键打包安装包：`npm run package`（= 打包后端 sidecar + `tauri build`，产物在 `apps/desktop/src-tauri/target/release/bundle/nsis/`）
- 单独打包后端 sidecar：`npm run bundle -w @fm/server`
- 演示假数据：`npm run dev:demo`（demo.db 不存在时自动生成并用它启动，真实库 `finance.db` 不受影响）；只生成用 `npm run seed -w @fm/server`（脚本拒绝写 `finance.db`；必须走服务层造数据，不要直接写 SQL）
- 演示库路径规则同时存在于 `apps/server/src/config.ts`(`getDemoDbPath`) 和根 `scripts/dev-demo.mjs`，修改时两处同步。`dev:demo` 只通过子进程环境变量设置 `FM_DB_PATH`，不修改任何文件。

## 注意

- Node 24 + npm 11：安装脚本需显式批准（`npm approve-scripts`），better-sqlite3 / esbuild 已批准。
- 命令行用 PowerShell 5.1 调接口传中文需显式 UTF-8 字节，否则会出现 `????`（客户端编码问题，非服务端问题）。
- `src-tauri/src/lib.rs` 的 Job Object 必须在派生任何子进程之前调用（`run()` 第一行），否则 sidecar 不会被系统带走。
- 传给 Node sidecar 的路径必须经 `to_plain_path()` 去掉 Windows 的 `\\?\` 前缀，否则后端启动失败。
- 后端端口：**发布版是随机端口**（Rust 选好后经 `FM_PORT` 传给后端，前端经 `get_backend_url` 取得），不要在前端写死端口。只有**开发版固定端口 `17890`**，它出现在三处需同步：`apps/server/src/config.ts`(`DEFAULT_PORT`)、`src-tauri/src/lib.rs`(`DEV_BACKEND_PORT`)、`apps/desktop/src/api/backend.ts`(`DEV_BASE`)，另外根 `package.json` 的 `dev` 脚本里 wait-on 地址也要一致。CSP 已放宽为 `http://127.0.0.1:*`，无需随端口修改。
- `src-tauri/Cargo.toml` 的 `custom-protocol` feature 必须保持为 default：直接 `cargo build --release` 时靠它内嵌前端资源，缺了它 release 版会去连 devUrl（ERR_CONNECTION_REFUSED）。`tauri dev` 用 `--no-default-features` 关闭它，`tauri build` 自动开启。
