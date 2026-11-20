# 财务管理（Financial Management）

公司财务桌面软件。目标：记账、Excel 导入、公司账目总览、公司余额，并能追踪**每一笔钱在哪个账户**。

**技术栈**：Tauri 2 + Vue 3 + Element Plus + Pinia ｜ 后端 Node.js (Fastify) + SQLite ｜ npm workspaces monorepo

## 目录结构

```
financial-management/
├─ packages/shared/        前后端共享：领域类型、金额工具（整数分）
├─ apps/server/            Node.js 后端（Fastify + better-sqlite3）
│  ├─ src/db/              数据库连接 + 迁移（migrations.ts 只追加不修改）
│  ├─ src/services/        业务逻辑（账户/分类/交易/导入/总览）
│  ├─ src/routes/          HTTP 路由 + zod 校验
│  └─ scripts/bundle.mjs   打包 sidecar（esbuild + 便携 Node 运行时）
└─ apps/desktop/           Vue3 前端 + Tauri 壳
   ├─ src/                 views / stores / api
   └─ src-tauri/           Rust：启动/终止后端 sidecar
```

## 架构

```
┌─────────────── Tauri 窗口 (WebView2) ───────────────┐
│  Vue3 + Element Plus  ──HTTP──▶  127.0.0.1:<端口>   │
└─────────────────────────────────────┬───────────────┘
        Tauri(Rust) 启动/关闭 sidecar │  端口：开发固定 17890，发布随机
                          ┌───────────▼───────────┐
                          │ Node.js + Fastify      │
                          │ SQLite (WAL)           │
                          └───────────────────────┘
```

- 前端只通过 `src/api/` 访问后端，**后期联网只需修改 `api/http.ts` 的 baseUrl 并加 token**，页面代码无需改动。
- **端口**：开发版固定 `17890`（`npm run dev` 的 wait-on、后端都依赖它）；发布版由 Rust 向系统申请空闲端口，通过环境变量 `FM_PORT` 传给后端，前端用 Tauri 命令 `get_backend_url` 获取，因此不会与其它软件抢端口。
- 后端仅监听 `127.0.0.1`，不暴露到局域网。
- 数据库位置：开发时 `%APPDATA%\financial-management\finance.db`；发布后在 Tauri 应用数据目录。

## 核心数据规则（不要破坏）

1. **金额一律为整数分**（`number`，如 12.34 元 = `1234`），禁止浮点。转换只用 `@fm/shared` 的 `toCents/fromCents`。
2. **余额不单独存储**：`余额 = 期初 + 所有未作废分录之和`，实时推导。
3. **交易 = 若干分录**：收入 = 入账账户 `+amt`；支出 = 出账账户 `-amt`；转账 = 一进一出（和为 0）。
4. **不物理删除**：交易只能「作废」，账户只能「归档」（且余额须为 0）；所有变更写入 `audit_log`。
5. **主键全部 UUID**，并带 `device_id / updated_at / version`，为后期多端同步预留。
6. **Excel 导入**：预览 → 提交，整批单事务；文件哈希防重复导入；行指纹防重复流水；可整批撤销。

## 环境要求

- Node.js >= 22.5（当前开发用 24）
- Rust 工具链（stable）+ Windows 的 WebView2、MSVC Build Tools（Tauri 前置条件见 <https://v2.tauri.app/start/prerequisites/>）

## 常用命令

```powershell
npm install                  # 安装依赖
npm test                     # 共享包 + 后端测试
npm run typecheck            # 全部类型检查

# 开发：一条命令同时启动 后端 + 前端(vite) + Tauri 桌面窗口
npm run dev
# 关闭桌面窗口 或 Ctrl+C，三者会一起退出
# 单独启动某一部分（调试用）：
#   npm run dev:server   仅后端  http://127.0.0.1:17890
#   npm run dev:web      仅前端  http://127.0.0.1:1420（浏览器调试，不开桌面窗口）
#   npm run tauri:dev    仅桌面壳（需后端已在运行）

# 演示数据：一条命令用演示库启动（后端 + 前端 + 桌面窗口），不会碰真实库 finance.db
npm run dev:demo                          # demo.db 不存在时自动生成（约 300 笔、近 12 个月、6 个账户）
npm run dev:demo -- --reset               # 先重新生成演示库再启动
npm run dev:demo -- --reset --count=3000 --months=24 --seed=7
# 只生成不启动：
npm run seed -w @fm/server                # 已存在 demo.db 则报错，不覆盖
npm run seed -w @fm/server -- --reset

# 打包发布
npm run bundle -w @fm/server # 先打包后端 sidecar
npm run tauri:build          # 生成 NSIS 安装包
```

