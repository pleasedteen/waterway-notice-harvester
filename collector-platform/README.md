# 通行限制公示采集台

声明式规则驱动的通行限制公示采集系统。工作人员只维护**声明式抽取规则**（不为每份页面写解析代码），
系统负责稳定抓取、断点续跑、快照回归与原子发布。内置内存模拟站点，**全程不访问真实外站**。

## 一分钟运行

```bash
npm install
npm run demo     # 端到端验收演示：50 项断言，覆盖全部要求场景（约 1 秒）
npm test         # 28 个单元/集成测试（node:test，约 1 秒）
npm run verify:restart  # 真实进程强杀后重启，验证检查点续跑与页面尝试诊断（约 3 秒）
npm run verify:kill     # 请求途中强杀：in_flight 旧尝试与重启后新尝试可区分（约 5 秒）
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
| 页面尝试诊断 | 每次列表/详情页处理写一条 append-only `PageAttempt`，区分 `fetched`（重新请求）/`reused`（复用快照）/`failed`（失败）/`in_flight`（强杀后结局未知），带页面地址与快照 id；写入量只与本次触及页面数有关，不随历史尝试次数增长 |
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
    crawl-service.ts    检查点、续跑、换版阻断、分页失败处理
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
| `POST /api/jobs/start` | 启动或续跑作业（同来源同规则自动回到未完成作业） |
| `POST /api/jobs/:id/run` | 推进一个检查点步长（可反复调用） |
| `GET /api/jobs`, `GET /api/jobs/:id` | 作业与检查点详情（详情响应内嵌 `pageAttempts` 页面尝试诊断） |
| `GET /api/jobs/:id/attempts` | 该作业全部页面尝试（append-only，含强杀遗留的 `in_flight` 旧尝试） |
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
- `switchAfter` 故障注入：采集中换版；`faults` 注入：分页抓取失败后恢复，`slow` 注入：请求挂起（用于请求途中强杀验证）。

## 设计说明：为什么"未采到"不会变成删除

发布集只由**本批次成功条目**构成，且发布闸门要求整批 `completed`。
分页失败/换版时作业进入 `failed/edition_changed`，发布被拒绝，当前生效发布保持不变，
因此缺采只会阻断发布，绝不会把缺失数据写成"删除"。

## 设计说明：页面尝试如何在强杀后仍可区分新旧

每个列表页/详情页的一次处理对应一条 `PageAttempt`（`src/core/types.ts`），独立于作业快照，
append-only 落盘（嵌入式存储为 `attempts/` 目录每尝试一个文件；Postgres 为 `page_attempts` 表，
且只允许 `in_flight` 行更新为终态，历史行不可改写）。四种结局：

| 结局 | 含义 | 是否发请求 | 是否带 snapshotId |
| --- | --- | --- | --- |
| `fetched` | 本次重新请求成功，快照与检查点都已落盘 | 是 | 是 |
| `reused` | 本次直接复用已落盘快照，未发请求 | 否 | 是（指向被复用快照） |
| `failed` | 本次请求失败，无新快照，保留错误信息 | 是（失败） | 否 |
| `in_flight` | 已登记但结局未知——典型为请求途中进程被 SIGKILL | 进行中 | 否 |

关键时序：**发请求前先写 `in_flight`，请求成功并完成快照+作业检查点落盘后才把同一尝试落定为
`fetched`**。因此请求途中强杀时，该尝试永久停留在 `in_flight`（`finishedAt=null`）；重启后的
新尝试使用全新 `attemptId` 另写一条，旧记录原样保留，值班员可凭 `attemptId/startedAt` 明确区分
"结果未知的旧尝试"与"新尝试"。只有 `fetched`（检查点确实落盘）的页面才算采集成功，
`in_flight/failed` 一律没有 `snapshotId`，页面不会被误报为成功。

**单次推进的诊断写入量有常数上界**：一次页面处理至多两份物理写（`in_flight` 登记 + 终态落定），
复用场景仅一份。诊断是按"本次触及的页面"追加，而不是读取或重写全部历史，所以无论历史上失败/
重试了多少次，下一次推进新增的诊断量都只取决于本次实际碰到的页面数，不随历史次数线性增长。
`tests/page-attempts.test.ts` 以物理文件数对此做了断言。

## 设计说明：列表分页也能断点续跑

列表发现同样检查点化：每个列表页抓到后立即持久化并记录尝试。重启后续跑先逐个**复用**已落盘的
列表页快照（`reused`，不发请求）重建条目与续页指针，只对崩溃/失败时缺失的续页发起补抓；
列表阶段失败时作业保持 `failed` 且 `listDiscoveryDone=false`，故障消除后可继续，不会被误判完成。

## 故障注入环境变量（仅模拟站点、验证用）

| 变量 | 作用 | 示例 |
| --- | --- | --- |
| `MOCK_FAULTS` | 逗号分隔的 `URL片段:故障类型`，类型为 `error`/`slow`/`garbled` | `G2026-021:slow,G2026-018?page=2:error` |
| `MOCK_SLOW_DELAY_MS` | `slow` 故障的挂起时长（毫秒），默认 600000，用于在请求途中强杀 | `600000` |

