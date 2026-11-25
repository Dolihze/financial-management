# 财务管理（Financial Management）

公司财务桌面软件。目标：记账、Excel 导入、公司账目总览、公司余额，并能追踪**每一笔钱在哪个账户**。

**技术栈**：Tauri 2 + Vue 3 + Element Plus + Pinia ｜ 后端 Node.js (Fastify) + SQLite ｜ npm workspaces monorepo

## 目录结构

```
financial-management/
├─ packages/shared/        前后端共享：领域类型、金额工具（整数分）
├─ apps/server/            Node.js 后端（Fastify + better-sqlite3）
│  ├─ src/db/              数据库连接 + 迁移（开发阶段已压平为单个 v1，详见 AGENTS.md）
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
- 流水附件（相关文件）：文件本体存放在数据库同目录的 `<库文件名>.attachments\`（如 `finance.attachments\`，演示库为 `demo.attachments\`），库里只存元数据。**备份/迁移数据时需要把这个文件夹和 `finance.db` 一起带走**。

## 核心数据规则（不要破坏）

1. **金额一律为整数分**（`number`，如 12.34 元 = `1234`），禁止浮点。转换只用 `@fm/shared` 的 `toCents/fromCents`。
2. **余额不单独存储**：`余额 = 期初 + 所有分录之和`，实时推导。
3. **交易 = 若干分录**：收入 / 贷款（借入）= 入账账户 `+amt`；支出 / 借款（借出）= 出账账户 `-amt`；每笔交易只涉及一个账户。
4. **删除规则**：交易「删除」是物理删除（分录、附件一并删除，删除前的内容完整写入 `audit_log`）；账户只能「归档」（且余额须为 0）；所有变更写入 `audit_log`。
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

# 打包发布（一条命令，产物在 apps/desktop/src-tauri/target/release/bundle/nsis/）
npm run package
# 等价于分步执行：
#   npm run bundle -w @fm/server   先打包后端 sidecar
#   npm run tauri:build            生成 NSIS 安装包
```

> `npm run dev` 的启动顺序：先起后端 → 等 `/api/health` 就绪 → 再起 Tauri（其 `beforeDevCommand` 会启动 vite）。
> `tauri dev` 为 debug 构建，Rust 侧**不会**启动 sidecar，只会探测 `npm run dev` 启动的后端是否就绪；`tauri build`（release）才会启动随包分发的后端。
> 开发版端口 17890（后端）/ 1420（前端）被占用时会启动失败，请先关掉旧的开发进程；发布版不受影响（端口随机）。

### 进程生命周期（`src-tauri/src/lib.rs`）

