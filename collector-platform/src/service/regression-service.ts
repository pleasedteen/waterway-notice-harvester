/**
 * 回归服务：
 * - 建立带期望结果的夹具（快照永久离线保存，按条目分组、支持续页）；
 * - 候选规则重放历史快照，输出新增/删除/字段变化/类型不兼容/失败及证据；
 * - 网站与规则同时变化时做四象限归因，证据不足 => undeterminable。
 *
 * 大量变化时报告按页写出：生成过程中只在内存缓冲当前一页（≤ 500 条），
 * 汇总计数与发布结论来自全量流；网页/接口读取汇总 0 条明细、读取单页 ≤ 500 条。
 */
import { extractFromSnapshots } from '../core/extractor.js';
import {
  classifyAttribution,
  buildRegressionReportSummary,
  diffRecordPartsSeq,
  emptyChangeCounts,
  compareExpectationsSeq,
  type ChangeCounts,
} from '../core/regression.js';
import { ChangePageSink, StringPageSink, canonicalSummary, type ReportGenerationStats } from '../core/report-paging.js';
import { newId, nowIso } from '../core/ids.js';
import type {
  BusinessRecord,
  ChangePage,
  ChangeStream,
  ExpectationPage,
  FixtureEntry,
  RegressionFixture,
  RegressionReport,
  RegressionReportSummary,
  RecordChangePart,
  RuleDocument,
  Snapshot,
  Store,
} from '../core/types.js';

export interface CreateFixtureInput {
  fixtureId?: string;
  name: string;
  sourceId: string;
  listSnapshots?: Snapshot[];
  entries: { entryUrl: string; snapshots: Snapshot[] }[];
  expectedRecords: BusinessRecord[];
  note?: string;
  baselineListSnapshots?: Snapshot[];
  baselineEntries?: { entryUrl: string; snapshots: Snapshot[] }[];
  baselineRule?: RuleDocument;
}

/** 报告生成的可观测统计（验收内存上限用） */
export type { ReportGenerationStats };

export class RegressionService {
  constructor(private readonly store: Store) {}

  async createFixture(input: CreateFixtureInput): Promise<RegressionFixture> {
    const all = [
      ...(input.listSnapshots ?? []),
      ...input.entries.flatMap((e) => e.snapshots),
      ...(input.baselineListSnapshots ?? []),
      ...(input.baselineEntries?.flatMap((e) => e.snapshots) ?? []),
    ];
    for (const s of all) await this.store.saveSnapshot(s);

    const toEntry = (e: { entryUrl: string; snapshots: Snapshot[] }): FixtureEntry => ({
      entryUrl: e.entryUrl,
      snapshotIds: e.snapshots.map((s) => s.snapshotId),
      urls: e.snapshots.map((s) => s.url),
    });

    const fixture: RegressionFixture = {
      fixtureId: input.fixtureId ?? newId('fixture'),
      name: input.name,
      sourceId: input.sourceId,
      listSnapshotIds: (input.listSnapshots ?? []).map((s) => s.snapshotId),
      entries: input.entries.map(toEntry),
      expectedRevision: input.entries[0]?.snapshots[0]?.revision ?? 'unknown',
      expectedRecords: input.expectedRecords,
      createdAt: nowIso(),
      note: input.note,
      baselineListSnapshotIds: input.baselineListSnapshots?.map((s) => s.snapshotId),
      baselineEntries: input.baselineEntries?.map(toEntry),
      baselineRuleId: input.baselineRule?.ruleId,
      baselineRuleVersion: input.baselineRule?.version,
    };
    await this.store.saveFixture(fixture);
    return fixture;
  }

  private async loadOrdered(ids: string[]): Promise<Snapshot[]> {
    const out: Snapshot[] = [];
    for (const id of ids) {
      const s = await this.store.getSnapshot(id);
      if (!s) throw new Error(`快照缺失: ${id}`);
      out.push(s);
    }
    return out;
  }

  private async replayEntries(entries: FixtureEntry[], rule: RuleDocument): Promise<BusinessRecord[]> {
    const records: BusinessRecord[] = [];
    for (const entry of entries) {
      const snaps = await this.loadOrdered(entry.snapshotIds);
      records.push(extractFromSnapshots(snaps, rule));
    }
    return records.sort((a, b) => a.identity.localeCompare(b.identity));
  }

