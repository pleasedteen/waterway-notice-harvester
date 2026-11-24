/**
 * 页面尝试诊断与中断语义测试：
 *  - 列表页/详情页每次处理可识别 fetched（重新请求）/ reused（复用快照）/ failed（失败）/ in_flight（结局未知）；
 *  - 请求途中强杀（以挂起请求 + Abort 模拟）后重启，旧 in_flight 尝试原样保留，新尝试另写新行；
 *  - 只有检查点已落盘的页面才出现 fetched + snapshotId，才允许整批成功；
 *  - 单次推进新增诊断写入量只与本次触及页面数有关，不随历史尝试次数增长；
 *  - 列表阶段中断后续跑：已采列表页复用快照、不重复请求。
 * 全程内存模拟站点 + 嵌入式文件存储，无外部进程。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedStore } from '../src/storage/embedded-store.js';
import { CrawlService } from '../src/service/crawl-service.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../src/mock/site.js';
import { RULE_V1 } from '../src/core/rule-catalog.js';
import type { CrawlJob, PageAttempt, Store } from '../src/core/types.js';

async function freshStore(dir: string): Promise<EmbeddedStore> {
  const s = new EmbeddedStore(dir);
  await s.init();
  await s.saveRule(RULE_V1);
  return s;
}

/** 以挂起请求模拟"请求途中强杀"：fetch 永不返回，Abort 等同于进程被 SIGKILL */
class HangingFetcher extends MockFetcher {
  override async fetch(url: string): Promise<never> {
    await new Promise<void>(() => {});
    throw new Error('unreachable');
  }
}

function byUrl(attempts: PageAttempt[], urlPart: string): PageAttempt[] {
  return attempts.filter((a) => a.url.includes(urlPart));
}

