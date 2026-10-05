# 天文观测计划编排台（gbobsplan）

面向业余天文台与高校天文社团的值班排期人员：申请台与编排台双台账协作——申请台管观测申请单（编号、想拍的曝光时长、期限），编排台管观测夜、排程段与望远镜空档，两边各留一份、互不改写，按申请编号对账。解决纸质申请与排程对不上、目标亮度与月相冲突、设备被重复占用、阴天临时改期难以追溯的问题。纯前端单页应用，数据全部保存在浏览器本地，不依赖任何后端服务或外部接口。

## Docker 一键启动

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：<http://localhost:21813>

停止并清理：

```bash
docker compose down
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript |
| 构建 | Vite 6（`npm run build` 含 `tsc --noEmit` 类型检查） |
| UI | MUI（Material UI 5）+ Emotion |
| 路由 | React Router 6（7 条业务路由 + 404） |
| 状态 | Zustand（applicationStore / sessionStore / targetStore / equipmentStore / nightStore / reconcileStore） |
| 存储 | IndexedDB（Dexie，库名 `gbobsplan-db`，`schemaVersion` + v2/v3 迁移） |
| 托管 | nginx:alpine（多阶段构建，SPA try_files + gzip） |

## 本地开发

```bash
cd frontend
npm install
npm run dev      # http://localhost:21813
npm run build    # 类型检查 + 生产构建
```

## 目录结构

```
.
├── docker-compose.yml         # 顶层 name / COMPOSE_PROJECT_NAME 容器名 / 端口映射
├── .env.example               # COMPOSE_PROJECT_NAME、FRONTEND_PORT
├── frontend/
│   ├── Dockerfile             # node:20-alpine 构建 → nginx:alpine 托管
│   ├── nginx.conf             # try_files SPA 回退 + gzip
│   ├── public/favicon.svg
│   └── src/
│       ├── types/             # target / session / equipment / night / application / reconcile
│       ├── stores/            # applicationStore / sessionStore / targetStore / equipmentStore / nightStore / reconcileStore
│       ├── components/common/ # Timeline / StatusChip / ConflictBadge / FieldRow
│       ├── hooks/             # usePersistentStore（Dexie 读写 + Zustand 同步）/ useConflictCheck
│       ├── pages/             # OverviewPage / ApplicationsPage / TargetsPage / SessionsPage / EquipmentPage / ReconcilePage / ExportPage
│       ├── router/index.tsx   # 路由表
│       └── utils/             # astro.ts（高度角/可见窗口/月相）/ scheduler.ts（按单排段）/ reconcile.ts（对账派生）/ export.ts / id.ts
```

## 功能与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | 本夜编排总览 | 30 分钟刻度时间轴 + 月相与月出月落条带；冲突、已失效与低于高度阈值的目标自动标灰 |
| `/applications` | 观测申请单（申请台） | 登记编号、目标、想拍曝光时长与期限；编排进度由编排台排程段派生；保存按单幂等，失败可直接重试 |
| `/targets` | 观测目标库 | 按类型与优先级筛选、按视星等排序、维护地平高度阈值与曝光参数，并给出本夜可见窗口 |
| `/sessions` | 排程段与空档（编排台） | 各夜暗时段容量条、按单自动编排、冲突检测、确认标记，勾选多条批量改期到备用观测夜 |
| `/equipment` | 设备分配视图 | 行 = 望远镜、列 = 30 分钟时段；冲突格标红，点击可一键跳转到对应排程段 |
| `/reconcile` | 对账与挂起 | 孤儿段 / 漏排单 / 时长不符三类差异挂起等人定；无编号的历史段单列待认领 |
| `/export` | 导出观测清单 | 目标、时刻、滤镜、帧数导出为文本与 CSV，支持打印视图 |

## 双台账协作规则

- **各管各的**：申请台只写申请单（`applications` 表），编排台只写排程段（`sessions` 表）；编排台通过申请编号只读引用，两边互不改写对方台账。
- **按单排段**：编排台自动编排把待编排申请单按期限、提交时间排队，整段排入期限内最早有空档的观测夜；每夜暗时段（日落→日出）容量有限，当夜放不下就顺到后面的夜；已确认的段不挤掉，只在剩余空档里排新段。
- **时长改动**：申请单想拍时长一改，该单未确认的待执行段置为「已失效」等重排，已确认段保留，已完成的照旧留档。
- **对账挂起**：按申请编号对账——段引用了不存在的编号（孤儿段）、期限已过仍无段（漏排单）、有效段累计与想拍时长不符（时长不符），对不上的先挂起，值班人裁定后解除。
- **失败语义**：申请台保存按单 upsert，写坏重试不产生重复单；编排台失效 + 重排在一个事务里落库，写坏整体回滚、只退本侧，申请台台账不受影响。
- **历史迁移**：v3 升级时先按「目标 + 观测夜」为无编号旧段补建申请单存根，再按目标和时段回填编号（单张单回填额度不超过想拍时长）；挂不上的段保持空编号，进待认领列表人工挂接。

## 数据存储说明

- 全部数据存于浏览器 IndexedDB（Dexie，库名 `gbobsplan-db`），表：`targets`、`sessions`、`telescopes`、`instruments`、`nights`、`applications`、`reconcileHolds`、`meta`。
- `db.version(1).stores({...})` 声明索引；`db.version(2).upgrade(...)` 为排程段增加 `backupNightId` 索引并补齐 `schemaVersion`；`db.version(3).upgrade(...)` 新增 `applications` / `reconcileHolds` 两表与 `applicationId` 索引，并为旧段回填申请编号。
- 首次打开且表为空时写入示例数据（12 个观测目标、5 个观测夜、4 台望远镜、4 台终端、12 张申请单、14 段排程，含 1 处设备冲突、1 条改期记录、1 段待认领与 2 张排队待编排的申请单）。
- 容器无状态：不使用数据库服务、不挂载命名卷，`docker compose down` 后数据仍留在浏览器中。
