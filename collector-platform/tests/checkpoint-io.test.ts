import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EmbeddedStore } from '../src/storage/embedded-store.js';
import { CrawlService } from '../src/service/crawl-service.js';
import { PublishService } from '../src/service/publish-service.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../src/mock/site.js';
import { RULE_V1 } from '../src/core/rule-catalog.js';
import type { BusinessRecord, CrawlJob, JobEntryState, JobProgressCheckpoint, RuleDocument, Snapshot } from '../src/core/types.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const crashHelper = join(testDir, 'helpers', 'crash-after-detail-page.ts');

interface IoEvent {
  method: string;
  bytes: number;
}

class SimulatedProcessExit extends Error {
  constructor() {
    super('simulated process exit after raw page commit');
    this.name = 'SimulatedProcessExit';
  }
}

class IoMeterStore extends EmbeddedStore {
  readonly writes: IoEvent[] = [];
  readonly reads: IoEvent[] = [];
  crashUrl: string | undefined;

  constructor(root: string, crashUrl?: string) {
    super(root);
    this.crashUrl = crashUrl;
  }

  resetIo(): void {
    this.writes.length = 0;
    this.reads.length = 0;
  }

  private bytes(value: unknown): number {
    return Buffer.byteLength(value === undefined ? '' : JSON.stringify(value), 'utf8');
  }

  override async saveJob(job: CrawlJob): Promise<void> {
    this.writes.push({ method: 'saveJob', bytes: this.bytes(job) });
    return super.saveJob(job);
  }

  override async getJob(jobId: string): Promise<CrawlJob | null> {
    const job = await super.getJob(jobId);
    this.reads.push({ method: 'getJob', bytes: this.bytes(job) });
    return job;
  }

  override async listJobs(): Promise<CrawlJob[]> {
    const jobs = await super.listJobs();
    this.reads.push({ method: 'listJobs', bytes: this.bytes(jobs) });
    return jobs;
  }

  override async saveSnapshot(snapshot: Snapshot): Promise<void> {
    this.writes.push({ method: 'saveSnapshot', bytes: this.bytes(snapshot) });
    await super.saveSnapshot(snapshot);
    if (this.crashUrl && snapshot.url === this.crashUrl) {
      this.crashUrl = undefined;
      throw new SimulatedProcessExit();
    }
  }

  override async getSnapshot(snapshotId: string) {
    const snapshot = await super.getSnapshot(snapshotId);
    this.reads.push({ method: 'getSnapshot', bytes: this.bytes(snapshot) });
    return snapshot;
  }

  override async saveJobEntryCheckpoint(jobId: string, index: number, entry: JobEntryState): Promise<void> {
    this.writes.push({ method: 'saveJobEntryCheckpoint', bytes: this.bytes(entry) });
    return super.saveJobEntryCheckpoint(jobId, index, entry);
  }

  override async saveJobProgress(jobId: string, progress: JobProgressCheckpoint): Promise<void> {
    this.writes.push({ method: 'saveJobProgress', bytes: this.bytes(progress) });
    return super.saveJobProgress(jobId, progress);
  }
}

class CountingMockFetcher extends MockFetcher {
  readonly requested: string[] = [];
  override async fetch(url: string) {
    this.requested.push(url);
    return super.fetch(url);
  }
}

function doneRecord(index: number, padding: string): BusinessRecord {
  const id = `SCALE-${index}`;
  return {
    identity: id,
    identityParts: { noticeNo: id },
    fields: {
      noticeNo: { field: 'noticeNo', value: { status: 'ok', value: id, unit: null }, evidence: [] },
      padding: { field: 'padding', value: { status: 'ok', value: padding, unit: null }, evidence: [] },
    },
    nested: {},
    pagesMerged: [1],
  };
}