  /**
   * 重放并返回摘要 + 首屏明细（首屏取自分页存储，单流 ≤ 500 条）。
   * 汇总计数与通过结论来自全量流，明细按页另行读取。
   */
  async replay(fixtureId: string, candidate: RuleDocument): Promise<RegressionReport> {
    const { summary } = await this.replayWithStats(fixtureId, candidate);
    return this.attachFirstPages(summary);
  }

  /** 重放并只返回摘要：不加载任何变化明细（发布门禁、汇总接口使用） */
  async replaySummary(fixtureId: string, candidate: RuleDocument): Promise<RegressionReportSummary> {
    const { summary } = await this.replayWithStats(fixtureId, candidate);
    return summary;
  }

  /** 与 replay 相同，同时返回生成过程的观测指标（验收内存上限用） */
  async replayWithStats(
    fixtureId: string,
    candidate: RuleDocument,
  ): Promise<{ summary: RegressionReportSummary; generationStats: ReportGenerationStats }> {
    const fixture = await this.store.getFixture(fixtureId);
    if (!fixture) throw new Error(`夹具不存在: ${fixtureId}`);

    const actualRecords = await this.replayEntries(fixture.entries, candidate);
    const expectedRecords = [...fixture.expectedRecords].sort((a, b) => a.identity.localeCompare(b.identity));
    const expectedBroken = new Set(
      fixture.expectedRecords.filter((r) => r.recordError !== undefined).map((r) => r.identity),
    );

    const reportId = newId('report');
    const stats: ReportGenerationStats = { peakBufferedChanges: 0, changesWritten: 0, pagesWritten: 0 };

    // 归因所需的三份记录集（不含变化明细）；判定本身是流式的，不保留完整 diff
    let attribution: RegressionReport['attribution'];
    let attributionReason: string | undefined;
    let ruleSide: { before: BusinessRecord[]; after: BusinessRecord[] } | null = null;
    let sourceSide: { before: BusinessRecord[]; after: BusinessRecord[] } | null = null;
    if (fixture.baselineEntries?.length && fixture.baselineRuleId && fixture.baselineRuleVersion) {
      const baselineRule = await this.store.getRule(fixture.baselineRuleId, fixture.baselineRuleVersion);
      if (!baselineRule) throw new Error('基线规则缺失，无法归因');
      const baseline = await this.replayEntries(fixture.baselineEntries, baselineRule);
      const oldSnapshotNewRule = await this.replayEntries(fixture.baselineEntries, candidate);
      const decided = classifyAttribution({
        baseline,
        oldSnapshotNewRule,
        newSnapshotNewRule: actualRecords,
        expectedBrokenIdentities: expectedBroken,
      });
      attribution = decided.attribution;
      attributionReason = decided.reason;
      ruleSide = { before: baseline, after: oldSnapshotNewRule };
      sourceSide = { before: oldSnapshotNewRule, after: actualRecords };
    }

    const writer = this.store.createRegressionReportWriter(reportId);
    try {
      const recordSink = new ChangePageSink(writer, 'record', stats);
      const sourceSink = sourceSide ? new ChangePageSink(writer, 'source', stats) : null;
      const ruleSink = ruleSide ? new ChangePageSink(writer, 'rule', stats) : null;
      const expectationSink = new StringPageSink(writer);

      // 记录流：字段级逐条写入同时累计计数，内存只保留当前页
      const recordCounts = emptyChangeCounts();
      let lastRecordIndex = -1;
      for (const part of diffRecordPartsSeq(expectedRecords, actualRecords)) {
        await recordSink.pushPart(part);
        if (part.recordIndex !== lastRecordIndex) {
          // 每条记录只在首个片段上计一次记录级新增/删除/坏身份
          lastRecordIndex = part.recordIndex;
          countRecordLevel(recordCounts, part, expectedBroken);
        }
        countFieldLevel(recordCounts, part);
      }

      // 归因两侧的变化流：逐条再生成一次（不缓存明细）
      if (ruleSide && ruleSink) {
        for (const part of diffRecordPartsSeq(ruleSide.before, ruleSide.after)) await ruleSink.pushPart(part);
      }
      if (sourceSide && sourceSink) {
        for (const part of diffRecordPartsSeq(sourceSide.before, sourceSide.after)) await sourceSink.pushPart(part);
      }

      for (const text of compareExpectationsSeq(expectedRecords, actualRecords)) {
        await expectationSink.push(text);
      }
      const recordIndex = await recordSink.finish();
      const expectationIndex = await expectationSink.finish();
      const sourceIndex = sourceSink ? await sourceSink.finish() : undefined;
      const ruleIndex = ruleSink ? await ruleSink.finish() : undefined;

      const expectationMismatchCount = expectationIndex.total;
      const summary = buildRegressionReportSummary({
        reportId,
        fixtureId,
        ruleId: candidate.ruleId,
        ruleVersion: candidate.version,
        ranAt: nowIso(),
        counts: recordCounts,
        expectationMismatchCount,
        streams: {
          record: recordIndex,
          source: sourceIndex,
          rule: ruleIndex,
          expectation: expectationIndex,
        },
        attribution,
        attributionReason,
      });
      await writer.commit(summary);
      return { summary: canonicalSummary(summary), generationStats: stats };
    } catch (e) {
      await writer.abort();
      throw e;
    }
  }

