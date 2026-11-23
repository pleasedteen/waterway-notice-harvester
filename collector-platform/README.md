# 通行限制公示采集台

声明式规则驱动的通行限制公示采集系统。工作人员只维护**声明式抽取规则**（不为每份页面写解析代码），
系统负责稳定抓取、断点续跑、快照回归与原子发布。内置内存模拟站点，**全程不访问真实外站**。

## 一分钟运行

```bash
npm install
npm run demo     # 端到端验收演示：50 项断言，覆盖全部要求场景（约 1 秒）
npm test         # 32 个单元/集成/HTTP 测试（node:test，约 2 秒，含并发触发与失联接管）
npm run verify:restart  # 真实进程强杀后重启，验证检查点续跑（约 3 秒）
npm start        # 启动本地网页界面与 REST 接口：http://localhost:8080
```

安装依赖后，`npm run demo` 在 80 秒内完成并输出可读的逐项验收结果（本机实测约 1 秒）。
验证只依赖嵌入式文件存储与内存模拟站点，**不需要 PostgreSQL、Redis 或浏览器进程**。

## 能力对照

| 要求 | 实现 |
| --- | --- |
| 声明式规则，无夹具专用解析代码 | `src/core/rule-catalog.ts` 一份规则覆盖全部公告；引擎 `src/core/extractor.ts` 通用 |
| 字段选择 / 嵌套列表 / 表格映射 | `FieldRule`、`NestedListRule`、`TableRule`（`src/core/types.ts`） |
| 跨行跨列表头、重复表头、续表 | `src/core/table-grid.ts` 网格展开 rowspan/colspan，动态识别表头、跳过续表重复表头与汇总行 |
| 残缺/脏 HTML | `src/core/html-sanitizer.ts` 通用标签栈容错（未闭合 h1/p/span/td 等） |
| 类型与单位归一 | `src/core/normalize.ts`：全角数字、同义单位（吨/千克、厘米/米）换算到量纲基准 |
| 业务身份 | `identity` 字段稳定拼接；身份缺失产生记录级失败而非静默丢弃 |
| 分页关系 | `PaginationRule` 下一页/禁用标记/上限；同航段续页合并、跨页表格去重 |
| 四态区分 | `ok`（含 **0 是有效限值**）/ `missing`（选择器未命中）/ `none`（明确无值，如"—/无限制"）/ `error`（转换失败） |
| 规则版本不可变 | 同 `ruleId+version` 内容不同的保存被存储层拒绝 |
| 网页快照 + 回归夹具 | 每次抓取存快照；夹具带期望 canonical 结果，可完全离线重放 |
| 重放报告 | 新增/删除/字段变化/类型不兼容/新失败，逐条带原始网页证据（URL、选择器、表格行列、分页） |
| 来源变化 vs 规则行为变化 | 四象限归因 `attributeChanges`：旧快照×新旧规则隔离规则侧，同规则×新旧快照隔离来源侧；对照存在失败时标 `undeterminable` |
| 中断续跑 | 列表/条目/每页均落检查点（`CrawlService`）；重启后识别同来源同规则的未完成作业，复用已抓快照 |
| 按来源定时采集 | `SchedulerService` 按接口配置的间隔/规则版本到点自动推进作业；**发布仍由人工确认**，调度器不发布 |
| 同源并发限制 | 来源租约（嵌入式锁文件/PG 行锁 + 进程内互斥）保证同一来源同一轮两个实例只启动一次，手动续跑同样受限 |
| 失联接管 | 心跳超过接管时限即判定失联，另一实例沿用**同一轮/同一作业**接管：保留规则版本与已确认页检查点、不重抓已确认页 |
| 围栏写保护 | 租约易主/换轮递增 `fencingToken`，`saveJob` 校验 owner+令牌；旧实例迟到的结果/心跳被 `LeaseLostError` 拒绝，不能改写进度 |
| 来源隔离 | 每个来源一条独立异步链，一个来源请求挂起只阻塞自身，不拖住其他来源 |
| 采集中换版 | 来源修订（revision）逐页校验，不一致即 `edition_changed` 并阻断发布 |
| 分页失败 | 已采页面保留、条目标 failed、批次不完整；"未采到"永不解释为删除 |
| 发布闸门 | 仅 完整批次 + 同一来源修订 + 同一规则版本 + 回归通过 可发布；无夹具拒绝发布 |
| 原子发布、上一版可读 | 嵌入式存储 tmp+rename 切换 current 指针；PG 单事务切换；中途崩溃保留上一完整发布，历史可查 |
| 生产 PG / 验证替身 | 同一 `Store` 接口：`PostgresStore`（`PG_CONNECTION_STRING` 启用）与 `EmbeddedStore`（默认） |

