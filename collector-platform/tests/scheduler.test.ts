/**
 * 定时采集与双实例协同测试（完全离线，内存模拟站点 + 嵌入式文件存储）：
 *  1. 接口配置间隔/规则版本，到点自动推进，发布不自动发生；
 *  2. 同来源同轮两个实例只启动一次（并发触发去重），手动续跑遵守同源并发限制；
 *  3. 一个来源请求挂起不拖住其他来源（按来源独立异步链）；
 *  4. 推进实例失联超过接管时限后另一实例接管：保留规则版本与已确认页检查点、
 *     不重抓已确认页；旧实例迟到结果被围栏拒绝，不能改写进度。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedStore } from '../src/storage/embedded-store.js';
import { SchedulerService } from '../src/service/scheduler-service.js';
import { CrawlService } from '../src/service/crawl-service.js';
import { PublishService } from '../src/service/publish-service.js';
import { VirtualClock } from '../src/core/clock.js';
import { LeaseBusyError, LeaseLostError } from '../src/core/errors.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../src/mock/site.js';
import type { FetchedPage, Fetcher } from '../src/fetch/fetcher.js';
import { RULE_V1 } from '../src/core/rule-catalog.js';
import type { Store } from '../src/core/types.js';

/** 可挂起的抓取器：在指定 URL 上等待外部放行，用于复现"请求挂起"与失联 */
class ControllableFetcher implements Fetcher {
  private readonly gates = new Map<string, { resolve: () => void; promise: Promise<void> }>();
  readonly requestLog: string[] = [];
  hangUrls: string[] = [];
  /** 已进入挂起状态的 Promise，测试可确定性等待"请求已挂起" */
  private hangWaiters: Array<() => void> = [];
  private hangCount = 0;
  private readonly delegate = new MockFetcher(createMockState());

  /** 等待 n 个请求进入挂起（默认 1 个） */
  waitUntilHung(n = 1): Promise<void> {
    if (this.hangCount >= n) return Promise.resolve();
    return new Promise((resolve) => {
      const check = (): void => {
        if (this.hangCount >= n) resolve();
        else this.hangWaiters.push(check);
      };
      check();
    });
  }

  private gate(url: string): { resolve: () => void; promise: Promise<void> } {
    let g = this.gates.get(url);
    if (!g) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      g = { resolve, promise };
      this.gates.set(url, g);
    }
    return g;
  }

  releaseAll(): void {
    for (const g of this.gates.values()) g.resolve();
  }

  async fetch(url: string): Promise<FetchedPage> {
    this.requestLog.push(url);
    if (this.hangUrls.some((h) => url.includes(h))) {
      this.hangCount += 1;
      const waiters = this.hangWaiters;
      this.hangWaiters = [];
      for (const w of waiters) w();
      await this.gate(url).promise; // 挂起：不 reject，模拟失联实例卡在请求中
    }
    return this.delegate.fetch(url);
  }
}

/** 每个用例一套独立存储 + 独立虚拟时钟，杜绝跨用例的后台链/租约干扰 */
interface Harness {
  store: Store;
  clock: VirtualClock;
  makeScheduler: (instanceId: string, fetcherFactory: (sourceId: string) => Fetcher) => SchedulerService;
  cleanup: () => Promise<void>;
}