async function seedScenario(doneCount: number): Promise<{ dir: string; store: IoMeterStore; jobId: string; sourceId: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'collector-io-'));
  const store = new IoMeterStore(dir, MOCK_URLS.detailA1);
  await store.init();
  await store.saveRule(RULE_V1);
  const jobId = `job-scale-${doneCount}`;
  const sourceId = `src-scale-${doneCount}`;
  const padding = 'x'.repeat(2048);
  const entries: JobEntryState[] = Array.from({ length: doneCount }, (_, index) => ({
    entryUrl: `http://scale.local/${jobId}/${index}`,
    prefetch: {},
    status: 'done',
    snapshotIds: [],
    pagesMerged: [1],
    record: doneRecord(index, padding),
    attempts: 1,
    lastError: null,
    updatedAt: '2026-11-25T00:00:00.000Z',
  }));
  entries.push({
    entryUrl: MOCK_URLS.detailA1,
    prefetch: {},
    status: 'pending',
    snapshotIds: [],
    pagesMerged: [],
    record: null,
    attempts: 0,
    lastError: null,
    updatedAt: '2026-11-25T00:00:00.000Z',
  });
  const job: CrawlJob = {
    jobId,
    sourceId,
    seedUrl: MOCK_URLS.list,
    ruleId: RULE_V1.ruleId,
    ruleVersion: RULE_V1.version,
    expectedRevision: 'v1',
    status: 'running',
    listSnapshotIds: [],
    entries,
    createdAt: '2026-11-25T00:00:00.000Z',
    updatedAt: '2026-11-25T00:00:00.000Z',
    finishedAt: null,
    lastError: null,
    publicationId: null,
  };
  await store.saveJob(job);
  store.resetIo();
  return { dir, store, jobId, sourceId };
}

function hotWriteBytes(store: IoMeterStore): number {
  return store.writes.reduce((sum, e) => sum + e.bytes, 0);
}

function hotReadBytesExceptWholeJob(store: IoMeterStore): number {
  return store.reads.filter((e) => e.method !== 'getJob').reduce((sum, e) => sum + e.bytes, 0);
}

test('详情页落盘后崩溃：重启复用原页，半成品不可发布，单页 IO 不随完成数增长', async (t) => {
  const small = await seedScenario(8);
  const large = await seedScenario(48);
  t.after(async () => {
    await rm(small.dir, { recursive: true, force: true });
    await rm(large.dir, { recursive: true, force: true });
  });

  async function crashAdvance(scenario: { store: IoMeterStore; jobId: string }) {
    const crawl = new CrawlService(scenario.store, new MockFetcher(createMockState()));
    await assert.rejects(crawl.run(scenario.jobId), /simulated process exit/);
    return {
      saveJobWrites: scenario.store.writes.filter((e) => e.method === 'saveJob').length,
      writeBytes: hotWriteBytes(scenario.store),
      readBytes: hotReadBytesExceptWholeJob(scenario.store),
    };
  }

  const crashSmall = await crashAdvance(small);
  const crashLarge = await crashAdvance(large);
  assert.equal(crashSmall.saveJobWrites, 0);
  assert.equal(crashLarge.saveJobWrites, 0);
  assert.ok(Math.abs(crashLarge.writeBytes - crashSmall.writeBytes) < 1024, JSON.stringify({ crashSmall, crashLarge }));
  assert.ok(Math.abs(crashLarge.readBytes - crashSmall.readBytes) < 1024, JSON.stringify({ crashSmall, crashLarge }));

  // 崩溃后、重启前：当前条目没有提交 record，发布闸门必须拒绝且无发布历史。
  const halfJob = await large.store.getJob(large.jobId);
  const target = halfJob?.entries.at(-1);
  assert.equal(target?.status, 'pending');
  assert.equal(target?.record, null);
  const publish = new PublishService(large.store);
  const decision = await publish.evaluate(large.jobId, RULE_V1);
  assert.equal(decision.allowed, false);
  assert.ok(decision.reasons.some((r) => r.includes('未完成条目')));
  await assert.rejects(publish.publish(large.jobId, RULE_V1));
  assert.equal((await large.store.listPublications(`src-scale-48`)).length, 0);

  async function rebootAndRecover(scenario: { dir: string; jobId: string; sourceId: string }) {
    const rebootStore = new IoMeterStore(scenario.dir);
    await rebootStore.init();
    const fetcher = new CountingMockFetcher(createMockState());
    const reboot = new CrawlService(rebootStore, fetcher);
    const resumed = await reboot.startOrResume({
      sourceId: scenario.sourceId,
      seedUrl: MOCK_URLS.list,
      rule: RULE_V1,
    });
    assert.equal(resumed.jobId, scenario.jobId);
    assert.equal(rebootStore.reads.some((e) => e.method === 'listJobs'), false);
    const job = await reboot.run(scenario.jobId);
    const metrics = {
      status: job.status,
      done: job.entries.filter((e) => e.status === 'done').length,
      total: job.entries.length,
      page1Fetches: fetcher.requested.filter((u) => u === MOCK_URLS.detailA1).length,
      page2Fetches: fetcher.requested.filter((u) => u === MOCK_URLS.detailA2).length,
      saveJobWrites: rebootStore.writes.filter((e) => e.method === 'saveJob').length,
      writeBytes: hotWriteBytes(rebootStore),
      readBytes: hotReadBytesExceptWholeJob(rebootStore),
    };
    const reloaded = await rebootStore.getJob(scenario.jobId);
    return { metrics, reloaded };
  }

  const recoveredSmall = await rebootAndRecover(small);
  const recoveredLarge = await rebootAndRecover(large);
  for (const recovered of [recoveredSmall, recoveredLarge]) {
    assert.equal(recovered.metrics.status, 'completed');
    assert.equal(recovered.metrics.done, recovered.metrics.total);
    assert.equal(recovered.metrics.page1Fetches, 0, '崩溃前已保存的第一页不应重新抓取');
    assert.equal(recovered.metrics.page2Fetches, 1);
    assert.equal(recovered.metrics.saveJobWrites, 0);
    assert.equal(recovered.reloaded?.status, 'completed');
    assert.equal(recovered.reloaded?.entries.every((e) => e.status === 'done' && e.record), true);
  }

  assert.ok(
    Math.abs(recoveredLarge.metrics.writeBytes - recoveredSmall.metrics.writeBytes) < 2048,
    JSON.stringify(recoveredSmall.metrics, null, 2) + JSON.stringify(recoveredLarge.metrics, null, 2),
  );
  assert.ok(
    Math.abs(recoveredLarge.metrics.readBytes - recoveredSmall.metrics.readBytes) < 2048,
    JSON.stringify(recoveredSmall.metrics, null, 2) + JSON.stringify(recoveredLarge.metrics, null, 2),
  );
});