## 目录结构

```
src/
  core/
    types.ts            领域模型与 Store 接口
    normalize.ts        文本/数字/布尔/日期/单位归一，四态 CanonicalValue
    html-sanitizer.ts   通用脏 HTML 容错
    table-grid.ts       rowspan/colspan 网格、表头与重复表头处理
    extractor.ts        声明式抽取引擎、续页合并、列表/分页发现
    regression.ts       记录/字段 diff、期望比对、双变归因、报告
    rule-catalog.ts     规则版本 v1 / v2 / 退化候选
    golden.ts           回归夹具的黄金期望（手工 canonical 值）
  storage/
    embedded-store.ts   零依赖文件存储（原子写、current 指针）
    pg-store.ts         PostgreSQL 生产存储（事务发布）
  fetch/fetcher.ts      Fetcher 抽象 + HTTP 实现
  mock/site.ts          内存模拟站点（换版/故障注入、脏 HTML、续表、全角单位）
  service/
    crawl-service.ts    检查点、续跑、换版阻断、分页失败处理、租约围栏绑定
    scheduler-service.ts 按来源定时调度、来源租约、同源并发限制、失联接管与围栏写保护
    regression-service.ts 夹具建立与离线重放
    publish-service.ts  发布闸门与原子提交
    app.ts              装配工厂
  server/               HTTP REST 接口
  web/index.html        本地单页界面（规则/作业/回归/发布/快照）
tests/                  node:test 测试套件
```

## 规则怎么写（声明式）

规则是一份 JSON 文档（见 `src/core/rule-catalog.ts`），核心片段：

```jsonc
{
  "ruleId": "rule-mock-notice", "version": "1.0.0",
  "identity": ["noticeNo", "segmentName"],          // 业务身份
  "list": {
    "itemLinkSelector": "a.notice-link",
    "itemRootSelector": "li.notice-item",
    "prefetchFields": [{ "field": "listNoticeNo", "type": "string", "selector": ".notice-no" }],
    "pagination": { "nextSelector": "nav.pager a.next",
                    "disabledSelector": "nav.pager span.next.disabled", "maxPages": 5 }
  },
  "pagination": { "nextSelector": "nav.pager a.next",
                  "disabledSelector": "nav.pager span.next.disabled", "maxPages": 10 },
  "fields": [
    { "field": "noticeNo", "type": "string", "selector": "#notice-no" },
    { "field": "effectiveDate", "type": "date", "selector": "#effective-date" },
    { "field": "contactPhone", "type": "string", "selector": "#contact-phone" }
  ],
  "nested": [
    { "kind": "table", "field": "limitRows", "selector": "table.limit-table",
      "headerRows": 2, "repeatHeaderMarkers": ["航段", "车型"], "skipRowIf": "text:注：",
      "columns": { "航段": "segment", "车型": "vehicleType", "限重": "weightLimit",
                   "限高": "heightLimit", "是否限行": "restricted", "备注": "remark" },
      "fieldRules": {
        "weightLimit": { "type": "number", "noneMarkers": ["无限制", "—"] },
        "restricted": { "type": "boolean", "booleanTrue": ["限行"], "booleanFalse": ["不限行"] }
      },
      "itemIdentity": ["segment", "vehicleType"] },
    { "kind": "list", "field": "timeWindows", "itemSelector": "ul.time-window li",
      "itemIdentity": ["windowRange"],
      "itemFields": [
        { "field": "windowRange", "type": "string", "selector": ".window-range" },
        { "field": "windowNote", "type": "string", "selector": ".window-note" } ] }
  ]
}
```

- 表头跨行跨列：`headerRows` 声明表头行数，引擎按 `th` 自动收敛，列名跨行拼接后做包含匹配。
- 等价单位：`30吨 / 30t / 30000千克` 统一归一为 `30000 kg`；`４５０厘米 / 4.5 m` 统一为 `4.5 m`。
- 四态：选择器不命中 → `missing`；命中 `noneMarkers` → `none`；数字/日期/布尔无法转换 → `error`；`0 吨` → `ok(0, kg)`。

## REST 接口摘要