async function newHarness(): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'collector-sched-'));
  const localStore = new EmbeddedStore(dir);
  await localStore.init();
  await localStore.saveRule(RULE_V1);
  const localClock = new VirtualClock();
  // 虚拟时钟从真实当前时刻起步：未走时钟的默认 Date.now() 路径与之同量级，不会误判超时
  localClock.setNow(Date.now());
  return {
    store: localStore,
    clock: localClock,
    makeScheduler: (instanceId, fetcherFactory) =>
      new SchedulerService({
        store: localStore,
        clock: localClock,
        instanceId,
        fetcherFactory,
        tickMs: 100,
        failureBackoffMs: 5_000,
      }),
    cleanup: async () => {
      await localStore.close();
      // 重试删除：挂起链恢复后可能仍在落盘，等待其结束
      for (let i = 0; i < 10; i += 1) {
        try {
          await rm(dir, { recursive: true, force: true });
          return;
        } catch {
          await new Promise((r) => setTimeout(r, 30));
        }
      }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

const baseSchedule = (over: Partial<Parameters<SchedulerService['upsertSchedule']>[0]> = {}) => ({
  sourceId: 'src-under-test',
  name: '测试来源',
  seedUrl: MOCK_URLS.list,
  ruleId: RULE_V1.ruleId,
  ruleVersion: RULE_V1.version,
  intervalMs: 1_000,
  takeoverTimeoutMs: 400,
  ...over,
});

test('定时配置：间隔与规则版本可配；非法间隔/未知规则版本被拒', async () => {
  const h = await newHarness();
  try {
    const sched = h.makeScheduler('inst-cfg', () => new MockFetcher(createMockState()));
    const saved = await sched.upsertSchedule(baseSchedule({ sourceId: 'src-config' }));
    assert.equal(saved.intervalMs, 1000);
    assert.equal(saved.ruleVersion, '1.0.0');
    assert.equal(saved.enabled, true);

    await assert.rejects(
      () => sched.upsertSchedule(baseSchedule({ sourceId: 'src-bad', intervalMs: 0 })),
      /intervalMs/,
    );
    await assert.rejects(
      () => sched.upsertSchedule(baseSchedule({ sourceId: 'src-bad2', ruleVersion: '9.9.9' })),
      /规则版本不存在/,
    );
  } finally {
    await h.cleanup();
  }
});

test('到点自动推进作业直到完成，但不自动发布（发布仍需人工）', async () => {
  const h = await newHarness();
  try {
    const sched = h.makeScheduler('inst-auto', () => new MockFetcher(createMockState()));
    await sched.upsertSchedule(baseSchedule({ sourceId: 'src-auto' }));

    // 未到间隔：tick 不启动
    await sched.tick();
    assert.equal((await h.store.listJobs()).filter((j) => j.sourceId === 'src-auto').length, 0);

    // 到点：tick 后后台链自动跑到 completed
    await h.clock.advance(1_001);
    await sched.tick();
    await sched.waitIdle('src-auto');
    const jobs = (await h.store.listJobs()).filter((j) => j.sourceId === 'src-auto');
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0]!.status, 'completed');
    assert.equal(jobs[0]!.ruleVersion, RULE_V1.version);
    assert.ok(jobs[0]!.round, '作业带有调度轮次');

    // 自动采集不产生任何发布
    assert.equal((await h.store.listPublications('src-auto')).length, 0);
    // 人工发布闸门仍然可用（无夹具时拒绝，证明发布权在人工）
    const decision = await new PublishService(h.store).evaluate(jobs[0]!.jobId, RULE_V1);
    assert.equal(decision.allowed, false);

    const lease = await h.store.getLease('src-auto');
    assert.equal(lease?.state, 'released');
  } finally {
    await h.cleanup();
  }
});

test('并发触发：两个实例同来源同轮只有一个启动作业，另一实例 busy', async () => {
  const h = await newHarness();
  try {
    const schedA = h.makeScheduler('inst-race-a', () => new MockFetcher(createMockState()));
    const schedB = h.makeScheduler('inst-race-b', () => new MockFetcher(createMockState()));
    await schedA.upsertSchedule(baseSchedule({ sourceId: 'src-race' }));

    await h.clock.advance(1_001);
    await Promise.all([schedA.tick(), schedB.tick()]);
    await Promise.all([schedA.waitAllIdle(), schedB.waitAllIdle()]);

    const jobs = (await h.store.listJobs()).filter((j) => j.sourceId === 'src-race');
    assert.equal(jobs.length, 1, '同轮只启动一个作业');
    const lease = await h.store.getLease('src-race');
    assert.ok(['inst-race-a', 'inst-race-b'].includes(lease!.ownerId));
    assert.equal(lease!.fencingToken, 1, '首次获取令牌为 1，未发生重复易主');
  } finally {
    await h.cleanup();
  }
});

test('手动续跑遵守同源并发限制：租约被持有时另一实例得到 busy', async () => {
  const h = await newHarness();
  try {
    const hung = new ControllableFetcher();
    hung.hangUrls = [MOCK_URLS.detailB];
    const schedA = h.makeScheduler('inst-manual-a', () => hung);
    const schedB = h.makeScheduler('inst-manual-b', () => new MockFetcher(createMockState()));
    await schedA.upsertSchedule(baseSchedule({ sourceId: 'src-manual', maxEntriesPerCall: 1 }));

    await h.clock.advance(1_001);
    const ticked = schedA.tick(); // A 卡在详情请求上，租约保持活跃
    await hung.waitUntilHung();
    const leaseWhileHung = await h.store.getLease('src-manual');
    assert.equal(leaseWhileHung?.state, 'active');
    assert.equal(leaseWhileHung?.ownerId, 'inst-manual-a');

    const job = (await h.store.listJobs()).find((j) => j.sourceId === 'src-manual')!;
    // B 尝试手动续跑同作业 => 同源并发限制拒绝
    await assert.rejects(() => schedB.manualRunStep(job.jobId), LeaseBusyError);
    // 本实例自身的重复推进也被运行集合挡回（busy 结果而非并发运行）
    const selfStep = await schedA.manualRunStep(job.jobId);
    assert.equal(selfStep.outcome, 'busy');

    hung.releaseAll();
    await ticked;
    await schedA.waitIdle('src-manual');
  } finally {
    await h.cleanup();
  }
});