- **Job Object（Windows）**：应用启动时把自己放入带 `KILL_ON_JOB_CLOSE` 的 Job，派生的后端 sidecar 自动继承。应用无论正常退出、崩溃、被任务管理器强杀还是被 `tauri dev` 重编译杀掉，系统都会一并终止后端，不会残留进程占用端口。
- **随机端口（发布版）**：`pick_port()` 绑定 `127.0.0.1:0` 取空闲端口，窗口创建前就已确定；开发版固定 `DEV_BACKEND_PORT = 17890`。
- **就绪通知**：Rust 后台线程每 100ms 探测端口（最长 60 秒），不阻塞窗口创建；就绪后先写状态再发 `backend-ready` 事件（payload 为 bool）。前端 `api/backend.ts` 监听事件，并用 `is_backend_ready` 命令补查，防止错过事件。窗口因此立即出现，等待期间显示"正在启动本地服务"。
- **启动流程**（`App.vue`）：`get_backend_url` 取地址 → 等 `backend-ready` → `/api/health` 短重试确认 HTTP 层可用 → 加载数据。失败时界面显示真实原因而非固定文案。
- **后端日志（发布版）**：sidecar 的输出和启动步骤（数据目录、脚本路径、端口、退出码）写入 `<数据目录>/logs/backend.log`（Windows：`%APPDATA%\com.company.financial-management\logs\`），超过 2MB 在下次启动时轮转为 `backend.old.log`。启动失败（脚本缺失、进程提前退出、端口连不上等）时 Rust 立即记录原因并通知前端，不再傻等 60 秒；失败页会显示真实原因、日志路径和「打开日志位置」按钮。排查用户现场问题时让对方发这个日志文件即可。
- **双重保障**：除 Job Object 外，正常退出时仍主动 `kill`，且后端监听 stdin 关闭自行退出（`FM_EXIT_ON_STDIN_CLOSE=1`）。
- **注意**：Windows 下 Tauri 的 `resource_dir()` 返回 `\\?\E:\...` 扩展路径，Node 无法解析（报 `EISDIR: lstat 'E:'`），传给后端前必须经 `to_plain_path()` 去掉前缀。

## API 概览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/api/accounts` | 账户列表（含实时余额）/ 新建 |
| PATCH | `/api/accounts/:id` | 修改名称/类型/备注 |
| POST | `/api/accounts/:id/archive` | 归档（余额须为 0） |
| GET/POST/PATCH/DELETE | `/api/categories` | 分类（PATCH 重命名；DELETE 为归档式删除，已使用的流水改挂兜底分类（收入=「其他收入」，支出=「其他支出」）；内置的默认分类不可编辑/删除：收入「项目收入/其他收入」，支出「工资薪酬/社保/差旅费/房租水电/经营费/员工报销/企信支付下家分包费/企信支付陈沛/车辆/其他支出」，内置分类按此顺序展示，兜底的「其他」类固定在内置分类最后） |
| GET/POST/PATCH/DELETE | `/api/counterparties` | 往来单位（流水通过 `counterpartyId` 关联；PATCH 重命名并同步流水名称；DELETE 为归档式删除，流水解除关联但保留名称快照） |
| GET/POST | `/api/transactions` | 流水查询（账户/类型/日期/关键字）/ 记账 |
| PATCH | `/api/transactions/:id` | 编辑流水（全部字段整体提交，校验同新增；分录重写，审计记录修改前后内容）。由项目入账生成的流水（`linkedToProject`）不能编辑，409 `TX_LINKED_TO_PROJECT` |
| DELETE | `/api/transactions/:id` | 删除流水（物理删除，分录与附件一并删除，写审计）。由项目入账生成的流水不能单独删除（409 `TX_LINKED_TO_PROJECT`），需在项目里把对应字段切回「否」 |
| GET/POST | `/api/transactions/:id/attachments` | 流水相关文件：列表 / 上传（multipart，字段 `file`，单个 ≤20MB，每笔 ≤20 个） |
| POST | `/api/attachments/:id/remove` | 「删除」流水文件：软删除（保留记录与磁盘文件，列表/下载不再返回，释放名额，写审计 `detach`）；整笔流水被删除时才连文件一并清理 |
| GET | `/api/attachments/:id/file` | 取文件内容（图片/PDF 内联预览，其余强制下载） |
| GET | `/api/overview` | 总览：总余额、各账户、本月收支、趋势、分类 |
| GET | `/api/overview/integrity` | 数据完整性校验 |
| GET | `/api/imports/template` | 下载导入模板 |
| POST | `/api/imports/preview` / `commit` | 预览 / 确认导入（multipart `file`） |
| POST | `/api/imports/:id/revert` | 撤销整批导入 |
| GET | `/api/projects` / `/api/projects/:id` | 项目列表（`?contractId=` 只取某合同下的项目，合同不存在 404）/ 详情（项目只能通过 Excel 导入维护，无手工新增接口）。项目的 `batchNo` 是**只读派生值**：随所属合同的批次走，未归入合同或合同在「未分批」批次下为 null，不能通过项目接口修改 |
| PATCH | `/api/projects/:id` | 修改项目（详情页整体保存；名称不能与其他项目重名，重名返回 409）。同一事务内处理入账：「上海院已支付」`shPaid`（可省略，省略 = 保持原值、不入账不回退）否→是记**收入**（金额取企信实收），「支付下家」「支付陈沛」否→是记**支出**（金额取分包费/陈沛），需传 `postingAccountId` 和 `postingDate`（入账日期 YYYY-MM-DD，省略为服务器当天，非法日期 400）；是→否则删除对应流水（物理删除，写审计）。已入账字段的金额不可直接改（409）。**只有已归入合同（已结算）的项目才能把「上海院已支付」设为是**（否则 409 `PROJECT_NOT_IN_CONTRACT`）。新建项目（`POST /api/projects`）时「上海院已支付」固定为否 |
| POST | `/api/projects/:id/archive` | 「删除」项目：不物理删除，仅归档；已入账的项目不能删除（409），需先回退 |
| GET | `/api/projects/import/template` | 下载项目导入模板 |
| POST | `/api/projects/import/preview` / `commit` | 项目导入预览 / 确认（multipart `file`）；第 1 行表头，项目名称为「合计」的行与重复表头的说明行忽略，其余为数据；以项目名称为唯一键：已存在则更新，否则新增（合同编号可重复）；**只有「项目名称」「合同价」两列必填**，其余列均可缺失：新增时取默认值（文字空、金额 0、是否类为否），更新已有项目时缺的列保持库里原值；「备注」列写入项目备注；缺必填表头返回 422（IMPORT_HEADER_MISSING）。**批次随合同走**：「批次」列（「第15批」或 15；0 与非法写法按行报错）只用于**新建合同**时决定归属批次——合同编号在系统中不存在时自动新建合同，批次不存在也自动新建，批次留空归入「未分批」；合同编号已存在的沿用原批次，不被 Excel 改动；没有合同编号的项目不属于任何批次。**是否结算由合同编号决定**（有合同编号 = 已结算项目，留空 = 未结算项目）；「上海院已支付」列只打标记、不入账，没有合同编号却填「是」的行按行报错（422） |
| GET | `/api/contracts` / `/api/contracts/:id` | 合同列表（`?batchId=` 只取某批次下的合同，批次不存在 404；含 `batchId`/`batchNo`、合同总价=其下项目合同价之和、项目数）/ 详情（含其下全部项目） |
| POST | `/api/contracts` | 新增合同：`{batchId, contractNo, projects:[{projectId, contractPrice}]}`，**必须指定存在的批次**（缺失 400、不存在 404）；只能挑未归入任何合同（= 未结算）的项目（否则 409）；**归入合同不入账**（入账在项目里把「上海院已支付」切换为是时发生）；合同总价由项目合同价求和得到；合同编号未归档内唯一（409）；单项合同价为 0 ~ 100 亿元的整数分，小数/负数/字符串/超大值一律 400 |
| PATCH | `/api/contracts/:id` | 修改合同编号、所属批次（`batchId` 可省略 = 不变；指定其他批次 = 合同连同其下项目一起移过去）及项目合同价；也可加入未归入任何合同的已有项目（否则 409，整体不落库；加入不入账）；请求里没出现的已有项目保持不变，这里不能移除项目 |
| POST | `/api/contracts/:id/archive` | 「删除」合同：不物理删除，仅归档；**合同内部还有项目时拒绝**（409 CONTRACT_HAS_PROJECTS），需先删除其下项目（已入账的项目要先回退入账才能删） |
| GET/POST | `/api/batches` | 批次列表（按批次号倒序，含合同数、项目数、合同总价、企信实收、企信利润，均为整数分之和）/ 新增 `{batchNo, note?}`：批次号为 1 ~ 100000 的整数，未归档内唯一（409 DUPLICATE_BATCH_NO），非法值 400 |
| GET/PATCH | `/api/batches/:id` | 批次详情 / 修改批次号与备注（批次号变化同步到其下项目；0 号「未分批」不能改号，可改备注） |
| POST | `/api/batches/:id/archive` | 「删除」批次：不物理删除，仅归档；批次下还有合同时拒绝（409 BATCH_HAS_CONTRACTS），「未分批」不可删除（403） |
| POST | `/api/batches/seal` | **存档**：`{batchIds:[…]}` 手动挑选若干批次。存档时后端再校验一次：批次下每个项目的「上海院已支付 / 支付下家 / 支付陈沛」都必须为是，任一批次不满足则 409 `BATCH_NOT_FINISHED`（message 指出是哪个项目缺哪一步），**整体拒绝、都不存档**（事务）；已是存档状态 409；批次不存在 404；空批次（没有项目）可以存档。存档只是给批次打 `sealedAt` 时间戳，与「删除」（`archived`）无关 |
| POST | `/api/batches/:id/unseal` | **取消存档**：批次放回正在结算中；不是存档状态 409 `BATCH_NOT_SEALED` |

