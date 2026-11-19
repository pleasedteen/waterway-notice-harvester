/**
 * 回归报告分页验收：
 *  - 一万条变化的离线夹具，生成时内存缓冲峰值 ≤ 500 条变化明细；
 *  - 全量计数与发布门禁结论不受分页影响；
 *  - 读取汇总加载 0 条明细，读取单页最多加载 500 条；
 *  - 重启（新存储实例/新服务实例）后翻页结果逐条一致；
 *  - 旧格式（明细内联）报告仍可查询与翻页；
 *  - 网页/接口只按页查看变化与证据。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedStore } from '../src/storage/embedded-store.js';
import { RegressionService } from '../src/service/regression-service.js';
import { PublishService } from '../src/service/publish-service.js';
import { createApp } from '../src/service/app.js';
import { createHttpServer } from '../src/server/http.js';
import { MockFetcher, createMockState } from '../src/mock/site.js';
import { REPORT_MEMORY_BUFFER_LIMIT, REPORT_PAGE_SIZE } from '../src/core/report-paging.js';
import { buildBulkFixture, buildWideRecordFixture, wideRule, BULK_RULE } from './fixtures/bulk-fixture.js';
import type {
  BusinessRecord,
  ChangePage,
  ChangeStream,
  RegressionFixture,
  RegressionReportSummary,
  RuleDocument,
  Store,
} from '../src/core/types.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const SIZE = 10000;
let dataDir: string;
let store: EmbeddedStore;
let fixtureId: string;

/** 统计"读取时报文里带回多少条变化明细"的包装存储 */
class CountingStore implements Store {
  loadedChangeDetails = 0;
  loadedExpectationDetails = 0;
  constructor(private readonly inner: Store) {}

  getReportChangePage(reportId: string, stream: ChangeStream, page: number): Promise<ChangePage | null> {
    return this.inner.getReportChangePage(reportId, stream, page).then((p) => {
      this.loadedChangeDetails += p?.changes.length ?? 0;
      return p;
    });
  }
  getReportExpectationPage(reportId: string, page: number) {
    return this.inner.getReportExpectationPage(reportId, page).then((p) => {
      this.loadedExpectationDetails += p?.mismatches.length ?? 0;
      return p;
    });
  }
  reset(): void {
    this.loadedChangeDetails = 0;
    this.loadedExpectationDetails = 0;
  }
  // 其余方法透传
  init = () => this.inner.init();
  close = () => this.inner.close();
  saveRule = (r: Parameters<Store['saveRule']>[0]) => this.inner.saveRule(r);
  getRule = (a: string, b: string) => this.inner.getRule(a, b);
  listRules = (a?: string) => this.inner.listRules(a);
  saveSnapshot = (s: Parameters<Store['saveSnapshot']>[0]) => this.inner.saveSnapshot(s);
  getSnapshot = (id: string) => this.inner.getSnapshot(id);
  listSnapshots = (s?: string) => this.inner.listSnapshots(s);
  saveFixture = (f: Parameters<Store['saveFixture']>[0]) => this.inner.saveFixture(f);
  getFixture = (id: string) => this.inner.getFixture(id);
  listFixtures = () => this.inner.listFixtures();
  saveJob = (j: Parameters<Store['saveJob']>[0]) => this.inner.saveJob(j);
  getJob = (id: string) => this.inner.getJob(id);
  listJobs = () => this.inner.listJobs();
  saveRegressionReport = (r: Parameters<Store['saveRegressionReport']>[0]) => this.inner.saveRegressionReport(r);
  createRegressionReportWriter = (id: string) => this.inner.createRegressionReportWriter(id);
  getRegressionReport = (id: string) => this.inner.getRegressionReport(id);
  listRegressionReports = () => this.inner.listRegressionReports();
  commitPublication = (p: Parameters<Store['commitPublication']>[0]) => this.inner.commitPublication(p);
  getCurrentPublication = (s: string) => this.inner.getCurrentPublication(s);
  getPublication = (id: string) => this.inner.getPublication(id);
  listPublications = (s?: string) => this.inner.listPublications(s);
  saveSource = (s: Parameters<Store['saveSource']>[0]) => this.inner.saveSource(s);
  getSource = (id: string) => this.inner.getSource(id);
  listSources = () => this.inner.listSources();
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'collector-page-test-'));
  store = new EmbeddedStore(dataDir);
  await store.init();
  await store.saveRule(BULK_RULE);
  const data = buildBulkFixture({ size: SIZE });
  for (const s of data.snapshots) await store.saveSnapshot(s);
  await store.saveFixture({ ...data.fixture, createdAt: new Date().toISOString() });
  fixtureId = data.fixture.fixtureId;
});

