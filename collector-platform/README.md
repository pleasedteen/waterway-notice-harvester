# 通行限制公示采集台

声明式规则驱动的通行限制公示采集系统。工作人员只维护**声明式抽取规则**（不为每份页面写解析代码），
系统负责稳定抓取、断点续跑、快照回归与原子发布。内置内存模拟站点，**全程不访问真实外站**。

## 一分钟运行

```bash
npm install
npm run demo     # 端到端验收演示：50 项断言，覆盖全部要求场景（约 1 秒）
npm test         # 32 个单元/集成测试（node:test，含一万条变化的分页压力用例）
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
| 大量变化分页 | 全量计数与发布结论不变；明细按页持久化。生成时内存只缓冲一页（≤ 500 条），读取汇总加载 0 条、读取单页 ≤ 500 条 |
| 来源变化 vs 规则行为变化 | 四象限归因 `attributeChanges`：旧快照×新旧规则隔离规则侧，同规则×新旧快照隔离来源侧；对照存在失败时标 `undeterminable` |
| 中断续跑 | 列表/条目/每页均落检查点（`CrawlService`）；重启后识别同来源同规则的未完成作业，复用已抓快照 |
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
    regression.ts       记录/字段 diff（流式）、期望比对、双变归因、全量计数
    report-paging.ts    报告分页原语：单页 500 条、分页写入器、旧格式兼容
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
tests/                  node:test 测试套件（含 fixtures/ 一万条变化离线夹具）
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
| `POST /api/regression/run` | 候选规则重放（`fixtureId` 单个，否则全部），返回**摘要**（全量计数、归因、页索引），不含变化明细 |
| `GET /api/reports` | 报告摘要列表（不含明细，读取时加载 0 条变化） |
| `GET /api/reports/:id` | 单个报告摘要（全量计数 + 各变化流页数） |
| `GET /api/reports/:id/summary` | 摘要 + 第 0 页预览（≤ 500 条） |
| `GET /api/reports/:id/changes/:stream?page=N` | 按页读取变化明细（`stream` = `record`/`source`/`rule`，单页 ≤ 500 条，含原始网页证据） |
| `GET /api/reports/:id/expectations?page=N` | 按页读取期望失配（单页 ≤ 500 条） |
| `POST /api/jobs/start` | 启动或续跑作业（同来源同规则自动回到未完成作业） |
| `POST /api/jobs/:id/run` | 推进一个检查点步长（可反复调用） |
| `GET /api/jobs`, `GET /api/jobs/:id` | 作业与检查点详情 |
| `POST /api/publish/evaluate` | 发布闸门评估（通过/拒绝原因/回归报告摘要；只读全量计数,不加载明细） |
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

## 报表分页与内存上限

回归报告的变化明细可能上万条，因此报告拆成"摘要 + 按页明细"两部分：

- **摘要**：全量计数（新增/删除/字段变化/类型不兼容/失败）、归因、通过结论与各变化流的页索引。
  发布闸门、`GET /api/reports` 与网页汇总只读摘要，加载 **0** 条明细。
- **明细**：`record`/`source`/`rule` 三个变化流与期望失配各自分页持久化，单页上限 `REPORT_PAGE_SIZE = 500`。
  网页与 `GET /api/reports/:id/changes/...` 每次只读一页（≤ 500 条）。
- **生成**：字段级流式 diff，边产出边写页，内存中只缓冲当前一页（峰值 ≤ 500 条）；单条记录自身超过一页时按页切片，
  计数只认首个片段，`recordsAdded/recordsRemoved` 不会被重复统计。
- **原子性**：明细页先落盘，摘要最后提交；中途失败不会留下可见的半份报告。
- **兼容与重启**：旧格式（明细内联）报告仍可查询并分页读取；重启后同一报告 id 的摘要与各页逐条一致。

`tests/report-paging.test.ts` 用一万条变化的离线夹具验证上述上限与重启一致性。

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