> `npm run dev` 的启动顺序：先起后端 → 等 `/api/health` 就绪 → 再起 Tauri（其 `beforeDevCommand` 会启动 vite）。
> `tauri dev` 为 debug 构建，Rust 侧**不会**启动 sidecar，只会探测 `npm run dev` 启动的后端是否就绪；`tauri build`（release）才会启动随包分发的后端。
> 开发版端口 17890（后端）/ 1420（前端）被占用时会启动失败，请先关掉旧的开发进程；发布版不受影响（端口随机）。

### 进程生命周期（`src-tauri/src/lib.rs`）

- **Job Object（Windows）**：应用启动时把自己放入带 `KILL_ON_JOB_CLOSE` 的 Job，派生的后端 sidecar 自动继承。应用无论正常退出、崩溃、被任务管理器强杀还是被 `tauri dev` 重编译杀掉，系统都会一并终止后端，不会残留进程占用端口。
- **随机端口（发布版）**：`pick_port()` 绑定 `127.0.0.1:0` 取空闲端口，窗口创建前就已确定；开发版固定 `DEV_BACKEND_PORT = 17890`。
- **就绪通知**：Rust 后台线程每 100ms 探测端口（最长 60 秒），不阻塞窗口创建；就绪后先写状态再发 `backend-ready` 事件（payload 为 bool）。前端 `api/backend.ts` 监听事件，并用 `is_backend_ready` 命令补查，防止错过事件。窗口因此立即出现，等待期间显示"正在启动本地服务"。
- **启动流程**（`App.vue`）：`get_backend_url` 取地址 → 等 `backend-ready` → `/api/health` 短重试确认 HTTP 层可用 → 加载数据。失败时界面显示真实原因而非固定文案。
- **双重保障**：除 Job Object 外，正常退出时仍主动 `kill`，且后端监听 stdin 关闭自行退出（`FM_EXIT_ON_STDIN_CLOSE=1`）。
- **注意**：Windows 下 Tauri 的 `resource_dir()` 返回 `\\?\E:\...` 扩展路径，Node 无法解析（报 `EISDIR: lstat 'E:'`），传给后端前必须经 `to_plain_path()` 去掉前缀。

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/accounts` | 账户列表（含实时余额）/ 新建 |
| PATCH | `/api/accounts/:id` | 修改名称/类型/备注 |
| POST | `/api/accounts/:id/archive` | 归档（余额须为 0） |
| GET/POST | `/api/categories` | 分类 |
| GET/POST | `/api/transactions` | 流水查询（账户/类型/日期/关键字）/ 记账 |
| POST | `/api/transactions/:id/void` | 作废 |
| GET | `/api/overview` | 总览：总余额、各账户、本月收支、趋势、分类 |
| GET | `/api/overview/integrity` | 数据完整性校验 |
| GET | `/api/imports/template` | 下载导入模板 |
| POST | `/api/imports/preview` / `commit` | 预览 / 确认导入（multipart `file`） |
| POST | `/api/imports/:id/revert` | 撤销整批导入 |

## 路线图

- [x] 单机版骨架：账户、记账、转账、总览、Excel 导入、作废/撤销、审计日志
- [ ] 数据备份/恢复（SQLite 在线备份）、本地数据库加密
- [ ] 对账（银行流水核对）、附件（发票/回单）、报表导出（Excel/PDF）
- [ ] 用户/角色/权限
- [ ] 联网：云端服务（PostgreSQL）+ 基于 `audit_log`/`version` 的同步
- [ ] 手机端（uni-app / Flutter）调用同一套 API

## 已知待办 / 注意

- 应用图标为占位图（`src-tauri/icons/`），发布前请替换（`npx tauri icon <png>` 可生成全套）。
- 导入模板仅支持收入/支出；转账请手工录入，避免账户配对歧义。
