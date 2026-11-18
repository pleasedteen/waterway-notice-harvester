/**
 * 整批完整性测试：
 * - 列表第二页抓取失败后重跑：沿用已有快照续采，漏的公告必须补齐，否则不许 completed；
 * - 列表/详情达到页数上限仍有下一页：批次截断，禁止完成与发布；
 * - 发布前按候选规则离线重放列表发现、预取与详情续页，漏页/证据不足即拒发，
 *   上一版本继续生效；补齐并通过回归后才可发布；
 * - 旧详情夹具（无列表快照）仍可单独逐字段比对。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedStore } from '../src/storage/embedded-store.js';
import { CrawlService } from '../src/service/crawl-service.js';
import { RegressionService } from '../src/service/regression-service.js';
import { PublishService } from '../src/service/publish-service.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../src/mock/site.js';
import { RULE_V1, RULE_REGRESSED } from '../src/core/rule-catalog.js';
import {
  goldenNoticeA, goldenNoticeB, goldenNoticeC, goldenNoticeD, goldenNoticeBad,
} from '../src/core/golden.js';
import { compareExpectations } from '../src/core/regression.js';
import type { BusinessRecord, CrawlJob, RuleDocument, Snapshot, Store } from '../src/core/types.js';

const dirs: string[] = [];
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function newStore(): Promise<Store> {
  const dir = await mkdtemp(join(tmpdir(), 'collector-batch-'));
  dirs.push(dir);
  const s = new EmbeddedStore(dir);
  await s.init();
  await s.saveRule(RULE_V1);
  return s;
}

async function snap(url: string, tag: string): Promise<Snapshot> {
  const p = await new MockFetcher(createMockState()).fetch(url);
  return {
    snapshotId: `bc_${tag}_${Buffer.from(url).toString('base64url')}`,
    sourceId: 'fixture-source', revision: p.revision, url: p.url,
    fetchedAt: new Date().toISOString(), statusCode: p.statusCode,
    contentType: p.contentType, html: p.html,
  };
}

const strip = (r: BusinessRecord): BusinessRecord => {
  const c: BusinessRecord = JSON.parse(JSON.stringify(r)) as BusinessRecord;
  delete c.fields.listNoticeNo;
  delete c.fields.listTitle;
  return c;
};
const goldenAll = (): BusinessRecord[] =>
  [goldenNoticeA(), goldenNoticeB(), goldenNoticeC(), goldenNoticeD(), goldenNoticeBad()].map(strip);

async function fixtureEntries(tag: string) {
  return [
    { entryUrl: MOCK_URLS.detailA1, snapshots: [await snap(MOCK_URLS.detailA1, tag), await snap(MOCK_URLS.detailA2, tag)] },
    { entryUrl: MOCK_URLS.detailB, snapshots: [await snap(MOCK_URLS.detailB, tag)] },
    { entryUrl: MOCK_URLS.detailC, snapshots: [await snap(MOCK_URLS.detailC, tag)] },
    { entryUrl: MOCK_URLS.detailD, snapshots: [await snap(MOCK_URLS.detailD, tag)] },
    { entryUrl: MOCK_URLS.detailBad, snapshots: [await snap(MOCK_URLS.detailBad, tag)] },
  ];
}

async function addFixture(store: Store, sourceId: string, fixtureId: string, tag: string): Promise<void> {
  await new RegressionService(store).createFixture({
    fixtureId, name: '整批门禁夹具', sourceId,
    entries: await fixtureEntries(tag),
    expectedRecords: goldenAll(),
  });
}

test('列表第二页抓取失败后重跑：沿用快照补齐公告，补齐并通过回归才可发布', async () => {
  const store = await newStore();
  await addFixture(store, 'src-leak', 'fx-leak', 'f1');
  const publish = new PublishService(store);

  // 第一次运行：列表第二页故障
  const st = createMockState();
  st.faults.set('list?page=2', 'error');
  const c1 = new CrawlService(store, new MockFetcher(st));
  const job = await c1.startOrResume({ sourceId: 'src-leak', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  const r1 = await c1.run(job.jobId);
  assert.equal(r1.status, 'failed');
  assert.match(r1.lastError ?? '', /列表发现失败/);
  assert.equal(r1.entries.length, 4, '第一页条目已落检查点');
  assert.equal(r1.listSnapshotIds.length, 1, '第一页列表快照已落检查点');
  assert.equal(r1.listDiscovery, 'pending', '发现未完成，状态保持 pending');
  const firstListSnapId = r1.listSnapshotIds[0];

  // 失败状态下禁止发布
  const denied = await publish.evaluate(job.jobId, RULE_V1);
  assert.equal(denied.allowed, false);

  // 故障消除后重跑：沿用第一页快照继续发现，绝不跳过
  st.faults.clear();
  const c2 = new CrawlService(store, new MockFetcher(st));
  const r2 = await c2.run(job.jobId);
  assert.equal(r2.status, 'completed');
  assert.equal(r2.listDiscovery, 'completed');
  assert.equal(r2.entries.length, 5, '第二页公告必须补齐');
  assert.ok(r2.entries.some((e) => e.entryUrl === MOCK_URLS.detailD), 'G2026-041 不再漏掉');
  assert.equal(r2.listSnapshotIds.length, 2);
  assert.equal(r2.listSnapshotIds[0], firstListSnapId, '第一页列表快照复用，未重复抓取');
  const recD = r2.entries.find((e) => e.entryUrl === MOCK_URLS.detailD)!.record!;
  assert.equal(compareExpectations([goldenNoticeD()], [recD]).length, 0, '补齐公告字段与黄金期望一致');

  // 补齐 + 回归通过 => 放行发布
  const ok = await publish.evaluate(job.jobId, RULE_V1);
  assert.equal(ok.allowed, true, ok.reasons.join(';'));
  const pub = await publish.publish(job.jobId, RULE_V1);
  assert.equal(pub.records.length, 5);
  assert.equal((await publish.current('src-leak'))?.publicationId, pub.publicationId);
});

test('漏页作业（旧 bug 形态）被闸门拒绝，上一发布继续生效', async () => {
  const store = await newStore();
  await addFixture(store, 'src-legacy', 'fx-legacy', 'f2');
  const crawl = new CrawlService(store, new MockFetcher(createMockState()));
  const publish = new PublishService(store);

  // 正常完整批次并发布，作为"上一版本"
  const good = await crawl.startOrResume({ sourceId: 'src-legacy', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  await crawl.run(good.jobId);
  const pub1 = await publish.publish(good.jobId, RULE_V1, '完整批次');
  assert.equal((await publish.current('src-legacy'))?.publicationId, pub1.publicationId);

  const clone = async (jobId: string, mutate: (j: CrawlJob) => void): Promise<CrawlJob> => {
    const j = JSON.parse(JSON.stringify(await store.getJob(good.jobId))) as CrawlJob;
    j.jobId = jobId;
    j.publicationId = null;
    mutate(j);
    await store.saveJob(j);
    return j;
  };

  // 变体 A：旧版本作业——列表第二页快照与条目都缺失，却自称 completed（无 listDiscovery 字段）
  const a = await clone('job-legacy-a', (j) => {
    j.status = 'completed';
    j.listSnapshotIds = j.listSnapshotIds.slice(0, 1);
    j.entries = j.entries.filter((e) => !e.entryUrl.includes('G2026-041'));
    delete (j as Partial<CrawlJob>).listDiscovery;
    delete (j as Partial<CrawlJob>).listNextUrl;
  });
  const da = await publish.evaluate(a.jobId, RULE_V1);
  assert.equal(da.allowed, false);
  assert.ok(da.reasons.some((r) => r.includes('仍有下一页未采集')), da.reasons.join(';'));

  // 变体 B：列表快照齐全但条目漏了第二页公告（重放发现作业未采集的条目）
  const b = await clone('job-legacy-b', (j) => {
    j.status = 'completed';
    j.entries = j.entries.filter((e) => !e.entryUrl.includes('G2026-041'));
  });
  const db = await publish.evaluate(b.jobId, RULE_V1);
  assert.equal(db.allowed, false);
  assert.ok(db.reasons.some((r) => r.includes('漏公告') && r.includes('G2026-041')), db.reasons.join(';'));

  // 证据不足 => 上一版本继续生效
  assert.equal((await publish.current('src-legacy'))?.publicationId, pub1.publicationId);
});

test('列表达到页数上限仍有下一页：批次截断，禁止完成与发布', async () => {
  const store = await newStore();
  const RULE_CAP_LIST: RuleDocument = {
    ...RULE_V1,
    version: 'cap-list-1',
    createdAt: new Date().toISOString(),
    list: { ...RULE_V1.list!, pagination: { ...RULE_V1.list!.pagination!, maxPages: 1 } },
  };
  await store.saveRule(RULE_CAP_LIST);
  const crawl = new CrawlService(store, new MockFetcher(createMockState()));
  const job = await crawl.startOrResume({ sourceId: 'src-cap', seedUrl: MOCK_URLS.list, rule: RULE_CAP_LIST });
  const r = await crawl.run(job.jobId);
  assert.equal(r.status, 'failed');
  assert.equal(r.listDiscovery, 'truncated');
  assert.equal(r.listNextUrl, MOCK_URLS.listP2);
  assert.match(r.lastError ?? '', /上限/);

  // 重跑保持截断判定（不会悄悄置 completed）
  const again = await crawl.run(job.jobId);
  assert.equal(again.status, 'failed');
  assert.equal(again.listDiscovery, 'truncated');

  const decision = await new PublishService(store).evaluate(job.jobId, RULE_CAP_LIST);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((x) => x.includes('truncated') || x.includes('不完整')), decision.reasons.join(';'));
});

test('详情续页达到页数上限仍有下一页：条目标失败，整批不完整', async () => {
  const store = await newStore();
  const RULE_CAP_DETAIL: RuleDocument = {
    ...RULE_V1,
    version: 'cap-detail-1',
    createdAt: new Date().toISOString(),
    pagination: { ...RULE_V1.pagination!, maxPages: 1 },
  };
  await store.saveRule(RULE_CAP_DETAIL);
  const crawl = new CrawlService(store, new MockFetcher(createMockState()));
  const job = await crawl.startOrResume({ sourceId: 'src-capd', seedUrl: MOCK_URLS.list, rule: RULE_CAP_DETAIL });
  const r = await crawl.run(job.jobId);
  assert.equal(r.status, 'failed');
  const entryA = r.entries.find((e) => e.entryUrl.includes('G2026-018'))!;
  assert.equal(entryA.status, 'failed');
  assert.match(entryA.lastError ?? '', /仍有下一页未采集/);
  assert.equal(entryA.snapshotIds.length, 1, '已采页检查点保留');

  const decision = await new PublishService(store).evaluate(job.jobId, RULE_CAP_DETAIL);
  assert.equal(decision.allowed, false);
});

test('详情续页快照缺失：离线重放发现不一致，拒绝发布', async () => {
  const store = await newStore();
  await addFixture(store, 'src-tamper', 'fx-tamper', 'f3');
  const crawl = new CrawlService(store, new MockFetcher(createMockState()));
  const publish = new PublishService(store);
  const good = await crawl.startOrResume({ sourceId: 'src-tamper', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  await crawl.run(good.jobId);

  // 伪造：条目 A 只剩第 1 页快照，记录却是两页合并的产物
  const j = JSON.parse(JSON.stringify(await store.getJob(good.jobId))) as CrawlJob;
  j.jobId = 'job-tampered';
  j.publicationId = null;
  const entryA = j.entries.find((e) => e.entryUrl.includes('G2026-018'))!;
  entryA.snapshotIds = entryA.snapshotIds.slice(0, 1);
  await store.saveJob(j);

  const decision = await publish.evaluate(j.jobId, RULE_V1);
  assert.equal(decision.allowed, false);
  assert.ok(
    decision.reasons.some((r) => r.includes('详情续页未采完') || r.includes('详情重放与作业记录不一致')),
    decision.reasons.join(';'),
  );
});

test('旧详情夹具（无列表快照）仍可单独逐字段比对', async () => {
  const store = await newStore();
  const regression = new RegressionService(store);
  // 旧形态夹具：只有详情快照，没有列表快照
  const fx = await regression.createFixture({
    fixtureId: 'fx-detail-only', name: '旧详情夹具', sourceId: 'src-old',
    entries: await fixtureEntries('old'),
    expectedRecords: goldenAll(),
  });
  assert.equal(fx.listSnapshotIds.length, 0);

  const ok = await regression.replay(fx.fixtureId, RULE_V1);
  assert.equal(ok.passed, true);
  assert.equal(ok.expectationMismatches.length, 0);

  const bad = await regression.replay(fx.fixtureId, RULE_REGRESSED);
  assert.equal(bad.passed, false);
  assert.ok(bad.failures > 0);
  assert.ok(bad.recordChanges.some((r) => r.fieldChanges.some((c) => c.evidence.length > 0)));
});