after(async () => {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('一万条变化：生成时内存只缓冲一页，汇总计数全量且结论正确', async () => {
  const svc = new RegressionService(store);
  const { summary, generationStats } = await svc.replayWithStats(fixtureId, BULK_RULE);

  assert.equal(summary.fieldsChanged, SIZE, '全量字段变化计数不因分页丢失');
  assert.equal(summary.recordsAdded, 0);
  assert.equal(summary.recordsRemoved, 0);
  assert.equal(summary.expectationMismatchCount, SIZE);
  assert.equal(summary.streams.record.total, SIZE);
  assert.equal(summary.streams.record.pages, SIZE / REPORT_PAGE_SIZE);
  assert.equal(summary.streams.record.pageSize, REPORT_PAGE_SIZE);
  assert.equal(summary.expectationMatches, false);
  // 结论来自全量：期望失配 => 不通过
  assert.equal(summary.passed, false);

  assert.ok(
    generationStats.peakBufferedChanges <= REPORT_MEMORY_BUFFER_LIMIT,
    `生成时内存缓冲峰值 ${generationStats.peakBufferedChanges} 应 ≤ ${REPORT_MEMORY_BUFFER_LIMIT}`,
  );
  assert.equal(generationStats.changesWritten, SIZE);
  assert.equal(generationStats.pagesWritten, SIZE / REPORT_PAGE_SIZE);
  // 返回的摘要对象本身不含任何变化明细数组
  assert.equal((summary as unknown as { recordChanges?: unknown }).recordChanges, undefined);
});

test('读取汇总加载 0 条明细，读取单页最多加载 500 条', async () => {
  const svc = new RegressionService(store);
  const summaries = await svc.replayAllSummaries(BULK_RULE);
  const target = summaries.find((s) => s.fixtureId === fixtureId)!;
  const counting = new CountingStore(store);

  // 汇总读取：列表 + 单条，均为 0 条明细
  counting.reset();
  const listed = await counting.listRegressionReports();
  const one = await counting.getRegressionReport(target.reportId);
  assert.ok(listed.some((s) => s.reportId === target.reportId));
  assert.equal(one?.fieldsChanged, SIZE);
  assert.equal(counting.loadedChangeDetails, 0);
  assert.equal(counting.loadedExpectationDetails, 0);
  for (const s of listed) {
    assert.equal((s as unknown as { recordChanges?: unknown }).recordChanges, undefined);
    assert.equal((s as unknown as { sourceChanges?: unknown }).sourceChanges, undefined);
    assert.equal((s as unknown as { expectationMismatches?: unknown }).expectationMismatches, undefined);
  }

  // 单页读取：整页恰好 500 条；越界页 0 条
  counting.reset();
  const page = await counting.getReportChangePage(target.reportId, 'record', 0);
  assert.equal(page!.changes.length, REPORT_PAGE_SIZE);
  assert.equal(page!.total, SIZE);
  assert.equal(page!.pages, SIZE / REPORT_PAGE_SIZE);
  assert.ok(counting.loadedChangeDetails <= REPORT_PAGE_SIZE);
  const last = await counting.getReportChangePage(target.reportId, 'record', page!.pages - 1);
  assert.equal(last!.changes.length, REPORT_PAGE_SIZE);
  const beyond = await counting.getReportChangePage(target.reportId, 'record', page!.pages);
  assert.equal(beyond!.changes.length, 0);
  assert.ok(counting.loadedChangeDetails <= REPORT_PAGE_SIZE * 2);

  // 每一页都带证据定位
  const first = page!.changes[0]!;
  assert.equal(first.identity, 'noticeNo=B-000000');
  assert.equal(first.kind, 'changed');
  assert.equal(first.fieldChanges.length, 1);
  assert.equal(first.fieldChanges[0]!.kind, 'value_changed');
  assert.equal(first.fieldChanges[0]!.before!.value, 10000);
  assert.equal(first.fieldChanges[0]!.after!.value, 20000);
});

test('重启后翻页结果一致', async () => {
  const svc = new RegressionService(store);
  const summary = (await svc.replayAllSummaries(BULK_RULE)).find((s) => s.fixtureId === fixtureId)!;
  const pagesBefore: ChangePage[] = [];
  for (let p = 0; p < summary.streams.record.pages; p += 1) {
    pagesBefore.push((await store.getReportChangePage(summary.reportId, 'record', p))!);
  }

  // 模拟进程重启：全新存储实例 + 全新服务实例，仅靠磁盘读取同一份报告
  const rebootStore = new EmbeddedStore(dataDir);
  await rebootStore.init();
  const rebooted = await rebootStore.getRegressionReport(summary.reportId);
  assert.ok(rebooted, '重启后仍能按 id 读取报告摘要');
  assert.deepEqual(rebooted, summary, '重启后摘要逐字段一致');
  for (let p = 0; p < summary.streams.record.pages; p += 1) {
    const page = (await rebootStore.getReportChangePage(summary.reportId, 'record', p))!;
    assert.deepEqual(page, pagesBefore[p], `第 ${p} 页重启前后逐条一致`);
  }
  const expectations = (await rebootStore.getReportExpectationPage(summary.reportId, 0))!;
  assert.equal(expectations.mismatches.length, REPORT_PAGE_SIZE);

  // 重启后再重放得到的新报告，翻页结果与逐条内容与旧报告相同结构
  const rerun = await new RegressionService(rebootStore).replayWithStats(fixtureId, BULK_RULE);
  assert.deepEqual(rerun.summary.streams.record, summary.streams.record);
  const rerunFirst = (await rebootStore.getReportChangePage(rerun.summary.reportId, 'record', 0))!;
  assert.deepEqual(rerunFirst.changes, pagesBefore[0]!.changes);
  await rebootStore.close();
});

test('旧格式报告（明细内联）仍可查询与翻页', async () => {
  const legacyDir = await mkdtemp(join(tmpdir(), 'collector-legacy-'));
  const legacyStore = new EmbeddedStore(legacyDir);
  await legacyStore.init();
  const legacyChanges = Array.from({ length: 620 }, (_, i) => ({
    identity: `noticeNo=L-${i}`,
    kind: 'changed' as const,
    fieldChanges: [
      {
        kind: 'value_changed' as const,
        recordIdentity: `noticeNo=L-${i}`,
        field: 'limit',
        before: { status: 'ok' as const, value: 1000, unit: 'kg' },
        after: { status: 'ok' as const, value: 2000, unit: 'kg' },
        evidence: [{ url: `http://old.local/${i}`, selector: '#limit', text: '20 吨', page: 1, row: null, col: null }],
      },
    ],
    pagesMergedBefore: [1],
    pagesMergedAfter: [1],
  }));
  const legacyDoc = {
    reportId: 'report_legacy_1',
    fixtureId: 'fixture-old',
    ruleId: 'rule-old',
    ruleVersion: '0.9.0',
    ranAt: '2026-10-01T00:00:00.000Z',
    passed: false,
    recordChanges: legacyChanges,
    recordsAdded: 0,
    recordsRemoved: 0,
    fieldsChanged: 620,
    typeIncompatibilities: 0,
    failures: 0,
    expectationMatches: true,
    expectationMismatches: ['旧报告期望失配 1', '旧报告期望失配 2'],
  };
  await mkdir(join(legacyDir, 'reports'), { recursive: true });
  await writeFile(join(legacyDir, 'reports', 'report_legacy_1.json'), JSON.stringify(legacyDoc), 'utf8');

  const summary = await legacyStore.getRegressionReport('report_legacy_1');
  assert.ok(summary, '旧报告仍可读取');
  assert.equal(summary!.fieldsChanged, 620);
  assert.equal(summary!.streams.record.total, 620);
  assert.equal(summary!.streams.record.pages, 2);
  assert.equal(summary!.expectationMismatchCount, 2);
  assert.equal((summary as unknown as { recordChanges?: unknown }).recordChanges, undefined, '摘要不携带明细分页');

  const page0 = await legacyStore.getReportChangePage('report_legacy_1', 'record', 0);
  assert.equal(page0!.changes.length, REPORT_PAGE_SIZE);
  const page1 = await legacyStore.getReportChangePage('report_legacy_1', 'record', 1);
  assert.equal(page1!.changes.length, 120);
  const exp = await legacyStore.getReportExpectationPage('report_legacy_1', 0);
  assert.deepEqual(exp!.mismatches, ['旧报告期望失配 1', '旧报告期望失配 2']);
  const listed = await legacyStore.listRegressionReports();
  assert.equal(listed.length, 1);
  await legacyStore.close();
  await rm(legacyDir, { recursive: true, force: true });
});

test('单条记录的超多字段变化按页切片，单页仍 ≤ 500 且计数不重复', async () => {
  const fieldCount = 1234;
  const data = buildWideRecordFixture(fieldCount);
  const rule = wideRule(fieldCount);
  const wideDir = await mkdtemp(join(tmpdir(), 'collector-wide-'));
  const wideStore = new EmbeddedStore(wideDir);
  await wideStore.init();
  await wideStore.saveRule(rule);
  for (const s of data.snapshots) await wideStore.saveSnapshot(s);
  await wideStore.saveFixture(data.fixture);

  const svc = new RegressionService(wideStore);
  const { summary, generationStats } = await svc.replayWithStats(data.fixture.fixtureId, rule);
  assert.equal(summary.fieldsChanged, fieldCount);
  assert.equal(summary.streams.record.total, Math.ceil(fieldCount / REPORT_PAGE_SIZE), '一条记录切成多页');
  assert.equal(summary.streams.record.records, 1, '记录级计数只算一次');
  assert.equal(summary.recordsAdded, 0);
  assert.equal(summary.recordsRemoved, 0);
  assert.ok(generationStats.peakBufferedChanges <= REPORT_MEMORY_BUFFER_LIMIT);

  const seenFields = new Set<string>();
  let total = 0;
  for (let p = 0; p < summary.streams.record.pages; p += 1) {
    const page = (await wideStore.getReportChangePage(summary.reportId, 'record', p))!;
    assert.ok(page.changes.length <= 1, '一条记录的分片每页最多一条记录变化');
    for (const change of page.changes) {
      total += change.fieldChanges.length;
      for (const fc of change.fieldChanges) seenFields.add(fc.field);
    }
  }
  assert.equal(total, fieldCount, '所有片段字段变化数之和等于全量');
  assert.equal(seenFields.size, fieldCount, '字段不重不漏');
  await wideStore.close();
  await rm(wideDir, { recursive: true, force: true });
});

test('同一报告 id 重写更小的报告不会残留旧页', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-rewrite-'));
  const s = new EmbeddedStore(dir);
  await s.init();
  const summary = (count: number) => ({
    reportId: 'report_reuse',
    fixtureId: 'fx',
    ruleId: 'r',
    ruleVersion: '1',
    ranAt: '2026-11-01T00:00:00.000Z',
    passed: true,
    recordsAdded: 0,
    recordsRemoved: 0,
    fieldsChanged: count,
    typeIncompatibilities: 0,
    failures: 0,
    expectationMatches: true,
    expectationMismatchCount: 0,
    streams: {
      record: { total: count, records: count, pages: Math.ceil(count / REPORT_PAGE_SIZE), pageSize: REPORT_PAGE_SIZE },
      expectation: { total: 0, records: 0, pages: 0, pageSize: REPORT_PAGE_SIZE },
    },
  });
  const change = (i: number) => ({
    identity: `id-${i}`,
    kind: 'changed' as const,
    fieldChanges: [
      {
        kind: 'value_changed' as const,
        recordIdentity: `id-${i}`,
        field: 'f',
        before: { status: 'ok' as const, value: 1, unit: null },
        after: { status: 'ok' as const, value: 2, unit: null },
        evidence: [],
      },
    ],
    pagesMergedBefore: [1],
    pagesMergedAfter: [1],
  });

  // 写入 1200 条（3 页）
  let writer = s.createRegressionReportWriter('report_reuse');
  for (let p = 0; p < 3; p += 1) {
    await writer.writeChangePage('record', p, REPORT_PAGE_SIZE, Array.from({ length: 500 }, (_, i) => change(p * 500 + i)));
  }
  await writer.commit(summary(1500));
  assert.equal((await s.getReportChangePage('report_reuse', 'record', 2))!.changes.length, 500);

  // 复用同一 id 写 500 条（1 页）
  writer = s.createRegressionReportWriter('report_reuse');
  await writer.writeChangePage('record', 0, REPORT_PAGE_SIZE, Array.from({ length: 500 }, (_, i) => change(i)));
  await writer.commit(summary(500));
  const p1 = await s.getReportChangePage('report_reuse', 'record', 1);
  assert.equal(p1!.pages, 1);
  assert.equal(p1!.changes.length, 0, '旧的第 2 页已被清理');
  await s.close();
  await rm(dir, { recursive: true, force: true });
});

test('多记录各自多字段变化：分页不丢条目、不重复计数', async () => {
  const records = 1200;
  const fieldsPer = 3;
  const dir = await mkdtemp(join(tmpdir(), 'collector-multi-'));
  const s = new EmbeddedStore(dir);
  await s.init();
  const rule: RuleDocument = {
    ruleId: 'rule-multi',
    version: '1',
    name: 'multi',
    createdAt: '2026-11-01T00:00:00.000Z',
    identity: ['no'],
    fields: [
      { field: 'no', type: 'string', selector: '#no' },
      ...Array.from({ length: fieldsPer }, (_, i) => ({ field: `f${i}`, type: 'string' as const, selector: `.f${i}` })),
    ],
  };
  await s.saveRule(rule);
  const entries: RegressionFixture['entries'] = [];
  const expectedRecords: BusinessRecord[] = [];
  for (let i = 0; i < records; i += 1) {
    const no = `M-${i}`;
    const url = `http://m.local/${no}`;
    entries.push({ entryUrl: url, snapshotIds: [`snap_${i}`], urls: [url] });
    await s.saveSnapshot({
      snapshotId: `snap_${i}`,
      sourceId: 's',
      revision: 'r',
      url,
      fetchedAt: '',
      statusCode: 200,
      contentType: 'text/html',
      html: `<html><body><span id="no">${no}</span>${Array.from({ length: fieldsPer }, (_, k) => `<span class="f${k}">new</span>`).join('')}</body></html>`,
    });
    const fields: BusinessRecord['fields'] = { no: { field: 'no', value: { status: 'ok', value: no, unit: null }, evidence: [] } };
    for (let k = 0; k < fieldsPer; k += 1) fields[`f${k}`] = { field: `f${k}`, value: { status: 'ok', value: 'old', unit: null }, evidence: [] };
    expectedRecords.push({ identity: `no=${no}`, identityParts: { no }, fields, nested: {}, pagesMerged: [1] });
  }
  await s.saveFixture({ fixtureId: 'multi', name: 'multi', sourceId: 's', listSnapshotIds: [], entries, expectedRevision: 'r', expectedRecords, createdAt: '2026-11-01T00:00:00.000Z' });

  const { summary, generationStats } = await new RegressionService(s).replayWithStats('multi', rule);
  assert.equal(summary.fieldsChanged, records * fieldsPer);
  assert.equal(summary.streams.record.records, records);
  assert.ok(generationStats.peakBufferedChanges <= REPORT_MEMORY_BUFFER_LIMIT, `peak ${generationStats.peakBufferedChanges}`);
  let identities = 0;
  let fieldsSeen = 0;
  for (let p = 0; p < summary.streams.record.pages; p += 1) {
    const page = (await s.getReportChangePage(summary.reportId, 'record', p))!;
    assert.ok(page.changes.length <= REPORT_PAGE_SIZE);
    for (const c of page.changes) {
      identities += 1;
      fieldsSeen += c.fieldChanges.length;
      assert.equal(new Set(c.fieldChanges.map((f) => f.field)).size, c.fieldChanges.length, '同一记录字段不重复');
    }
  }
  assert.equal(identities, records, '记录数不丢不重');
  assert.equal(fieldsSeen, records * fieldsPer, '字段变化数不丢不重');
  await s.close();
  await rm(dir, { recursive: true, force: true });
});

test('生成中断不留半份报告：abort / 未提交的明细页都不可见', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-atomic-'));
  const s = new EmbeddedStore(dir);
  await s.init();
  const change = {
    identity: 'x',
    kind: 'changed' as const,
    fieldChanges: [],
    pagesMergedBefore: [1],
    pagesMergedAfter: [1],
  };
  const aborted = s.createRegressionReportWriter('report_abort');
  await aborted.writeChangePage('record', 0, REPORT_PAGE_SIZE, [change]);
  await aborted.abort();
  assert.equal(await s.getRegressionReport('report_abort'), null);
  assert.equal(await s.getReportChangePage('report_abort', 'record', 0), null);

  // 只写了明细页、摘要未提交（等价于提交前崩溃）：整份报告不可见
  const crashed = s.createRegressionReportWriter('report_crash');
  await crashed.writeChangePage('record', 0, REPORT_PAGE_SIZE, [change]);
  assert.equal(await s.getRegressionReport('report_crash'), null);
  assert.equal(await s.getReportChangePage('report_crash', 'record', 0), null);
  assert.equal((await s.listRegressionReports()).length, 0);
  await s.close();
  await rm(dir, { recursive: true, force: true });
});

