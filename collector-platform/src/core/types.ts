/**
 * 核心领域类型。
 * 抽取结果区分四态：ok（含 0 这个有效限值）/ missing（未声明字段）/ none（明确无值）/ error（抽取失败）。
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'date';

export type ValueStatus = 'ok' | 'missing' | 'none' | 'error';

/** 归一化后的业务值；status 非 ok 时 value 为 null */
export interface CanonicalValue {
  status: ValueStatus;
  value: string | number | boolean | null;
  /** 归一化后的单位（如 kg、cm、t），无单位则为 null */
  unit: string | null;
  /** 明确无值时保留原始标记文本，如 "—"、"无限制" */
  noneMarker?: string;
  /** error 状态的原因 */
  error?: string;
}

/** 原始网页证据定位 */
export interface Evidence {
  /** 快照内逻辑 URL（含分页序号） */
  url: string;
  /** CSS 选择器路径 */
  selector: string;
  /** 命中文本（截断） */
  text: string;
  /** 表格单元格的行/列（1 基），非表格字段为 null */
  row?: number | null;
  col?: number | null;
  /** 分页序号（1 基） */
  page?: number;
}

export interface ExtractedField {
  field: string;
  value: CanonicalValue;
  evidence: Evidence[];
}

export interface BusinessRecord {
  /** 业务身份键，由 identity 字段（公告号+航段等）稳定拼接 */
  identity: string;
  /** 参与 identity 的字段值（便于展示） */
  identityParts: Record<string, string>;
  fields: Record<string, ExtractedField>;
  /** 嵌套列表（如分段限值、车辆类型清单） */
  nested: Record<string, NestedRecordList>;
  /** 该记录由哪些分页合并而成（页码升序、去重） */
  pagesMerged: number[];
  /** 记录级错误（如身份字段抽取失败） */
  recordError?: string;
}

export interface NestedRecordList {
  items: NestedRecord[];
  evidence: Evidence[];
}

export interface NestedRecord {
  identity: string | null;
  fields: Record<string, ExtractedField>;
}

/* ----------------------------- 规则文档（不可变版本） ----------------------------- */

export interface FieldRule {
  field: string;
  type: FieldType;
  selector: string;
  /** 取值属性，缺省取 textContent */
  attr?: string;
  /** 明确无值标记（匹配归一化空白后的文本），命中 => none */
  noneMarkers?: string[];
  /** 选择器未命中 => missing；命中但无法转换 => error */
  /** 单位来源：字面量，或同一记录内另一字段名（如单位列） */
  unit?: string;
  unitFromField?: string;
  /** 日期输出格式（ISO 或 yyyy-MM-dd 等），默认 ISO */
  dateFormat?: string;
  /** 布尔真值/假值词表 */
  booleanTrue?: string[];
  booleanFalse?: string[];
  /** 数字小数保留（默认保留原始精度，去除尾随 0） */
  precision?: number;
}

export interface TableRule {
  kind: 'table';
  field: string;
  selector: string;
  /** 表头可能跨行：用前 N 行组合列名，null/0 表示无表头按列号 col1.. */
  headerRows: number;
  /** 表头文本 -> 字段名映射；列名包含任一 key 即命中（跨行表头按空格拼接） */
  columns: Record<string, string>;
  /** 重复表头行的识别文本（续表场景），命中则跳过 */
  repeatHeaderMarkers?: string[];
  /** 字段类型/单位配置，键为 columns 映射后的字段名 */
  fieldRules?: Record<string, Pick<FieldRule, 'type' | 'unit' | 'unitFromField' | 'noneMarkers' | 'precision' | 'booleanTrue' | 'booleanFalse' | 'dateFormat'>>;
  /** 嵌套行的身份列（映射后字段名），用于续页合并 */
  itemIdentity?: string[];
  /** 跳行行选择器（相对于 table），如汇总行 */
  skipRowIf?: string;
}

export interface NestedListRule {
  kind: 'list';
  field: string;
  /** 重复项容器选择器 */
  itemSelector: string;
  itemFields: FieldRule[];
  itemIdentity?: string[];
}

export type NestedRule = TableRule | NestedListRule;

export interface PaginationRule {
  /** 下一页链接选择器；无匹配或 disabled 标记存在时停止 */
  nextSelector: string;
  /** 下一页不可用的判定（在当前页容器上匹配该选择器即终止） */
  disabledSelector?: string;
  /** 硬上限，防止死循环 */
  maxPages: number;
}

export interface ListSpec {
  /** 列表页条目链接选择器（相对于列表文档） */
  itemLinkSelector: string;
  /** 条目链接的属性，默认 href */
  linkAttr?: string;
  /** 列表页本身的分页（列表续页），可选 */
  pagination?: PaginationRule;
  /** 可从列表页预取的字段（带入详情记录，缺失不报错） */
  prefetchFields?: FieldRule[];
  /** 列表条目根容器（prefetch 字段相对它求值），默认 itemLink 的父节点链上最近公共容器 */
  itemRootSelector?: string;
}

