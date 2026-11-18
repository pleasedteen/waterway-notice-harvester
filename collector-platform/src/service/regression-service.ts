/**
 * 回归服务：
 * - 建立带期望结果的夹具（快照永久离线保存，按条目分组、支持续页）；
 * - 候选规则重放历史快照，输出新增/删除/字段变化/类型不兼容/失败及证据；
 * - 网站与规则同时变化时做四象限归因，证据不足 => undeterminable。
 */
import { extractFromSnapshots } from '../core/extractor.js';
import {
  attributeChanges,
  buildRegressionReport,
  compareExpectations,
  diffRecords,
} from '../core/regression.js';
import { newId, nowIso } from '../core/ids.js';
import type {
  BusinessRecord,
  FixtureEntry,
  RegressionFixture,
  RegressionReport,
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

  /** 重放：候选规则 vs 夹具期望；若夹具带基线，则同时产出 diff 与双变归因 */
  async replay(fixtureId: string, candidate: RuleDocument): Promise<RegressionReport> {
    const fixture = await this.store.getFixture(fixtureId);
    if (!fixture) throw new Error(`夹具不存在: ${fixtureId}`);

    const actualRecords = (await this.replayEntries(fixture.entries, candidate)).sort((a, b) =>
      a.identity.localeCompare(b.identity),
    );
    const expectedRecords = [...fixture.expectedRecords].sort((a, b) => a.identity.localeCompare(b.identity));

    const recordChanges = diffRecords(expectedRecords, actualRecords);
    const expectationMismatches = compareExpectations(expectedRecords, actualRecords);
    const expectedBroken = new Set(
      fixture.expectedRecords.filter((r) => r.recordError !== undefined).map((r) => r.identity),
    );

    let attribution: RegressionReport['attribution'];
    let attributionReason: string | undefined;
    let sourceChanges: RegressionReport['sourceChanges'];
    let ruleChanges: RegressionReport['ruleChanges'];

    if (fixture.baselineEntries?.length && fixture.baselineRuleId && fixture.baselineRuleVersion) {
      const baselineRule = await this.store.getRule(fixture.baselineRuleId, fixture.baselineRuleVersion);
      if (!baselineRule) throw new Error('基线规则缺失，无法归因');
      const baseline = await this.replayEntries(fixture.baselineEntries, baselineRule);
      const oldSnapshotNewRule = await this.replayEntries(fixture.baselineEntries, candidate);
      const r = attributeChanges({
        baseline,
        oldSnapshotNewRule,
        newSnapshotNewRule: actualRecords,
        expectedBrokenIdentities: expectedBroken,
      });
      attribution = r.attribution;
      attributionReason = r.reason;
      sourceChanges = r.sourceChanges;
      ruleChanges = r.ruleChanges;
    }

    const report = buildRegressionReport({
      reportId: newId('report'),
      fixtureId,
      ruleId: candidate.ruleId,
      ruleVersion: candidate.version,
      recordChanges,
      expectationMismatches,
      attribution,
      attributionReason,
      sourceChanges,
      ruleChanges,
      expectedBrokenIdentities: expectedBroken,
    });
    await this.store.saveRegressionReport(report);
    return report;
  }

  /** 对全部夹具重放，返回汇总（发布闸门使用） */
  async replayAll(candidate: RuleDocument, sourceId?: string): Promise<RegressionReport[]> {
    const fixtures = await this.store.listFixtures();
    const reports: RegressionReport[] = [];
    for (const f of fixtures) {
      if (sourceId && f.sourceId !== sourceId) continue;
      reports.push(await this.replay(f.fixtureId, candidate));
    }
    return reports;
  }
}