| 方法/路径 | 作用 |
| --- | --- |
| `GET/POST /api/rules` | 列出/登记规则版本（同版本内容不同被拒） |
| `GET /api/snapshots`, `GET /api/snapshots/:id` | 快照列表与原始 HTML 证据 |
| `GET /api/fixtures`, `GET /api/fixtures/:id` | 回归夹具 |
| `POST /api/regression/run` | 候选规则重放（`fixtureId` 单个，否则全部），返回 diff/归因/证据 |
| `POST /api/jobs/start` | 启动或续跑作业（经来源租约，同来源同轮自动回到未完成作业，返回 `{outcome,job,lease}`） |
| `POST /api/jobs/:id/run` | 推进一个检查点步长（手动续跑，受同源并发限制；忙时 409） |
| `GET /api/jobs`, `GET /api/jobs/:id` | 作业与检查点详情 |
| `GET/POST /api/schedules`, `GET/PUT /api/schedules/:sourceId` | 按来源配置采集间隔、规则版本、接管时限、每步条目数、启停 |
| `POST /api/schedules/:sourceId/enabled` | 启用/停用某来源的定时采集 |
| `POST /api/schedules/:sourceId/tick` | 手动触发一次调度评估（受间隔门控与租约限制） |
| `GET /api/leases`, `GET /api/leases/:sourceId` | 来源租约状态（持有者、轮次、围栏令牌、心跳、释放/退避原因） |
| `POST /api/publish/evaluate` | 发布闸门评估（通过/拒绝原因/回归报告） |
| `POST /api/publish` | 原子发布 |
| `GET /api/publications`, `/api/publications/current` | 历史与当前生效发布 |

## 生产部署

```bash
# 可选：不设则用嵌入式文件存储（默认 ./.demo-data/server）
export PG_CONNECTION_STRING=postgres://user:pass@host:5432/collector
export PORT=8080
npm start
```

`PostgresStore` 启动时幂等建表；发布在单事务内先写完整 publication 再切换 `current_publication`，
事务中断自动回滚，current 始终指向最近一个完整发布。

## 模拟站点覆盖的场景

`src/mock/site.ts` 是纯内存路由（无 socket）：

- **G2026-018**：同号公告两个航段，跨行跨列表头 + 续页重复表头 + 汇总行 + 嵌套时间窗；
- **G2026-021**：未闭合标签的脏 HTML、全角数字、等价单位写法；
- **G2026-030**：`0 吨` 零限值、明确无值、页面缺失字段（missing）；
- **G2026-999**：身份字段缺失的记录级失败素材；
- `edition v1 → v2`：A 公告限重真实变化（30t→28t），用于双变归因；
- `switchAfter` 故障注入：采集中换版；`faults` 注入：分页抓取失败后恢复。

## 设计说明：为什么"未采到"不会变成删除

发布集只由**本批次成功条目**构成，且发布闸门要求整批 `completed`。
分页失败/换版时作业进入 `failed/edition_changed`，发布被拒绝，当前生效发布保持不变，
因此缺采只会阻断发布，绝不会把缺失数据写成"删除"。

## 设计说明：定时采集、同源并发限制与失联接管

两个实例共用同一份存储（嵌入式文件存储或 PostgreSQL）时，按"来源租约 + 围栏令牌"协同：

- **轮次（round）锚定作业**：每次定时到点开一轮（`<sourceId>#r<n>`），轮次写入 `CrawlJob.round`。
  同轮内无论谁推进都落在**同一作业**上；接管与手动续跑复用该轮，因此检查点（已确认页快照）天然沿用、不重抓。
- **同轮只启动一次**：`acquireLease` 在嵌入式存储用进程内互斥 + `mkdir` 锁文件、PG 用 `SELECT … FOR UPDATE`
  行锁串行化竞争。活跃且未超时的租约被他人请求时返回 `busy`（HTTP 409），手动续跑走同一套限制。
- **心跳与接管**：运行方每推进一个检查点步长前刷新心跳 `heartbeatAtMs`。
  超过 `takeoverTimeoutMs` 未心跳即判失联，另一实例的 tick 接管该租约——保留 `round/jobId`、
  规则版本与全部已确认页检查点，从首个未完成条目继续。
- **围栏防迟到写入**：易主或换轮时 `fencingToken` 递增。`saveJob` 携带 `(ownerId, fencingToken)`，
  存储层校验当前活跃租约；旧实例恢复后的迟到结果与心跳抛 `LeaseLostError`（HTTP 410），不能改写新进度。
  嵌入式存储另有进程内围栏视图，失效 owner 在争抢锁文件前即被快速拒绝。
- **来源隔离**：调度器为每个来源维护独立异步链（`inflight`），一个来源的请求挂起只停在自己的链上，
  其他来源照常到点采集。
- **自动不发布**：调度器只负责把作业推进到 `completed/failed/edition_changed` 并释放租约；
  发布始终走 `/api/publish` 人工闸门。失败作业带退避时间，避免故障期空转（手动续跑忽略退避）。

时序相关逻辑由 `Clock` 抽象承载：生产用 `SystemClock`，离线测试用 `VirtualClock`
确定性推进时间，无需真实等待即可复现"失联 → 超时 → 接管"。
