/**
 * 回归报告的分页原语。
 *
 * 回归报告可能包含上万条变化明细。规则：
 *  - 全量计数与发布门禁结论来自完整变化流，永远不受分页影响；
 *  - 明细按页持久化，单页最多 REPORT_PAGE_SIZE 条；
 *  - 生成报告时只在内存中缓冲当前一页（峰值 ≤ REPORT_MEMORY_BUFFER_LIMIT 条），
 *    写满即落盘并清空，因此内存占用与变化总量无关；
 *  - 读取汇总时加载 0 条明细，读取单页时最多加载一页。
 *
 * 另外，单个记录若自身携带超过一页的字段变化，会被切成多个片段（fragmentIndex），
 * 使"单页最多 500 条明细"对任意数据都成立。
 */
import type {
  ChangePage,
  ChangeStream,
  ChangeStreamIndex,
  ExpectationPage,
  FieldChange,
  RecordChange,
  RegressionReport,
  RegressionReportSummary,
  RegressionReportWriter,
  RecordChangePart,
} from './types.js';

/** 单页明细上限（网页与接口每次最多加载的明细条数） */
export const REPORT_PAGE_SIZE = 500;

/** 生成报告时允许同时缓冲在内存中的变化明细上限（等于一页） */
export const REPORT_MEMORY_BUFFER_LIMIT = REPORT_PAGE_SIZE;

/** 生成过程的观测指标：用于验证"生成时内存缓冲 ≤ 500 条" */
export interface ReportGenerationStats {
  /** 同时在内存中缓冲、尚未落盘的变化明细峰值 */
  peakBufferedChanges: number;
  /** 写出的变化明细总条数（所有流） */
  changesWritten: number;
  /** 写出的页数（所有流，不含期望失配页） */
  pagesWritten: number;
}

export function pageCount(total: number, pageSize: number = REPORT_PAGE_SIZE): number {
  const ps = normalizePageSize(pageSize);
  return total <= 0 ? 0 : Math.ceil(total / ps);
}

/** 单页大小约束在 [1, REPORT_PAGE_SIZE]；缺省/非法值取上限 */
export function normalizePageSize(requested?: number): number {
  if (!requested || !Number.isFinite(requested) || requested < 1) return REPORT_PAGE_SIZE;
  return Math.min(Math.floor(requested), REPORT_PAGE_SIZE);
}

export function normalizePage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page) || page < 0) return 0;
  return Math.floor(page);
}

/**
 * 按"总明细条数"切分记录变化（仅用于测试/小数据集入口）。
 * 单条记录可跨多个片段，保证每个片段 ≤ pageSize 条字段变化；
 * 片段携带 fragmentIndex，计数时只认首个片段。
 */
export function fragmentChange(change: RecordChange, pageSize: number = REPORT_PAGE_SIZE): RecordChange[] {
  const n = change.fieldChanges.length;
  if (n <= pageSize) return [change];
  const parts: RecordChange[] = [];
  for (let start = 0, idx = 0; start < n; start += pageSize, idx += 1) {
    parts.push({
      ...change,
      fieldChanges: change.fieldChanges.slice(start, start + pageSize),
      fragmentIndex: idx,
    });
  }
  return parts;
}

/** 记录级计数只认首个片段（或未切分的完整记录） */
export function isPrimaryFragment(change: RecordChange): boolean {
  return change.fragmentIndex === undefined || change.fragmentIndex === 0;
}

/** 单条变化明细的"重量"：字段变化条数，至少计 1（记录级变化本身也是一条明细） */
function changeWeight(change: RecordChange): number {
  return Math.max(1, change.fieldChanges.length);
}

/**
 * 记录级变化分页写入器（字段级输入）。
 *
 * 以"明细条数"为单位装箱：一条记录变化按其字段变化条数计重（至少 1）。
 *  - 页缓冲 + 正在累积的单条记录合计达到一页立即写页，峰值 ≤ 一页；
 *  - 单条记录字段变化超过一页时切成多个片段（fragmentIndex），单条明细也不超页。
 * 因此内存缓冲与变化总量、单条记录大小都无关。
 */
export class ChangePageSink {
  private buffer: RecordChange[] = [];
  private bufferedWeight = 0;
  private page = 0;
  private total = 0;
  private records = 0;
  private written = 0;
  /** 正在累积字段变化的记录 */
  private open: { recordIndex: number; change: RecordChange; fieldChanges: FieldChange[] } | null = null;

  constructor(
    private readonly writer: RegressionReportWriter,
    private readonly stream: ChangeStream,
    private readonly metrics?: ReportGenerationStats,
    private readonly pageSize: number = REPORT_PAGE_SIZE,
  ) {}