test('发布门禁只读摘要：全量失败计数驱动结论，不加载明细', async () => {
  const counting = new CountingStore(store);
  const app = await createApp({
    dataDir,
    store: counting,
    fetcher: new MockFetcher(createMockState()),
  });
  const decision = await new PublishService(counting).evaluate('不存在的作业', BULK_RULE);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasons[0], '作业不存在: 不存在的作业');
  assert.equal(counting.loadedChangeDetails, 0);

  // 直接评估回归门禁：退化结论来自全量（一万条期望失配）
  const summaries = await app.regression.replayAllSummaries(BULK_RULE);
  const target = summaries.find((s) => s.fixtureId === fixtureId)!;
  assert.equal(target.passed, false);
  assert.equal(target.expectationMismatchCount, SIZE);
  assert.equal((target as unknown as { recordChanges?: unknown }).recordChanges, undefined);
});

test('网页/接口：汇总不含明细，按页读取变化与证据', async () => {
  const app = await createApp({
    dataDir,
    store,
    fetcher: new MockFetcher(createMockState()),
  });
  const server: Server = createHttpServer(app, { port: 0, mockState: createMockState() });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const summaries = (await (await fetch(`${base}/api/reports`)).json()) as RegressionReportSummary[];
    const target = summaries.find((s) => s.fixtureId === fixtureId)!;
    assert.ok(target);
    assert.equal(target.fieldsChanged, SIZE);
    assert.equal((target as unknown as { recordChanges?: unknown }).recordChanges, undefined);

    const one = (await (await fetch(`${base}/api/reports/${target.reportId}`)).json()) as RegressionReportSummary;
    assert.equal(one.streams.record.pages, SIZE / REPORT_PAGE_SIZE);
    assert.equal((one as unknown as { recordChanges?: unknown }).recordChanges, undefined);

    const summaryResp = await (
      await fetch(`${base}/api/reports/${target.reportId}/summary`)
    ).json() as { preview: { recordChanges: unknown[] } };
    assert.ok(summaryResp.preview.recordChanges.length <= REPORT_PAGE_SIZE);

    const pageResp = (await (
      await fetch(`${base}/api/reports/${target.reportId}/changes/record?page=7`)
    ).json()) as ChangePage;
    assert.equal(pageResp.page, 7);
    assert.equal(pageResp.pageSize, REPORT_PAGE_SIZE);
    assert.equal(pageResp.changes.length, REPORT_PAGE_SIZE);
    assert.equal(pageResp.changes[0]!.identity, `noticeNo=B-${String(7 * REPORT_PAGE_SIZE).padStart(6, '0')}`);
    assert.ok(pageResp.changes[0]!.fieldChanges[0]!.evidence.length > 0, '变化携带原始网页证据');

    const beyond = (await (
      await fetch(`${base}/api/reports/${target.reportId}/changes/record?page=999`)
    ).json()) as ChangePage;
    assert.equal(beyond.changes.length, 0);

    const bad = await fetch(`${base}/api/reports/${target.reportId}/changes/nope?page=0`);
    assert.equal(bad.status, 400);

    const exp = (await (
      await fetch(`${base}/api/reports/${target.reportId}/expectations?page=0`)
    ).json()) as { total: number; mismatches: string[] };
    assert.equal(exp.total, SIZE);
    assert.equal(exp.mismatches.length, REPORT_PAGE_SIZE);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