export interface RuleDocument {
  ruleId: string;
  version: string;
  name: string;
  createdAt: string;
  /** 详情页字段（相对详情文档） */
  fields: FieldRule[];
  /** 详情页嵌套结构（表格映射 / 嵌套列表） */
  nested?: NestedRule[];
  /** 详情分页（续页），可选 */
  pagination?: PaginationRule;
  /** 列表页配置；缺省时抓取 seedUrl 当作单条详情 */
  list?: ListSpec;
  /** 业务身份字段（必须为详情/prefetch 顶层字段，且 status=ok） */
  identity: string[];
}

/* ----------------------------- 快照 ----------------------------- */

export interface Snapshot {
  snapshotId: string;
  sourceId: string;
  /** 来源修订标识（ETag/版本号/内容哈希），换版即变化 */
  revision: string;
  url: string;
  fetchedAt: string;
  statusCode: number;
  contentType: string;
  html: string;
}

/* ----------------------------- 采集作业（检查点） ----------------------------- */

export type JobStatus = 'running' | 'completed' | 'failed' | 'edition_changed' | 'aborted';

/**
 * 一次页面处理尝试的结局（值班员可据此区分重新请求 / 复用快照 / 失败）：
 * - fetched：本次真的发出请求并成功落盘快照；
 * - reused ：本次未发请求，直接复用已落盘的检查点快照；
 * - failed ：本次请求失败（网络/解析），无新快照；
 * - in_flight：尝试已登记但结局未知（典型为请求途中进程被强杀，重启后该记录永不被改写）。
 */
export type PageAttemptOutcome = 'fetched' | 'reused' | 'failed' | 'in_flight';

/**
 * 页面级尝试诊断（append-only）。每次列表/详情页处理只新增一条，
 * 单条记录不可变（in_flight 的旧尝试在重启后保持原状，新尝试另写新行），
 * 因此单次推进的诊断写入量只取决于本次触及的页面数，与历史尝试次数无关。
 */
export interface PageAttempt {
  /** 尝试唯一标识（进程重启后仍可凭它区分旧尝试与新尝试） */
  attemptId: string;
  jobId: string;
  /** 列表页为 list；详情页为 detail */
  kind: 'list' | 'detail';
  /** detail 页所属条目入口 URL；list 页为 null */
  entryUrl: string | null;
  /** 逻辑页码（1 基） */
  page: number;
  url: string;
  outcome: PageAttemptOutcome;
  /** fetched 成功并已落盘的快照 id；其余结局为 null */
  snapshotId: string | null;
  /** 失败原因或 in_flight 说明，成功/复用为 null */
  error: string | null;
  /** 尝试开始（登记）时间 */
  startedAt: string;
  /** 结局落定时间；in_flight 永远为 null */
  finishedAt: string | null;
}

export interface JobEntryState {
  entryUrl: string;
  /** 列表页预取字段（JSON 化） */
  prefetch: Record<string, ExtractedField>;
  status: 'pending' | 'done' | 'failed';
  /** 已抓取快照 id（按页序，检查点；只有这里出现的页面才算采集成功） */
  snapshotIds: string[];
  pagesMerged: number[];
  record: BusinessRecord | null;
  /** 条目级尝试次数（历史计数，仅用于展示；页面级明细见 PageAttempt） */
  attempts: number;
  /** 已为该条目的落盘快照写过 reused 尝试（断点续跑只记一次，避免重复推进产生重复诊断） */
  reuseLogged?: boolean;
  lastError: string | null;
  updatedAt: string;
}

export interface CrawlJob {
  jobId: string;
  sourceId: string;
  seedUrl: string;
  ruleId: string;
  ruleVersion: string;
  /** 启动时观察到的来源修订；中途发现不同修订 => edition_changed */
  expectedRevision: string;
  status: JobStatus;
  /** 列表页快照 id（检查点，不参与详情合并） */
  listSnapshotIds: string[];
  entries: JobEntryState[];
  /** 列表发现是否已完整跑完（断点续跑时据此跳过列表阶段，直接复用列表快照） */
  listDiscoveryDone?: boolean;
  /** 已为已落盘列表快照写过 reused 尝试（续跑只记一次，避免重复推进产生重复诊断） */
  listReuseLogged?: boolean;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  lastError: string | null;
  /** 发布状态 */
  publicationId: string | null;
}

/* ----------------------------- 回归夹具与报告 ----------------------------- */

export interface FixtureEntry {
  /** 条目入口 URL（业务身份对齐键） */
  entryUrl: string;
  /** 有序快照 id：详情第 1..n 页（续表） */
  snapshotIds: string[];
  /** 对应的逻辑 URL，便于审阅 */
  urls: string[];
}