  /**
   * 推入一条字段级变化：同一记录连续推入的字段变化会合并成一条 RecordChange；
   * 合并后的记录超过一页时按页切分（fragmentIndex），保证单页上限成立。
   */
  async pushPart(part: RecordChangePart): Promise<void> {
    const fc = part.fieldChange;
    if (!fc) {
      // 没有字段变化：该记录单独成为一条无明细记录
      await this.pushRecord({
        identity: part.identity,
        kind: part.kind,
        fieldChanges: [],
        pagesMergedBefore: part.pagesMergedBefore,
        pagesMergedAfter: part.pagesMergedAfter,
      });
      return;
    }
    if (!this.open || this.open.recordIndex !== part.recordIndex) {
      await this.flushOpen();
      this.open = {
        recordIndex: part.recordIndex,
        change: {
          identity: part.identity,
          kind: part.kind,
          fieldChanges: [],
          pagesMergedBefore: part.pagesMergedBefore,
          pagesMergedAfter: part.pagesMergedAfter,
        },
        fieldChanges: [],
      };
    }
    // 先让页缓冲腾出空间，保证"页缓冲 + 正在累积的记录"始终 ≤ 一页
    if (this.bufferedWeight > 0 && this.bufferedWeight + this.open.fieldChanges.length + 1 > this.pageSize) {
      await this.flushPage();
    }
    this.open.fieldChanges.push(fc);
    this.observe();
    // 单条记录字段变化达一页：先写出这一片段，剩余继续累积
    if (this.open.fieldChanges.length >= this.pageSize) {
      const fragment: RecordChange = { ...this.open.change, fieldChanges: this.open.fieldChanges.splice(0) };
      await this.pushRecord(fragment);
      this.open.change = { ...this.open.change, fragmentIndex: (this.open.change.fragmentIndex ?? 0) + 1 };
    }
  }

  private async flushOpen(): Promise<void> {
    if (!this.open) return;
    const change: RecordChange = { ...this.open.change, fieldChanges: this.open.fieldChanges };
    this.open = null;
    await this.pushRecord(change);
  }

  private async pushRecord(change: RecordChange): Promise<void> {
    for (const part of fragmentChange(change, this.pageSize)) {
      const weight = changeWeight(part);
      // 先判断再加入：保证单页"明细重量"（字段变化条数）不超过 pageSize
      if (this.bufferedWeight > 0 && this.bufferedWeight + weight > this.pageSize) await this.flushPage();
      this.buffer.push(part);
      this.bufferedWeight += weight;
      this.total += 1;
      if (isPrimaryFragment(part)) this.records += 1;
      this.observe();
      if (this.bufferedWeight >= this.pageSize) await this.flushPage();
    }
  }

  /** 内存中当前持有的明细重量 = 页缓冲 + 正在累积的记录 */
  private bufferedDetail(): number {
    return this.bufferedWeight + (this.open?.fieldChanges.length ?? 0);
  }

  private observe(): void {
    if (!this.metrics) return;
    const buffered = this.bufferedDetail();
    if (buffered > this.metrics.peakBufferedChanges) this.metrics.peakBufferedChanges = buffered;
    this.metrics.changesWritten = this.total;
  }

  private async flushPage(): Promise<void> {
    if (this.buffer.length === 0) return;
    const changes = this.buffer;
    this.buffer = [];
    this.bufferedWeight = 0;
    await this.writer.writeChangePage(this.stream, this.page, this.pageSize, changes);
    this.page += 1;
    this.written += changes.length;
    if (this.metrics) {
      this.metrics.changesWritten = this.total;
      this.metrics.pagesWritten += 1;
    }
  }

  /** 结束：写出最后一页与未完成的记录，返回索引（此处不持有任何明细） */
  async finish(): Promise<ChangeStreamIndex> {
    await this.flushOpen();
    await this.flushPage();
    return { total: this.total, records: this.records, pages: this.page, pageSize: this.pageSize };
  }
}

/** 期望失配文本分页写入器（独立于变化明细统计） */
export class StringPageSink {
  private buffer: string[] = [];
  private page = 0;
  private total = 0;

  constructor(
    private readonly writer: RegressionReportWriter,
    private readonly pageSize: number = REPORT_PAGE_SIZE,
  ) {}

  async push(text: string): Promise<void> {
    this.buffer.push(text);
    this.total += 1;
    if (this.buffer.length >= this.pageSize) await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const mismatches = this.buffer;
    this.buffer = [];
    await this.writer.writeExpectationPage(this.page, this.pageSize, mismatches);
    this.page += 1;
  }

  async finish(): Promise<ChangeStreamIndex> {
    await this.flush();
    return { total: this.total, records: this.total, pages: this.page, pageSize: this.pageSize };
  }
}

