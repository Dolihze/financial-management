# AGENTS.md

公司财务桌面软件。npm workspaces monorepo：`packages/shared`、`apps/server`、`apps/desktop`。详见 README.md。

## 必须遵守的规则

- 金额一律「整数分」，只用 `@fm/shared` 的 `toCents/fromCents/formatMoney` 转换；不要在任何地方用浮点做金额运算。
- 余额由流水推导，不要新增存储余额的列。
- 删除规则：交易「删除」是物理删除（用 `TransactionService.remove/removeWithinTx`，分录/附件/项目入账关联一并删除，删除前内容写入审计）；账户、合同、批次、项目只「归档」；附件「删除」是软删除（`deleted_at`）。由项目入账生成的流水不能单独编辑/删除（只能在项目里切回「否」回退）。写操作需同时 `writeAudit`。`tx.status` 列已不再使用（恒为 `normal`），不要再引入「作废」概念。
- 批次「存档」（`batch.sealed_at` 有值）与「归档/删除」（`archived`）是两回事：存档批次整批只读。任何会修改批次、合同、项目、批次附件的写接口，都必须先调用 `services/sealGuard.ts` 的 `assertBatchWritable / assertContractWritable / assertProjectWritable`（返回 409 `BATCH_SEALED`），新增接口时不要漏掉；Excel 导入命中存档批次整批拒绝。存档要求批次下所有项目「上海院已支付 / 支付下家 / 支付陈沛」全为是，由 `BatchService.seal` 在事务内校验。
- `apps/server/src/db/migrations.ts`：当前处于开发阶段（库里全是假数据，不考虑旧库升级），迁移已压平为单个 v1（最终 schema），改表结构直接改 v1、删库重建即可（演示库用 `npm run dev:demo` 重新生成）。**第一次发布给真实用户之后，恢复「只追加新 version、不修改已有迁移」**，届时需同步更新本条。改了 v1 之后，本地已有的旧库不会自动升级：库里记录了当前程序不认识的迁移版本时，后端启动会拒绝并提示（`db/database.ts` 的 `assertCompatible`，退出码 78，不修改库里的数据）；但如果只是改了 v1 的内容而版本号仍是 `[1]`，检测不到，仍需手动删库重建。
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
- `src-tauri/Cargo.toml` 里 `tauri` 依赖的 `devtools` feature 必须保留：发布版靠它支持 F12 / 右键「检查」/ Ctrl+Shift+I 打开前端开发者工具（debug 版本来就可用）。
- `src-tauri/Cargo.toml` 的 `custom-protocol` feature 必须保持为 default：直接 `cargo build --release` 时靠它内嵌前端资源，缺了它 release 版会去连 devUrl（ERR_CONNECTION_REFUSED）。`tauri dev` 用 `--no-default-features` 关闭它，`tauri build` 自动开启。