test('每次列表页/详情页处理都可识别结局与页面地址（fetched/reused）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-att-'));
  try {
    const store = await freshStore(dir);
    const crawl = new CrawlService(store, new MockFetcher(createMockState()));
    const job = await crawl.startOrResume({ sourceId: 'src-att', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    await crawl.run(job.jobId, { maxEntriesPerCall: 1 });

    const attempts = await store.listPageAttempts(job.jobId);
    // 两个列表页（list、list?page=2）+ 第一个条目的两页详情
    assert.ok(byUrl(attempts, '/notice/list').length >= 2, '两个列表页各有一条尝试');
    assert.ok(byUrl(attempts, 'G2026-018?page=1').length >= 1);
    assert.ok(byUrl(attempts, 'G2026-018?page=2').length >= 1);
    assert.ok(attempts.every((a) => a.outcome === 'fetched'), '首轮全部为重新请求 fetched');
    assert.ok(attempts.every((a) => a.snapshotId !== null && a.url.startsWith('http')), '尝试带快照 id 与页面地址');
    assert.ok(attempts.every((a) => a.finishedAt !== null));

    // 重启后续跑：已完成条目的页面与已采列表页必须复用快照（reused），不重新请求
    const reboot = new CrawlService(new EmbeddedStore(dir), new MockFetcher(createMockState()));
    const same = await reboot.startOrResume({ sourceId: 'src-att', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    assert.equal(same.jobId, job.jobId);
    await reboot.run(same.jobId);
    const all = await store.listPageAttempts(job.jobId);
    const reused = all.filter((a) => a.outcome === 'reused');
    const refetched = all.filter((a) => a.outcome === 'fetched');
    assert.ok(reused.some((a) => a.kind === 'list' && a.url.includes('/notice/list')), '列表页复用快照');
    assert.ok(reused.some((a) => a.kind === 'detail' && a.url.includes('G2026-018')), '已完成详情页复用快照');
    // 后续三个条目（021/030/999 各一页）为新请求
    for (const part of ['G2026-021', 'G2026-030', 'G2026-999']) {
      assert.equal(byUrl(refetched, part).length, 1, `${part} 应重新请求一次`);
    }
    // 复用尝试不产生新快照 id，但仍指向被复用的快照
    assert.ok(reused.every((a) => a.snapshotId !== null));
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('请求途中强杀：旧尝试停留在 in_flight，重启后新尝试可区分，仅落盘页面成功', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-kill-'));
  try {
    const store = await freshStore(dir);
    const normal = new CrawlService(store, new MockFetcher(createMockState()));
    const job = await normal.startOrResume({ sourceId: 'src-kill', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    // 先完成第一个条目（两页详情落盘）
    await normal.run(job.jobId, { maxEntriesPerCall: 1 });

    // 第二个条目（G2026-021，单页）请求挂起 => 模拟请求途中被强杀
    const hanging = new CrawlService(new EmbeddedStore(dir), new HangingFetcher(createMockState()));
    const runPromise = hanging.run(job.jobId, { maxEntriesPerCall: 1 });
    // 等待 in_flight 尝试落盘（轮询而非睡眠）
    let inflight: PageAttempt | undefined;
    for (let i = 0; i < 100 && !inflight; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      inflight = (await store.listPageAttempts(job.jobId)).find((a) => a.outcome === 'in_flight');
    }
    assert.ok(inflight, '请求发出前已登记 in_flight 尝试');
    assert.equal(inflight!.url, MOCK_URLS.detailB);
    assert.equal(inflight!.snapshotId, null);
    assert.equal(inflight!.finishedAt, null);

    // “强杀”：放弃该进程内的挂起运行（其存储句柄不再使用）
    runPromise.catch(() => {});

    // 新进程重启：旧 in_flight 原样保留，对同一页面发起全新尝试
    const reboot = new CrawlService(new EmbeddedStore(dir), new MockFetcher(createMockState()));
    const resumed = await reboot.startOrResume({ sourceId: 'src-kill', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    await reboot.run(resumed.jobId);
    const after = await store.listPageAttempts(job.jobId);

    const stale = after.filter((a) => a.attemptId === inflight!.attemptId);
    assert.equal(stale.length, 1, '旧尝试只有一条');
    assert.equal(stale[0]!.outcome, 'in_flight', '旧 in_flight 尝试不被覆盖/改写');
    assert.equal(stale[0]!.finishedAt, null);

    const freshAttempts = after.filter((a) => a.url === MOCK_URLS.detailB);
    assert.equal(freshAttempts.length, 2, '同页两条：一条旧 in_flight + 一条新尝试');
    const fresh = freshAttempts.find((a) => a.attemptId !== inflight!.attemptId)!;
    assert.equal(fresh.outcome, 'fetched');
    assert.notEqual(fresh.attemptId, inflight!.attemptId, '新旧尝试 id 不同，可明确区分');
    assert.ok(fresh.startedAt >= inflight!.startedAt);

    // 只有检查点已落盘的页面才成功：整批 completed，且任何成功尝试都带 snapshotId
    const done = (await store.getJob(job.jobId)) as CrawlJob;
    assert.equal(done.status, 'completed');
    assert.ok(after.filter((a) => a.outcome === 'fetched').every((a) => a.snapshotId !== null));
    assert.ok(after.filter((a) => a.snapshotId === null).every((a) => a.outcome === 'in_flight'));
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('请求失败落 failed 尝试且无快照；故障消除后新尝试成功，批次恢复 completed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-fail-'));
  try {
    const store = await freshStore(dir);
    const state = createMockState();
    state.faults.set('G2026-018?page=2', 'error');
    const c1 = new CrawlService(store, new MockFetcher(state));
    const job = await c1.startOrResume({ sourceId: 'src-fail-att', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    const failed = await c1.run(job.jobId);
    assert.equal(failed.status, 'failed');

    const attempts = await store.listPageAttempts(job.jobId);
    const failedAtt = byUrl(attempts, 'G2026-018?page=2').find((a) => a.outcome === 'failed')!;
    assert.ok(failedAtt, '失败尝试被记录');
    assert.equal(failedAtt.snapshotId, null, '失败不产生快照');
    assert.ok(failedAtt.error?.includes('模拟网络故障'));
    assert.equal(failedAtt.finishedAt !== null, true);
    // 同条目第 1 页已落盘成功
    assert.equal(byUrl(attempts, 'G2026-018?page=1').some((a) => a.outcome === 'fetched'), true);

    // 故障消除后续跑：旧 failed 保留，新尝试 fetched；第 1 页 reused
    state.faults.clear();
    const c2 = new CrawlService(new EmbeddedStore(dir), new MockFetcher(createMockState()));
    const recovered = await c2.run(job.jobId);
    assert.equal(recovered.status, 'completed');
    const after = await store.listPageAttempts(job.jobId);
    const page2 = byUrl(after, 'G2026-018?page=2');
    assert.equal(page2.filter((a) => a.outcome === 'failed').length, 1, '历史 failed 尝试保留');
    assert.equal(page2.filter((a) => a.outcome === 'fetched').length, 1, '新尝试成功');
    assert.equal(byUrl(after, 'G2026-018?page=1').filter((a) => a.outcome === 'reused').length, 1, '第 1 页复用快照');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('单次推进新增诊断写入量不随历史尝试次数增长（物理文件口径）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-bounded-'));
  try {
    const store = await freshStore(dir);
    const attemptsDir = join(dir, 'attempts');
    const countFiles = async (): Promise<number> => (await readdir(attemptsDir)).filter((f) => f.endsWith('.json')).length;

    // 制造多轮历史失败：同一详情页连续失败 N 次
    const state = createMockState();
    state.faults.set('G2026-021', 'error');
    let job: CrawlJob | null = null;
    for (let round = 0; round < 4; round += 1) {
      const c = new CrawlService(new EmbeddedStore(dir), new MockFetcher(state));
      job = await c.startOrResume({ sourceId: 'src-bound', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
      await c.run(job.jobId, { maxEntriesPerCall: 2 });
    }
    const historyCount = await countFiles();
    assert.ok(historyCount > 0);
    const historicalAttempts = await store.listPageAttempts(job!.jobId);
    assert.equal(byUrl(historicalAttempts, 'G2026-021').filter((a) => a.outcome === 'failed').length, 4);

    // 再成功推进一次（故障消除）：本次新增文件数应与“本次触及页面数”同阶，
    // 与已经累积的 4 次历史失败无关 —— 断言新增量不超过本次触及页面数的常数倍（每尝试 in_flight+终态两份）。
    state.faults.clear();
    const before = await countFiles();
    const okCrawl = new CrawlService(new EmbeddedStore(dir), new MockFetcher(createMockState()));
    await okCrawl.run(job!.jobId, { maxEntriesPerCall: 1 });
    const deltaOneCall = (await countFiles()) - before;

    // 本次一个条目调用：复用页（1 份/页）+ 至多 1 个新请求页（2 份），远小于历史累积量
    assert.ok(deltaOneCall <= 4, `单次推进新增诊断文件应受常数上界约束，实际 ${deltaOneCall}`);
    assert.ok(deltaOneCall < historyCount, '新增量不随历史次数膨胀');

    // 连续再推进两次，每次新增量都保持同一常数上界（与总历史长度无关）
    for (let i = 0; i < 2; i += 1) {
      const b = await countFiles();
      await okCrawl.run(job!.jobId, { maxEntriesPerCall: 1 });
      const d = (await countFiles()) - b;
      assert.ok(d <= 4, `第 ${i + 1} 次推进新增量仍受常数上界约束，实际 ${d}`);
    }
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('列表阶段中断后续跑：已采列表页复用、不重新请求，缺失页补抓', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-list-'));
  try {
    const store = await freshStore(dir);
    // 让列表第 2 页先失败，制造“列表发现中断”
    const state = createMockState();
    state.faults.set('/notice/list?page=2', 'error');
    const c1 = new CrawlService(store, new MockFetcher(state));
    const job = await c1.startOrResume({ sourceId: 'src-list', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    const r1 = await c1.run(job.jobId);
    assert.equal(r1.listDiscoveryDone, false, '列表发现中断，保持可续跑');
    const firstRound = await store.listPageAttempts(job.jobId);
    assert.equal(firstRound.filter((a) => a.kind === 'list' && a.outcome === 'failed').length, 1);
    assert.equal(firstRound.filter((a) => a.kind === 'list' && a.outcome === 'fetched').length, 1);

    // 重启且故障消除：第 1 页列表复用（不发请求），第 2 页补抓（新 fetched 尝试）
    state.faults.clear();
    const fetchUrls: string[] = [];
    const countingFetcher = new MockFetcher(createMockState());
    const inner = countingFetcher.fetch.bind(countingFetcher);
    countingFetcher.fetch = async (url: string) => {
      fetchUrls.push(url);
      return inner(url);
    };
    const c2 = new CrawlService(new EmbeddedStore(dir), countingFetcher);
    const resumed = await c2.startOrResume({ sourceId: 'src-list', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    assert.equal(resumed.jobId, job.jobId);
    const r2 = await c2.run(job.jobId);
    assert.equal(r2.listDiscoveryDone, true, '补抓后列表发现完成');

    // 第 1 页列表没有被重新请求；仅第 2 页补抓一次
    assert.equal(fetchUrls.filter((u) => u === MOCK_URLS.list).length, 0, '已采列表第 1 页复用快照');
    assert.equal(fetchUrls.filter((u) => u === MOCK_URLS.listP2).length, 1, '缺失的列表第 2 页补抓');

    const listAttempts = (await store.listPageAttempts(job.jobId)).filter((a) => a.kind === 'list');
    assert.equal(listAttempts.filter((a) => a.outcome === 'reused').length, 1, '第 1 页留下 reused 尝试');
    assert.equal(listAttempts.filter((a) => a.outcome === 'failed').length, 1, '历史失败列表尝试保留');
    assert.equal(listAttempts.filter((a) => a.outcome === 'fetched').length, 2, '首轮第 1 页 + 补抓第 2 页');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('列表发现反复失败续跑：reused 诊断只记一次，不随续跑次数增长', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-list-repeat-'));
  try {
    const store = await freshStore(dir);
    const state = createMockState();
    state.faults.set('/notice/list?page=2', 'error');
    const c1 = new CrawlService(store, new MockFetcher(state));
    const job = await c1.startOrResume({ sourceId: 'src-list-repeat', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    await c1.run(job.jobId);

    // 故障未消除，连续多次“重启续跑”
    for (let i = 0; i < 3; i += 1) {
      const c = new CrawlService(new EmbeddedStore(dir), new MockFetcher(state));
      await c.startOrResume({ sourceId: 'src-list-repeat', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
      await c.run(job.jobId);
    }
    const listAttempts = await store.listPageAttempts(job.jobId);
    assert.equal(listAttempts.filter((a) => a.kind === 'list' && a.outcome === 'reused').length, 1,
      '第 1 页列表的 reused 尝试始终只有一条');
    assert.equal(listAttempts.filter((a) => a.kind === 'list' && a.outcome === 'failed').length, 4,
      '四次尝试各留一条 failed（首轮 + 三次续跑），但复用诊断不膨胀');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('completed 作业再次推进不产生任何新诊断写入', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-idle-'));
  try {
    const store = await freshStore(dir);
    const crawl = new CrawlService(store, new MockFetcher(createMockState()));
    const job = await crawl.startOrResume({ sourceId: 'src-idle', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    await crawl.run(job.jobId);
    const before = (await store.listPageAttempts(job.jobId)).length;
    const again = await crawl.run(job.jobId);
    assert.equal(again.status, 'completed');
    const after = (await store.listPageAttempts(job.jobId)).length;
    assert.equal(after, before, '已完成作业重复推进零新增尝试');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