  /** 读取摘要 + 首屏明细（首屏来自分页存储的第 0 页，≤ 500 条） */
  private async attachFirstPages(summary: RegressionReportSummary): Promise<RegressionReport> {
    const reportId = summary.reportId;
    const page = await this.store.getReportChangePage(reportId, 'record', 0);
    const expectation = await this.store.getReportExpectationPage(reportId, 0);
    const sourcePage = summary.streams.source ? await this.store.getReportChangePage(reportId, 'source', 0) : undefined;
    const rulePage = summary.streams.rule ? await this.store.getReportChangePage(reportId, 'rule', 0) : undefined;
    return {
      ...summary,
      recordChanges: page?.changes ?? [],
      sourceChanges: sourcePage?.changes,
      ruleChanges: rulePage?.changes,
      expectationMismatches: expectation?.mismatches ?? [],
    };
  }

  /** 按页读取报告变化明细（单页 ≤ 500 条） */
  async changePage(reportId: string, stream: ChangeStream, page: number): Promise<ChangePage> {
    const p = await this.store.getReportChangePage(reportId, stream, page);
    if (!p) throw new Error(`报告或变化流不存在: ${reportId}/${stream}`);
    return p;
  }

  /** 按页读取期望失配 */
  async expectationPage(reportId: string, page: number): Promise<ExpectationPage> {
    const p = await this.store.getReportExpectationPage(reportId, page);
    if (!p) throw new Error(`报告不存在: ${reportId}`);
    return p;
  }

  /** 对全部夹具重放并只返回摘要（发布闸门、列表接口使用；不加载明细） */
  async replayAllSummaries(candidate: RuleDocument, sourceId?: string): Promise<RegressionReportSummary[]> {
    const fixtures = await this.store.listFixtures();
    const reports: RegressionReportSummary[] = [];
    for (const f of fixtures) {
      if (sourceId && f.sourceId !== sourceId) continue;
      reports.push(await this.replaySummary(f.fixtureId, candidate));
    }
    return reports;
  }
}

/** 记录级计数：每条记录只在其首个片段上计一次 */
function countRecordLevel(
  counts: ChangeCounts,
  part: RecordChangePart,
  expectedBroken: Set<string>,
): void {
  if (part.kind === 'added') counts.recordsAdded += 1;
  if (part.kind === 'removed') counts.recordsRemoved += 1;
  if (part.identity.startsWith('__broken_identity__') && !expectedBroken.has(part.identity)) {
    counts.unexpectedBrokenRecords += 1;
  }
}

/** 字段级计数：每个片段恰好一条字段变化 */
function countFieldLevel(counts: ChangeCounts, part: RecordChangePart): void {
  const fc = part.fieldChange;
  if (!fc) return;
  counts.fieldsChanged += 1;
  if (fc.kind === 'type_incompatible') counts.typeIncompatibilities += 1;
  if (fc.kind === 'new_failure') counts.failures += 1;
}
