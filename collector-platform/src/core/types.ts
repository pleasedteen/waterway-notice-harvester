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
  /** 存储层内部标记：通过快照通道承载归并分片信封时为 merge_chunk；普通原页缺省/raw */
  snapshotKind?: 'raw' | 'merge_chunk';
}

/* ----------------------------- 采集作业（检查点） ----------------------------- */

export type JobStatus = 'running' | 'completed' | 'failed' | 'edition_changed' | 'aborted';

export interface JobEntryState {
  entryUrl: string;
  /** 列表页预取字段（JSON 化） */
  prefetch: Record<string, ExtractedField>;
  status: 'pending' | 'done' | 'failed';
  /** 已抓取快照 id（按页序） */
  snapshotIds: string[];
  pagesMerged: number[];
  record: BusinessRecord | null;
  attempts: number;
  lastError: string | null;
  updatedAt: string;
  /**
   * 逐页归并检查点游标（新检查点）：已完成"抽取片段 -> 归并 -> 提交"的详情页数。
   * 缺省表示升级前的旧检查点：恢复时回退为读取 snapshotIds 全部原页并一次性重建归并分片。
   */
  mergedPageCount?: number;
  /** 下一页待抓取 URL，随归并游标一起提交；恢复时无需重读已归并原页即可继续翻页 */
  nextPageUrl?: string | null;
}

/**
 * 单页归并分片：某一详情分页抽取后的未合并片段（含证据与对应原快照 id）。
 * 逐页不可变提交，每页写入量只与该等长页大小相关，因此累计检查点写入量随页数线性增长；
 * 恢复时按页序读回分片并通过同一个归并函数折叠，不需要重读已归并的原始页面。
 */
export interface MergeChunkDoc {
  kind: 'detail-merge-chunk';
  version: 1;
  /** 确定性分片 id：mc_<jobId>_<entryKey>_p<page>，崩溃重试覆盖同一分片 */
  chunkId: string;
  jobId: string;
  /** 作业内条目稳定键（如 e0） */
  entryKey: string;
  /** 分页序号（1 基，与 Evidence.page / PageDocument.page 一致） */
  page: number;
  /** 该页对应的原始快照 id */
  snapshotId: string;
  /** 从该页分页控件解析出的下一页 URL；末页为 null */
  nextPageUrl: string | null;
  /** 该页抽取片段（mergeDetailPages 中单个 pageRec 的等价物） */
  fragment: BusinessRecord;
}

/**
 * 归并分片存储的可选能力。Store 实现了这两个方法时使用独立分片文档；
 * 否则 CrawlService 回退到以现有 saveSnapshot/getSnapshot 存取分片信封，
 * 从而兼容只实现旧 Store 接口的包装器/测试替身。
 */
export interface MergeChunkStore {
  saveMergeChunk(chunk: MergeChunkDoc): Promise<void>;
  getMergeChunk(chunkId: string): Promise<MergeChunkDoc | null>;
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