test('来源隔离：一个来源请求挂起，不拖住其他来源的到点采集', async () => {
  const h = await newHarness();
  try {
    const hung = new ControllableFetcher();
    hung.hangUrls = [MOCK_URLS.detailB]; // src-hang 在 B 公告详情挂起
    const sched = h.makeScheduler('inst-isolation', (sourceId) =>
      sourceId === 'src-hang' ? hung : new MockFetcher(createMockState()));

    await sched.upsertSchedule(baseSchedule({ sourceId: 'src-hang' }));
    await sched.upsertSchedule(baseSchedule({ sourceId: 'src-other' }));

    await h.clock.advance(1_001);
    const ticked = sched.tick();
    await hung.waitUntilHung(); // src-hang 已挂起；此时 src-other 应已独立跑完
    await sched.waitIdle('src-other');

    const hangJob = (await h.store.listJobs()).find((j) => j.sourceId === 'src-hang')!;
    const otherJob = (await h.store.listJobs()).find((j) => j.sourceId === 'src-other')!;
    assert.equal(hangJob.status, 'running', '挂起来源仍在运行');
    assert.equal(otherJob.status, 'completed', '其他来源不受挂起影响，照常完成');
    assert.equal(otherJob.entries.length, 4);

    hung.releaseAll();
    await ticked;
    await sched.waitIdle('src-hang');
  } finally {
    await h.cleanup();
  }
});

test('失联接管：超时后另一实例沿用同一作业/规则版本/检查点，不重抓已确认页', async () => {
  const h = await newHarness();
  try {
    const fetcherA = new ControllableFetcher();
    fetcherA.hangUrls = [MOCK_URLS.detailB]; // A 完成条目 1 后卡在条目 2
    const fetcherB = new ControllableFetcher();
    const schedA = h.makeScheduler('inst-take-a', () => fetcherA);
    const schedB = h.makeScheduler('inst-take-b', () => fetcherB);
    await schedA.upsertSchedule(baseSchedule({ sourceId: 'src-takeover', maxEntriesPerCall: 1 }));

    await h.clock.advance(1_001);
    const tickedA = schedA.tick();
    await fetcherA.waitUntilHung(); // A 已完成条目 1 并卡在条目 2
    const jobBefore = (await h.store.listJobs()).find((j) => j.sourceId === 'src-takeover')!;
    assert.equal(jobBefore.entries.filter((e) => e.status === 'done').length, 1, '失联前已确认 1 个条目');
    const doneEntry = jobBefore.entries.find((e) => e.status === 'done')!;
    const confirmedSnapshots = doneEntry.snapshotIds.slice();
    assert.ok(confirmedSnapshots.length > 0);
    const leaseBefore = await h.store.getLease('src-takeover');
    assert.equal(leaseBefore!.ownerId, 'inst-take-a');
    const roundBefore = leaseBefore!.round;

    // 未超过接管时限 => B 手动续跑被同源并发限制拒绝
    await h.clock.advance(300);
    await assert.rejects(
      () => schedB.manualRunStep(jobBefore.jobId),
      (e: unknown) => e instanceof LeaseBusyError,
      '未到接管时限，另一实例得到 busy',
    );

    // 越过接管时限（A 全程无心跳）=> B tick 接管同一轮作业
    await h.clock.advance(101);
    await schedB.tick();
    await schedB.waitIdle('src-takeover');

    const leaseAfter = await h.store.getLease('src-takeover');
    assert.equal(leaseAfter!.ownerId, 'inst-take-b', '租约易主');
    assert.equal(leaseAfter!.fencingToken, leaseBefore!.fencingToken + 1, '围栏令牌递增');
    assert.equal(leaseAfter!.round, roundBefore, '接管沿用同一轮');

    const jobAfter = (await h.store.listJobs()).find((j) => j.sourceId === 'src-takeover')!;
    assert.equal(jobAfter.jobId, jobBefore.jobId, '接管沿用同一作业，不新建');
    assert.equal(jobAfter.ruleVersion, jobBefore.ruleVersion, '规则版本保留');
    assert.equal(jobAfter.status, 'completed');
    assert.equal(jobAfter.entries.length, 4);

    // 已确认页检查点保留
    const keptEntry = jobAfter.entries.find((e) => e.entryUrl === doneEntry.entryUrl)!;
    assert.deepEqual(keptEntry.snapshotIds, confirmedSnapshots, '已确认页快照未被替换');
    // 接管实例 B 不应重抓任何已确认页
    const confirmedUrls = new Set<string>();
    for (const sid of confirmedSnapshots) {
      const snap = await h.store.getSnapshot(sid);
      if (snap) confirmedUrls.add(snap.url);
    }
    const refetched = fetcherB.requestLog.filter((u) => confirmedUrls.has(u));
    assert.equal(refetched.length, 0, `接管实例不重抓已确认页，实际重抓: ${refetched.join(', ')}`);

    fetcherA.releaseAll();
    await tickedA;
    await schedA.waitIdle('src-takeover');
  } finally {
    await h.cleanup();
  }
});