test('真实进程在原页保存成功后退出：新进程复用该页并完成', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-real-crash-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const child = spawn(process.execPath, ['--import', 'tsx', crashHelper, dir], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
  const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.ok(exitInfo.signal === 'SIGKILL' || exitInfo.code === 137, JSON.stringify(exitInfo));

  const crashedStore = new EmbeddedStore(dir);
  await crashedStore.init();
  const jobs = await crashedStore.listJobs();
  assert.equal(jobs.length, 1);
  const jobId = jobs[0]!.jobId;
  const halfJob = await crashedStore.getJob(jobId);
  assert.equal(halfJob?.entries[0]?.status, 'pending');
  assert.equal(halfJob?.entries[0]?.record, null);

  const rebootStore = new IoMeterStore(dir);
  await rebootStore.init();
  const fetcher = new CountingMockFetcher(createMockState());
  const reboot = new CrawlService(rebootStore, fetcher);
  const completed = await reboot.run(jobId);

  assert.equal(completed.status, 'completed');
  assert.equal(completed.entries.length, 4);
  assert.equal(fetcher.requested.filter((u) => u === MOCK_URLS.detailA1).length, 0);
  assert.ok(fetcher.requested.includes(MOCK_URLS.detailA2));
  assert.equal(await new PublishService(rebootStore).current('src-real-page-crash'), null);
});

test('无列表分页时也先持久化完整条目索引，预算中断后不会提前 completed', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'collector-no-list-page-'));
  t.after(async () => rm(dir, { recursive: true, force: true }));

  const store = new EmbeddedStore(dir);
  await store.init();
  const rule: RuleDocument = structuredClone(RULE_V1);
  rule.ruleId = 'rule-no-list-pagination';
  rule.version = '1.0.0';
  delete rule.list?.pagination;
  await store.saveRule(rule);

  const crawl = new CrawlService(store, new MockFetcher(createMockState()));
  const started = await crawl.startOrResume({ sourceId: 'src-no-list-page', seedUrl: MOCK_URLS.list, rule });
  await crawl.run(started.jobId, { maxEntriesPerCall: 1 });

  const midway = await store.getJob(started.jobId);
  assert.equal(midway?.entries.length, 4);
  assert.equal(midway.entries.filter((e) => e.status === 'done').length, 1);
  assert.equal(midway.status, 'running');

  const reboot = new CrawlService(new EmbeddedStore(dir), new MockFetcher(createMockState()));
  const resumed = await reboot.startOrResume({ sourceId: 'src-no-list-page', seedUrl: MOCK_URLS.list, rule });
  assert.equal(resumed.jobId, started.jobId);
  const done = await reboot.run(started.jobId);
  assert.equal(done.status, 'completed');
  assert.equal(done.entries.length, 4);
});