/** 归一为固定形状：缺省可选字段显式写 undefined，保证跨进程读取后深比较一致 */
export function canonicalSummary(summary: RegressionReportSummary): RegressionReportSummary {
  return {
    reportId: summary.reportId,
    fixtureId: summary.fixtureId,
    ruleId: summary.ruleId,
    ruleVersion: summary.ruleVersion,
    ranAt: summary.ranAt,
    passed: summary.passed,
    recordsAdded: summary.recordsAdded,
    recordsRemoved: summary.recordsRemoved,
    fieldsChanged: summary.fieldsChanged,
    typeIncompatibilities: summary.typeIncompatibilities,
    failures: summary.failures,
    attribution: summary.attribution,
    attributionReason: summary.attributionReason,
    expectationMatches: summary.expectationMatches,
    expectationMismatchCount: summary.expectationMismatchCount,
    streams: {
      record: summary.streams.record,
      source: summary.streams.source,
      rule: summary.streams.rule,
      expectation: summary.streams.expectation,
    },
  };
}

/**
 * 把存储中的文档归一化为摘要。
 * 新旧格式都能读取：旧报告把明细内联在 doc 中，这里只返回计数，明细仍可翻页查询。
 */
export function normalizeStoredSummary(doc: Record<string, unknown>): RegressionReportSummary {
  const summary = hasStreams(doc) ? fromNewFormat(doc) : fromLegacyFormat(doc);
  return canonicalSummary(summary);
}

function hasStreams(doc: Record<string, unknown>): boolean {
  return doc.streams !== undefined && doc.streams !== null && typeof doc.streams === 'object';
}

function fromNewFormat(doc: Record<string, unknown>): RegressionReportSummary {
  const summary = doc as unknown as RegressionReportSummary;
  const expectation = summary.streams.expectation ?? emptyIndex(summary.expectationMismatchCount ?? 0);
  return {
    ...summary,
    expectationMismatchCount: summary.expectationMismatchCount ?? expectation.total,
    streams: {
      record: withRecords(summary.streams.record, summary.recordsAdded + summary.recordsRemoved),
      source: summary.streams.source,
      rule: summary.streams.rule,
      expectation,
    },
  };
}

function fromLegacyFormat(doc: Record<string, unknown>): RegressionReportSummary {
  // 旧格式：明细内联在报告文档中，只提取计数。
  const legacy = doc as unknown as RegressionReport;
  const idx = (arr: RecordChange[] | undefined): ChangeStreamIndex | undefined =>
    arr ? { total: arr.length, records: arr.length, pages: pageCount(arr.length), pageSize: REPORT_PAGE_SIZE } : undefined;
  return {
    reportId: String(legacy.reportId),
    fixtureId: String(legacy.fixtureId),
    ruleId: String(legacy.ruleId),
    ruleVersion: String(legacy.ruleVersion),
    ranAt: String(legacy.ranAt),
    passed: Boolean(legacy.passed),
    recordsAdded: Number(legacy.recordsAdded ?? 0),
    recordsRemoved: Number(legacy.recordsRemoved ?? 0),
    fieldsChanged: Number(legacy.fieldsChanged ?? 0),
    typeIncompatibilities: Number(legacy.typeIncompatibilities ?? 0),
    failures: Number(legacy.failures ?? 0),
    attribution: legacy.attribution,
    attributionReason: legacy.attributionReason,
    expectationMatches: Boolean(legacy.expectationMatches),
    expectationMismatchCount: legacy.expectationMismatches?.length ?? 0,
    streams: {
      record: idx(legacy.recordChanges) ?? emptyIndex(0),
      source: idx(legacy.sourceChanges),
      rule: idx(legacy.ruleChanges),
      expectation: emptyIndex(legacy.expectationMismatches?.length ?? 0),
    },
  };
}

function emptyIndex(total: number): ChangeStreamIndex {
  return { total, records: total, pages: pageCount(total), pageSize: REPORT_PAGE_SIZE };
}

function withRecords(index: ChangeStreamIndex, records: number): ChangeStreamIndex {
  return { ...index, records: index.records ?? records };
}

/** 旧格式报告的分页切片（明细内联，切片后返回 ≤ 一页） */
export function legacyChangePage(
  doc: unknown,
  reportId: string,
  stream: ChangeStream,
  page: number,
): ChangePage | null {
  const legacy = doc as RegressionReport;
  const full = stream === 'record' ? legacy.recordChanges : stream === 'source' ? legacy.sourceChanges : legacy.ruleChanges;
  if (!full) return null;
  const ps = REPORT_PAGE_SIZE;
  const p = normalizePage(page);
  return {
    reportId,
    stream,
    page: p,
    pageSize: ps,
    pages: pageCount(full.length, ps),
    total: full.length,
    changes: full.slice(p * ps, (p + 1) * ps),
  };
}

export function legacyExpectationPage(
  doc: unknown,
  reportId: string,
  page: number,
): ExpectationPage | null {
  const legacy = doc as RegressionReport;
  if (!legacy.expectationMismatches) return null;
  const ps = REPORT_PAGE_SIZE;
  const p = normalizePage(page);
  return {
    reportId,
    page: p,
    pageSize: ps,
    pages: pageCount(legacy.expectationMismatches.length, ps),
    total: legacy.expectationMismatches.length,
    mismatches: legacy.expectationMismatches.slice(p * ps, (p + 1) * ps),
  };
}
