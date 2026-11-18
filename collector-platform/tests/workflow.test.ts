/**
 * 工作流集成测试：回归重放/归因、断点续跑、换版阻断、分页失败恢复、发布闸门。
 * 全程内存模拟站点 + 嵌入式文件存储，无外部进程。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedStore } from '../src/storage/embedded-store.js';
import { CrawlService } from '../src/service/crawl-service.js';
import { RegressionService } from '../src/service/regression-service.js';
import { PublishService } from '../src/service/publish-service.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../src/mock/site.js';
import { RULE_V1, RULE_V2, RULE_REGRESSED } from '../src/core/rule-catalog.js';
import {
  goldenNoticeA, goldenNoticeB, goldenNoticeC, goldenNoticeD, goldenNoticeBad, goldenNoticeA_v2,
} from '../src/core/golden.js';
import type { BusinessRecord, RuleDocument, Snapshot, Store } from '../src/core/types.js';

let dataDir: string;
let store: Store;
let regression: RegressionService;
const strip = (r: BusinessRecord): BusinessRecord => {
  const c: BusinessRecord = JSON.parse(JSON.stringify(r)) as BusinessRecord;
  delete c.fields.listNoticeNo;
  delete c.fields.listTitle;
  return c;
};

async function snap(url: string, edition: 'v1' | 'v2' = 'v1', tag = ''): Promise<Snapshot> {
  const st = createMockState();
  st.edition = edition;
  const p = await new MockFetcher(st).fetch(url);
  return {
    snapshotId: `w_${edition}_${tag}_${Buffer.from(url).toString('base64url')}`,
    sourceId: 'mock-source', revision: p.revision, url: p.url,
    fetchedAt: new Date().toISOString(), statusCode: p.statusCode,
    contentType: p.contentType, html: p.html,
  };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'collector-test-'));
  store = new EmbeddedStore(dataDir);
  await store.init();
  for (const r of [RULE_V1, RULE_V2, RULE_REGRESSED]) await store.saveRule(r);
  regression = new RegressionService(store);
});

after(async () => {
  await store.close();
  await rm(dataDir, { recursive: true, force: true });
});

test('回归：正常规则通过，退化规则失败并带证据', async () => {
  const entries = [
    { entryUrl: MOCK_URLS.detailA1, snapshots: [await snap(MOCK_URLS.detailA1, 'v1', 'a'), await snap(MOCK_URLS.detailA2, 'v1', 'a')] },
    { entryUrl: MOCK_URLS.detailB, snapshots: [await snap(MOCK_URLS.detailB, 'v1', 'b')] },
    { entryUrl: MOCK_URLS.detailC, snapshots: [await snap(MOCK_URLS.detailC, 'v1', 'c')] },
    { entryUrl: MOCK_URLS.detailD, snapshots: [await snap(MOCK_URLS.detailD, 'v1', 'd')] },
    { entryUrl: MOCK_URLS.detailBad, snapshots: [await snap(MOCK_URLS.detailBad, 'v1', 'e')] },
  ];
  const fx = await regression.createFixture({
    fixtureId: 'fx-test-v1', name: '测试夹具', sourceId: 'mock-source', entries,
    expectedRecords: [goldenNoticeA(), goldenNoticeB(), goldenNoticeC(), goldenNoticeD(), goldenNoticeBad()].map(strip),
  });
  const ok = await regression.replay(fx.fixtureId, RULE_V1);
  assert.equal(ok.passed, true);
  assert.equal(ok.expectationMismatches.length, 0);

  const bad = await regression.replay(fx.fixtureId, RULE_REGRESSED);
  assert.equal(bad.passed, false);
  assert.ok(bad.failures > 0);
  assert.ok(bad.recordChanges.some((r) => r.fieldChanges.some((c) => c.evidence.length > 0)));
});

test('归因：来源变化 / 两者同变 / 无法判定', async () => {
  const v1 = [
    { entryUrl: MOCK_URLS.detailA1, snapshots: [await snap(MOCK_URLS.detailA1, 'v1', 'g1'), await snap(MOCK_URLS.detailA2, 'v1', 'g1')] },
    { entryUrl: MOCK_URLS.detailB, snapshots: [await snap(MOCK_URLS.detailB, 'v1', 'g2')] },
    { entryUrl: MOCK_URLS.detailC, snapshots: [await snap(MOCK_URLS.detailC, 'v1', 'g3')] },
    { entryUrl: MOCK_URLS.detailD, snapshots: [await snap(MOCK_URLS.detailD, 'v1', 'g4')] },
    { entryUrl: MOCK_URLS.detailBad, snapshots: [await snap(MOCK_URLS.detailBad, 'v1', 'g5')] },
  ];
  const v2 = [
    { entryUrl: MOCK_URLS.detailA1, snapshots: [await snap(MOCK_URLS.detailA1, 'v2', 'g1'), await snap(MOCK_URLS.detailA2, 'v2', 'g1')] },
    { entryUrl: MOCK_URLS.detailB, snapshots: [await snap(MOCK_URLS.detailB, 'v2', 'g2')] },
    { entryUrl: MOCK_URLS.detailC, snapshots: [await snap(MOCK_URLS.detailC, 'v2', 'g3')] },
    { entryUrl: MOCK_URLS.detailD, snapshots: [await snap(MOCK_URLS.detailD, 'v2', 'g4')] },
    { entryUrl: MOCK_URLS.detailBad, snapshots: [await snap(MOCK_URLS.detailBad, 'v2', 'g5')] },
  ];
  const fx2 = await regression.createFixture({
    fixtureId: 'fx-test-v2', name: '归因夹具', sourceId: 'mock-source',
    entries: v2,
    expectedRecords: [goldenNoticeA_v2(), goldenNoticeB(), goldenNoticeC(), goldenNoticeD(), goldenNoticeBad()].map(strip),
    baselineEntries: v1, baselineRule: RULE_V1,
  });

  const sourceOnly = await regression.replay(fx2.fixtureId, RULE_V1);
  assert.equal(sourceOnly.attribution, 'source_change');
  const w = sourceOnly.sourceChanges!.flatMap((r) => r.fieldChanges).find((c) => c.field === 'weightLimit');
  assert.equal(w?.before?.value, 30000);
  assert.equal(w?.after?.value, 28000);

  const evolved: RuleDocument = {
    ...RULE_V1, version: 'test-evolved', createdAt: new Date().toISOString(),
    fields: [...RULE_V1.fields, { field: 'docTitle', type: 'string', selector: 'h1.title' }],
  };
  await store.saveRule(evolved);
  const both = await regression.replay(fx2.fixtureId, evolved);
  assert.equal(both.attribution, 'both');
  assert.ok(both.ruleChanges && both.ruleChanges.some((r) => r.kind !== 'unchanged'));

  const undet = await regression.replay(fx2.fixtureId, RULE_REGRESSED);
  assert.equal(undet.attribution, 'undeterminable');
});

test('采集：中断后新实例靠检查点续跑完成', async () => {
  const crawl = new CrawlService(store, new MockFetcher(createMockState()));
  const job = await crawl.startOrResume({ sourceId: 'src-resume', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  await crawl.run(job.jobId, { maxEntriesPerCall: 1 });
  const mid = await store.getJob(job.jobId);
  assert.equal(mid?.entries.filter((e) => e.status === 'done').length, 1);

  // 模拟重启：新服务实例 + 新抓取器
  const reboot = new CrawlService(new EmbeddedStore(dataDir), new MockFetcher(createMockState()));
  const same = await reboot.startOrResume({ sourceId: 'src-resume', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  assert.equal(same.jobId, job.jobId);
  const done = await reboot.run(same.jobId);
  assert.equal(done.status, 'completed');
  assert.equal(done.entries.length, 5);
});

test('换版：采集中检测到修订变化，作业阻断且禁止发布', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-switch-test-'));
  const s2 = new EmbeddedStore(dir);
  await s2.init();
  await s2.saveRule(RULE_V1);
  const st = createMockState();
  st.switchAfter = 3;
  const c = new CrawlService(s2, new MockFetcher(st));
  const job = await c.startOrResume({ sourceId: 'src-switch-t', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  const r = await c.run(job.jobId);
  assert.equal(r.status, 'edition_changed');
  const decision = await new PublishService(s2).evaluate(job.jobId, RULE_V1);
  assert.equal(decision.allowed, false);
  await s2.close();
  await rm(dir, { recursive: true, force: true });
});

test('分页失败：批次不完整；故障消除后续跑成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-fault-test-'));
  const s3 = new EmbeddedStore(dir);
  await s3.init();
  await s3.saveRule(RULE_V1);
  const st = createMockState();
  st.faults.set('G2026-018?page=2', 'error');
  const c1 = new CrawlService(s3, new MockFetcher(st));
  const job = await c1.startOrResume({ sourceId: 'src-fault-t', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  const failed = await c1.run(job.jobId);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.entries.some((e) => e.status === 'failed' && e.snapshotIds.length >= 1));

  st.faults.clear();
  const c2 = new CrawlService(s3, new MockFetcher(createMockState()));
  const recovered = await c2.run(job.jobId);
  assert.equal(recovered.status, 'completed');
  await s3.close();
  await rm(dir, { recursive: true, force: true });
});

test('发布闸门：完整批次可发布，退化/版本不一致被拒，上一发布保留', async () => {
  const crawl = new CrawlService(store, new MockFetcher(createMockState()));
  const job = await crawl.startOrResume({ sourceId: 'src-pub', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  await crawl.run(job.jobId);
  // src-pub 没有自己的夹具 -> 无回归夹具必须拒绝
  const publish = new PublishService(store);
  const noFixture = await publish.evaluate(job.jobId, RULE_V1);
  assert.equal(noFixture.allowed, false);

  // 为该来源建立夹具后可发布
  const entries = [
    { entryUrl: MOCK_URLS.detailA1, snapshots: [await snap(MOCK_URLS.detailA1, 'v1', 'p1'), await snap(MOCK_URLS.detailA2, 'v1', 'p1')] },
    { entryUrl: MOCK_URLS.detailB, snapshots: [await snap(MOCK_URLS.detailB, 'v1', 'p2')] },
    { entryUrl: MOCK_URLS.detailC, snapshots: [await snap(MOCK_URLS.detailC, 'v1', 'p3')] },
    { entryUrl: MOCK_URLS.detailD, snapshots: [await snap(MOCK_URLS.detailD, 'v1', 'p4')] },
    { entryUrl: MOCK_URLS.detailBad, snapshots: [await snap(MOCK_URLS.detailBad, 'v1', 'p5')] },
  ];
  await regression.createFixture({
    fixtureId: 'fx-pub', name: '发布门禁夹具', sourceId: 'src-pub', entries,
    expectedRecords: [goldenNoticeA(), goldenNoticeB(), goldenNoticeC(), goldenNoticeD(), goldenNoticeBad()].map(strip),
  });
  const ok = await publish.evaluate(job.jobId, RULE_V1);
  assert.equal(ok.allowed, true, ok.reasons.join(';'));
  const pub1 = await publish.publish(job.jobId, RULE_V1);
  assert.equal((await publish.current('src-pub'))?.publicationId, pub1.publicationId);

  const regressed = await publish.evaluate(job.jobId, RULE_REGRESSED);
  assert.equal(regressed.allowed, false);
  assert.equal((await publish.current('src-pub'))?.publicationId, pub1.publicationId);

  const mismatch = await publish.evaluate(job.jobId, RULE_V2);
  assert.equal(mismatch.allowed, false);
});