**存档批次整批只读**：批次的 `sealedAt` 有值时，其批次本身（改号/备注/删除）、其下合同（编辑/删除/加项目/移入移出）、其下项目（编辑含切换三项流程/删除/换合同）、批次相关文件（上传/删除）一律 409 `BATCH_SEALED`；Excel 导入命中存档批次（更新其下项目、引用其合同编号、在其中新建合同）按行报错、整批不入库；要改先取消存档。存档批次仍可读取。未归入合同的项目不属于任何批次，不受影响。`GET /api/batches?sealed=false` 只返回正在结算中的批次（界面「正在结算中」页），`?sealed=true` 只返回存档的批次（界面「存档」页），省略 = 全部。

## 路线图

- [x] 单机版骨架：账户、记账（收入/支出/借款/贷款）、总览、Excel 导入、删除/撤销、审计日志
- [ ] 数据备份/恢复（SQLite 在线备份）、本地数据库加密
- [ ] 对账（银行流水核对）、附件（发票/回单）、报表导出（Excel/PDF）
- [ ] 用户/角色/权限
- [ ] 联网：云端服务（PostgreSQL）+ 基于 `audit_log`/`version` 的同步
- [ ] 手机端（uni-app / Flutter）调用同一套 API

## 已知待办 / 注意

- 应用图标为占位图（`src-tauri/icons/`），发布前请替换（`npx tauri icon <png>` 可生成全套）。
- 导入模板仅支持收入/支出；借款/贷款请手工录入。