export interface RegressionFixture {
  fixtureId: string;
  name: string;
  sourceId: string;
  /** 列表页快照 id（可空） */
  listSnapshotIds: string[];
  /** 按条目分组的详情快照 */
  entries: FixtureEntry[];
  expectedRevision: string;
  /** 期望的业务记录（canonical 形式） */
  expectedRecords: BusinessRecord[];
  createdAt: string;
  note?: string;
  /** 双变归因用：上一版来源快照（与 entries 同构、URL 对齐） */
  baselineListSnapshotIds?: string[];
  baselineEntries?: FixtureEntry[];
  /** 双变归因用：基线规则（旧快照+旧规则 => baseline 结果） */
  baselineRuleId?: string;
  baselineRuleVersion?: string;
}

export type FieldChangeKind =
  | 'added'
  | 'removed'
  | 'value_changed'
  | 'unit_changed'
  | 'status_changed'
  | 'type_incompatible'
  | 'new_failure'
  | 'failure_fixed';

export interface FieldChange {
  kind: FieldChangeKind;
  recordIdentity: string;
  field: string;
  before: CanonicalValue | null;
  after: CanonicalValue | null;
  evidence: Evidence[];
}

export interface RecordChange {
  identity: string;
  kind: 'added' | 'removed' | 'changed' | 'unchanged';
  fieldChanges: FieldChange[];
  pagesMergedBefore: number[];
  pagesMergedAfter: number[];
}

export type Attribution =
  | 'source_change'
  | 'rule_behavior_change'
  | 'both'
  | 'undeterminable'
  | 'none';

export interface RegressionReport {
  reportId: string;
  fixtureId: string;
  ruleId: string;
  ruleVersion: string;
  ranAt: string;
  passed: boolean;
  recordChanges: RecordChange[];
  /** 记录级新增/删除统计 */
  recordsAdded: number;
  recordsRemoved: number;
  fieldsChanged: number;
  typeIncompatibilities: number;
  failures: number;
  /** 双变归因（仅在提供对照快照/规则时产生） */
  attribution?: Attribution;
  attributionReason?: string;
  /** 归因为来源内容变化时，隔离出的来源侧记录变化（含证据） */
  sourceChanges?: RecordChange[];
  /** 归因为规则行为变化时，隔离出的规则侧记录变化（含证据） */
  ruleChanges?: RecordChange[];
  /** 与夹具期望结果的直接比对（重放当前夹具） */
  expectationMatches: boolean;
  expectationMismatches: string[];
}

/* ----------------------------- 发布 ----------------------------- */

export interface Publication {
  publicationId: string;
  sourceId: string;
  ruleId: string;
  ruleVersion: string;
  sourceRevision: string;
  jobId: string;
  regressionReportIds: string[];
  records: BusinessRecord[];
  publishedAt: string;
  note?: string;
}

/* ----------------------------- 来源配置 ----------------------------- */

export interface SourceConfig {
  sourceId: string;
  name: string;
  seedUrl: string;
}

/* ----------------------------- 存储抽象 ----------------------------- */

export interface Store {
  init(): Promise<void>;
  close(): Promise<void>;

  saveRule(rule: RuleDocument): Promise<void>;
  getRule(ruleId: string, version: string): Promise<RuleDocument | null>;
  listRules(ruleId?: string): Promise<RuleDocument[]>;

  saveSnapshot(snapshot: Snapshot): Promise<void>;
  getSnapshot(snapshotId: string): Promise<Snapshot | null>;
  listSnapshots(sourceId?: string): Promise<Snapshot[]>;

  saveFixture(fixture: RegressionFixture): Promise<void>;
  getFixture(fixtureId: string): Promise<RegressionFixture | null>;
  listFixtures(): Promise<RegressionFixture[]>;

  saveJob(job: CrawlJob): Promise<void>;
  getJob(jobId: string): Promise<CrawlJob | null>;
  listJobs(): Promise<CrawlJob[]>;

  /**
   * 页面尝试诊断（append-only 语义）：
   * 同一 attemptId 首次写入即不可变——in_flight 记录在重启后不会被覆盖，
   * 结局落定时写的是同一个 attemptId 的终态（先登记后终态，每条尝试至多两份物理写）。
   */
  savePageAttempt(attempt: PageAttempt): Promise<void>;
  listPageAttempts(jobId: string): Promise<PageAttempt[]>;

  saveRegressionReport(report: RegressionReport): Promise<void>;
  getRegressionReport(reportId: string): Promise<RegressionReport | null>;
  listRegressionReports(): Promise<RegressionReport[]>;

  /** 原子发布：提交后 currentPublication 切换，中途失败保留上一完整发布 */
  commitPublication(pub: Publication): Promise<void>;
  getCurrentPublication(sourceId: string): Promise<Publication | null>;
  getPublication(publicationId: string): Promise<Publication | null>;
  listPublications(sourceId?: string): Promise<Publication[]>;

  saveSource(source: SourceConfig): Promise<void>;
  getSource(sourceId: string): Promise<SourceConfig | null>;
  listSources(): Promise<SourceConfig[]>;
}