test('围栏：旧实例迟到的结果不能改写接管后的进度', async () => {
  const h = await newHarness();
  try {
    const fetcherA = new ControllableFetcher();
    fetcherA.hangUrls = [MOCK_URLS.detailB];
    const schedA = h.makeScheduler('inst-fence-a', () => fetcherA);
    const schedB = h.makeScheduler('inst-fence-b', () => new MockFetcher(createMockState()));
    await schedA.upsertSchedule(baseSchedule({ sourceId: 'src-fence', maxEntriesPerCall: 1 }));

    await h.clock.advance(1_001);
    const tickedA = schedA.tick();
    await fetcherA.waitUntilHung();
    const staleJob = (await h.store.listJobs()).find((j) => j.sourceId === 'src-fence')!;
    const staleLease = await h.store.getLease('src-fence');
    const staleFence = { ownerId: staleLease!.ownerId, fencingToken: staleLease!.fencingToken };

    // B 接管并完成
    await h.clock.advance(401);
    await schedB.tick();
    await schedB.waitIdle('src-fence');
    const takenLease = await h.store.getLease('src-fence');
    assert.equal(takenLease!.ownerId, 'inst-fence-b');

    // A 迟到的检查点写入（旧 owner/旧令牌）被围栏拒绝
    const staleCopy = JSON.parse(JSON.stringify(staleJob)) as typeof staleJob;
    staleCopy.entries.forEach((e) => {
      e.status = 'done';
    });
    await assert.rejects(() => h.store.saveJob(staleCopy, staleFence), LeaseLostError);

    // 存储中的作业仍是 B 接管后的完成态，未被迟到结果改写
    const current = await h.store.getJob(staleJob.jobId);
    assert.equal(current!.status, 'completed');

    // 旧实例的心跳同样被拒
    await assert.rejects(
      () => h.store.heartbeatLease('src-fence', staleFence, h.clock.nowMs()),
      LeaseLostError,
    );

    fetcherA.releaseAll();
    await tickedA;
    await schedA.waitIdle('src-fence');
  } finally {
    await h.cleanup();
  }
});

test('无定时配置的来源：手动路径仍受同源并发限制（默认接管时限）', async () => {
  const h = await newHarness();
  try {
    const schedA = h.makeScheduler('inst-plain-a', () => new MockFetcher(createMockState()));
    const schedB = h.makeScheduler('inst-plain-b', () => new MockFetcher(createMockState()));
    const stepA = await schedA.manualStart({
      sourceId: 'src-plain',
      seedUrl: MOCK_URLS.list,
      rule: RULE_V1,
      takeoverTimeoutMs: 400,
    });
    assert.ok(stepA.job);
    // manualStart 立即释放租约，作业可被 B 续跑（不长期占用 => 不违背"手动续跑"可用性）
    const stepB = await schedB.manualRunStep(stepA.job!.jobId);
    assert.ok(['resumed', 'idle'].includes(stepB.outcome));
    assert.ok(await h.store.getJob(stepA.job!.jobId));
  } finally {
    await h.cleanup();
  }
});

test('CrawlService 无围栏路径保持向后兼容（既有本地续跑行为不变）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-plain-'));
  const local = new EmbeddedStore(dir);
  await local.init();
  await local.saveRule(RULE_V1);
  try {
    const crawl = new CrawlService(local, new MockFetcher(createMockState()));
    const job = await crawl.startOrResume({ sourceId: 'src-legacy', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    const done = await crawl.run(job.jobId);
    assert.equal(done.status, 'completed');
  } finally {
    await local.close();
    await rm(dir, { recursive: true, force: true });
  }
});
