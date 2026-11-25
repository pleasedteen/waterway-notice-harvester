/**
 * 逐页归并检查点测试：
 *  - 在线逐页提交与离线整批归并共用同一归并器，结果（含证据语义）一致；
 *  - 检查点"提交前 / 提交后"中断均可恢复，最终结果与无中断运行 deepEqual；
 *  - 新检查点恢复时不读已归并原页（getSnapshot 只可能命中尚未归并的页）；
 *  - 持续新增记录的等长续页下，检查点累计实际写入量随页数线性增长；
 *  - 升级前旧作业（无 mergedPageCount）按原 jobId 续跑成功；
 *  - 不具备新分片方法的旧 Store 包装器经快照信封回退同样正确。
 *
 * 全程使用 src/mock/site.ts 的内置静态模拟站点 StaticFetcher + 临时 EmbeddedStore。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedStore } from '../src/storage/embedded-store.js';
import { CrawlService } from '../src/service/crawl-service.js';
import { StaticFetcher, MockFetcher, createMockState, MOCK_URLS } from '../src/mock/site.js';
import { RULE_V1 } from '../src/core/rule-catalog.js';
import {
  mergeDetailPages,
  createDetailMergeState,
  mergeFragmentIntoState,
  extractDetailPage,
  extractFromSnapshots,
  type PageDocument,
} from '../src/core/extractor.js';
import { rawSnapshotIdOf } from '../src/core/merge-checkpoint.js';
import type {
  BusinessRecord,
  CrawlJob,
  RuleDocument,
  Snapshot,
  Store,
} from '../src/core/types.js';

/* ------------------------------ 长等长续页模拟站点 ------------------------------ */

const BASE = 'http://long.mock';
const LIST_URL = `${BASE}/list`;

function detailUrl(page: number, pages: number, rows: number): string {
  return `${BASE}/detail?page=${page}&pages=${pages}&rows=${rows}`;
}

function listHtml(pages: number, rows: number): string {
  return `<html><body><ul>
    <li class="item"><span class="no">G-LONG</span>
      <a class="detail-link" href="${detailUrl(1, pages, rows)}">滚动长公告</a></li>
  </ul></body></html>`;
}

/** 每一页都是等长结构、但每行身份全新（持续新增记录），共 pages 页 × rows 行 */
function detailHtml(page: number, pages: number, rows: number): string {
  const trs = Array.from({ length: rows }, (_, i) => {
    const code = `P${page}-R${String(i + 1).padStart(3, '0')}`;
    return `<tr><td>${code}</td><td>第${page}页指标${i + 1}</td><td>${10000 + page * 100 + i}</td></tr>`;
  }).join('\n');
  const pager =
    page < pages
      ? `<nav class="pager"><a class="next" href="${detailUrl(page + 1, pages, rows)}">下一页</a></nav>`
      : `<nav class="pager"><span class="next disabled">没有下一页</span></nav>`;
  return `<!doctype html><html><body><article>
    <h1 class="title">滚动长公告</h1>
    <span id="notice-no">G-LONG</span>
    <p class="segment-name">统一测试段</p>
    <table class="limit-table">
      <thead><tr><th>编号</th><th>名称</th><th>数值</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
    ${pager}
  </article></body></html>`;
}

const LONG_RULE: RuleDocument = {
  ruleId: 'rule-long',
  version: '1.0.0',
  name: '长续页线性写入测试规则',
  createdAt: '2026-11-20T00:00:00.000Z',
  identity: ['noticeNo', 'segmentName'],
  list: { itemLinkSelector: 'a.detail-link', itemRootSelector: 'li.item' },
  pagination: {
    nextSelector: 'nav.pager a.next',
    disabledSelector: 'nav.pager span.next.disabled',
    maxPages: 64,
  },
  fields: [
    { field: 'noticeNo', type: 'string', selector: '#notice-no' },
    { field: 'segmentName', type: 'string', selector: '.segment-name' },
  ],
  nested: [
    {
      kind: 'table',
      field: 'rows',
      selector: 'table.limit-table',
      headerRows: 1,
      columns: { 编号: 'code', 名称: 'name', 数值: 'metric' },
      fieldRules: { metric: { type: 'number' } },
      itemIdentity: ['code'],
    },
  ],
};

function buildSite(pages: number, rows: number): StaticFetcher {
  const f = new StaticFetcher();
  f.add(LIST_URL, listHtml(pages, rows), 'v1');
  for (let p = 1; p <= pages; p += 1) f.add(detailUrl(p, pages, rows), detailHtml(p, pages, rows), 'v1');
  return f;
}

async function newTempStore(): Promise<{ dir: string; store: EmbeddedStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'collector-cp-'));
  const store = new EmbeddedStore(dir);
  await store.init();
  await store.saveRule(LONG_RULE);
  return { dir, store };
}

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function cleanDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'collector-cp-'));
  dirs.push(dir);
  return dir;
}

/** 无中断完整跑一遍，作为恢复结果的对照基准 */
async function uninterruptedRecord(pages: number, rows: number, sourceId: string): Promise<BusinessRecord> {
  const dir = await cleanDir();
  const store = new EmbeddedStore(dir);
  await store.init();
  await store.saveRule(LONG_RULE);
  const crawl = new CrawlService(store, buildSite(pages, rows));
  const job = await crawl.startOrResume({ sourceId, seedUrl: LIST_URL, rule: LONG_RULE });
  const done = await crawl.run(job.jobId);
  assert.equal(done.status, 'completed', done.lastError ?? '');
  return done.entries[0]!.record!;
}

/* ------------------------------- 计量存储 ------------------------------- */

interface WriteStat {
  method: string;
  bytes: number;
}

/** 真实计量 EmbeddedStore 每次原子写序列化字节数（与 atomicWriteJson 落盘字节同口径，缩进差异为常数） */
class MeterStore extends EmbeddedStore {
  writeBytes = 0;
  writes: WriteStat[] = [];
  snapshotReads: string[] = [];
  snapshotWrites: string[] = [];

  private count(method: string, value: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(value, null, 2), 'utf8');
    this.writeBytes += bytes;
    this.writes.push({ method, bytes });
  }

  override async saveJob(job: CrawlJob): Promise<void> {
    this.count('saveJob', job);
    await super.saveJob(job);
  }
  override async saveSnapshot(s: Snapshot): Promise<void> {
    this.count('saveSnapshot', s);
    this.snapshotWrites.push(s.snapshotId);
    await super.saveSnapshot(s);
  }
  override async saveMergeChunk(chunk: import('../src/core/types.js').MergeChunkDoc): Promise<void> {
    this.count('saveMergeChunk', chunk);
    await super.saveMergeChunk(chunk);
  }
  override async getSnapshot(id: string): Promise<Snapshot | null> {
    this.snapshotReads.push(id);
    return super.getSnapshot(id);
  }

  /** 仅作业文档的累计写入字节 */
  get jobWriteBytes(): number {
    return this.writes.filter((w) => w.method === 'saveJob').reduce((s, w) => s + w.bytes, 0);
  }
}

class CrashError extends Error {}

/** 在第 target 页归并提交点注入"提交前/提交后"崩溃 */
class CrashStore extends MeterStore {
  constructor(
    dir: string,
    public mode: 'before' | 'after',
    public targetPage = 3,
  ) {
    super(dir);
  }

  override async saveJob(job: CrawlJob): Promise<void> {
    const e = job.entries[0];
    if (e && (e as { mergedPageCount?: number }).mergedPageCount === this.targetPage) {
      if (this.mode === 'before') {
        // 提交前中断：不落盘本次 saveJob
        throw new CrashError(`crash before commit page ${this.targetPage}`);
      }
      await super.saveJob(job); // 提交后中断：先让提交真正落盘
      throw new CrashError(`crash after commit page ${this.targetPage}`);
    }
    return super.saveJob(job);
  }
}

/* --------------------------------- 测试 --------------------------------- */

test('归并器：逐页片段折叠（经 JSON 检查点往返）与整批 mergeDetailPages/deepEqual', () => {
  const P = 6;
  const pages: PageDocument[] = [];
  const snaps: Snapshot[] = [];
  for (let p = 1; p <= P; p += 1) {
    const html = detailHtml(p, P, 4);
    const url = detailUrl(p, P, 4);
    pages.push({ url, html, page: p });
    snaps.push({
      snapshotId: `s${p}`, sourceId: 'x', revision: 'v1', url, fetchedAt: '',
      statusCode: 200, contentType: 'text/html', html,
    });
  }

  const whole = mergeDetailPages(pages, LONG_RULE);
  const fromSnaps = extractFromSnapshots(snaps, LONG_RULE);
  assert.deepEqual(fromSnaps, whole);

  // 模拟在线：抽取片段 -> JSON 往返（分片落盘/读回）-> 用共享折叠器归并
  const state = createDetailMergeState();
  for (const p of pages) {
    const fragment = extractDetailPage(p, LONG_RULE);
    const restored = JSON.parse(JSON.stringify(fragment)) as BusinessRecord;
    mergeFragmentIntoState(state, restored);
  }
  assert.ok(state.record);
  assert.deepEqual(state.record, whole);
  assert.deepEqual(state.pageNumbers, [1, 2, 3, 4, 5, 6]);
  assert.equal(whole.nested.rows?.items.length, P * 4);
});

test('写入量：等长持续新增续页的累计检查点写入随页数线性增长', async () => {
  async function measure(P: number): Promise<{ total: number; jobs: number }> {
    const dir = await cleanDir();
    const store = new MeterStore(dir);
    await store.init();
    await store.saveRule(LONG_RULE);
    const crawl = new CrawlService(store, buildSite(P, 8));
    const job = await crawl.startOrResume({ sourceId: `src-linear-${P}`, seedUrl: LIST_URL, rule: LONG_RULE });
    const done = await crawl.run(job.jobId);
    assert.equal(done.status, 'completed', done.lastError ?? '');
    assert.equal(done.entries[0]!.record!.nested.rows?.items.length, P * 8);
    return { total: store.writeBytes, jobs: store.jobWriteBytes };
  }

  const m8 = await measure(8);
  const m16 = await measure(16);

  // 线性（含固定一次性开销时 16/8 通常 <=2）；二次方膨胀会接近 4。
  assert.ok(
    m16.total <= m8.total * 2.6 + 20_000,
    `总写入量疑似非线性: W8=${m8.total} W16=${m16.total} ratio=${(m16.total / m8.total).toFixed(2)}`,
  );
  assert.ok(
    m16.jobs <= m8.jobs * 2.6 + 20_000,
    `saveJob 累计写入疑似非线性: J8=${m8.jobs} J16=${m16.jobs} ratio=${(m16.jobs / m8.jobs).toFixed(2)}`,
  );
  // 明确排除二次方：16 页相对 8 页的增量不应超过 8 页基准的 ~1.8 倍
  assert.ok(m16.total - m8.total < m8.total * 1.8, '增量写入随页数超线性');
});

test('写入量：单个长作业的逐页提交 saveJob 大小不随累计页数膨胀', async () => {
  const P = 20;
  const dir = await cleanDir();

  /** 记录每次 saveJob 时的作业字节与游标，证明提交点大小近似常数 */
  class SizeProbe extends MeterStore {
    commitPoints: { cursor: number; bytes: number; hasRecord: boolean; idCount: number }[] = [];
    override async saveJob(job: CrawlJob): Promise<void> {
      const e = job.entries[0] as (typeof job.entries)[number] & { mergedPageCount?: number };
      if (e && typeof e.mergedPageCount === 'number' && !e.record) {
        this.commitPoints.push({
          cursor: e.mergedPageCount,
          bytes: Buffer.byteLength(JSON.stringify(job), 'utf8'),
          hasRecord: !!e.record,
          idCount: e.snapshotIds.length,
        });
      }
      return super.saveJob(job);
    }
  }

  const store = new SizeProbe(dir);
  await store.init();
  await store.saveRule(LONG_RULE);
  const crawl = new CrawlService(store, buildSite(P, 6));
  const job = await crawl.startOrResume({ sourceId: 'src-flat', seedUrl: LIST_URL, rule: LONG_RULE });
  await crawl.run(job.jobId);

  const pts = store.commitPoints.filter((p) => p.cursor >= 1 && p.cursor <= P);
  assert.equal(pts.length, P, `应有 ${P} 个逐页提交点，实际 ${pts.length}`);
  const first = pts[0]!.bytes;
  const last = pts[P - 1]!.bytes;
  // 第 20 页提交的作业文档不应比第 1 页大出一整页累计记录（允许标量 pagesMerged 的微小增长）
  assert.ok(
    last - first < 4000,
    `逐页提交作业大小膨胀: first=${first} last=${last} delta=${last - first}`,
  );
  // 热路径不把不断增长的 snapshotIds 塞进每次提交（终态才回填），保证严格线性
  assert.ok(pts.every((p) => p.idCount === 0), '逐页提交不应携带增长的 snapshotIds 数组');
});

for (const mode of ['before', 'after'] as const) {
  test(`中断恢复：检查点提交${mode === 'before' ? '前' : '后'}崩溃，恢复结果一致且不读已归并原页`, async () => {
    const P = 6;
    const R = 5;
    const target = 3;
    const sourceId = `src-crash-${mode}`;
    const dir = await cleanDir();

    // ---- 第一次：在第 target 页提交点崩溃 ----
    const crashed = new CrashStore(dir, mode, target);
    await crashed.init();
    await crashed.saveRule(LONG_RULE);
    const crawl1 = new CrawlService(crashed, buildSite(P, R));
    const job = await crawl1.startOrResume({ sourceId, seedUrl: LIST_URL, rule: LONG_RULE });
    await assert.rejects(() => crawl1.run(job.jobId), /crash (before|after) commit/);

    const onDisk = await crashed.getJob(job.jobId);
    assert.ok(onDisk, '作业仍在原编号下持久化');
    const diskCursor = (onDisk!.entries[0] as { mergedPageCount?: number }).mergedPageCount ?? 0;
    assert.equal(diskCursor, mode === 'before' ? target - 1 : target, '磁盘游标应反映崩溃时机');

    // ---- "重启"：新计量存储实例指向同一目录，只靠磁盘检查点 ----
    const reboot = new MeterStore(dir);
    await reboot.init();
    const crawl2 = new CrawlService(reboot, buildSite(P, R));
    const resumed = await crawl2.startOrResume({ sourceId, seedUrl: LIST_URL, rule: LONG_RULE });
    assert.equal(resumed.jobId, job.jobId, '必须按原作业编号续跑');
    const done = await crawl2.run(job.jobId);
    assert.equal(done.status, 'completed', done.lastError ?? '');

    // 恢复期间 getSnapshot 绝不允许请求已归并页的确定性原快照 id
    const mergedRawIds = new Set(
      Array.from({ length: diskCursor }, (_, i) => rawSnapshotIdOf(job.jobId, 'e0', i + 1)),
    );
    for (const id of reboot.snapshotReads) {
      assert.ok(!mergedRawIds.has(id), `恢复时重读了已归并原页: ${id}`);
    }
    // 读取的原快照（若有）只能是游标之后尚未归并的页
    for (const id of reboot.snapshotReads) {
      const m = id.match(/_p(\d+)$/);
      if (m) assert.ok(Number(m[1]) > diskCursor, `读取了游标内页面 p${m[1]}（cursor=${diskCursor}）`);
    }

    // ---- 结果与无中断基准 deepEqual ----
    const expected = await uninterruptedRecord(P, R, `src-expected-${mode}`);
    const actual = done.entries[0]!.record!;
    assert.equal(actual.nested.rows?.items.length, P * R);
    assert.deepEqual(actual, expected);
  });
}

test('升级兼容：无 mergedPageCount 的旧作业按原 jobId 续跑，只读旧 snapshotIds 后补齐', async () => {
  const P = 3;
  const R = 4;
  const sourceId = 'src-legacy';
  const dir = await cleanDir();
  const store = new MeterStore(dir);
  await store.init();
  await store.saveRule(LONG_RULE);

  // 模拟升级前代码：已抓前 2 页、随机快照 id、record=null、无新游标字段
  const fetcher = buildSite(P, R);
  const oldIds: string[] = [];
  for (const p of [1, 2]) {
    const page = await fetcher.fetch(detailUrl(p, P, R));
    const sid = `snap_old_random_${p}_${Math.random().toString(36).slice(2, 8)}`;
    await store.saveSnapshot({
      snapshotId: sid, sourceId, revision: 'v1', url: detailUrl(p, P, R),
      fetchedAt: new Date().toISOString(), statusCode: 200, contentType: page.contentType, html: page.html,
    });
    oldIds.push(sid);
  }
  const legacyJobId = 'job_legacy_fixed_number_0001';
  const now = new Date().toISOString();
  const legacy: CrawlJob = {
    jobId: legacyJobId,
    sourceId,
    seedUrl: LIST_URL,
    ruleId: LONG_RULE.ruleId,
    ruleVersion: LONG_RULE.version,
    expectedRevision: 'v1',
    status: 'running',
    listSnapshotIds: [],
    entries: [
      {
        entryUrl: detailUrl(1, P, R),
        prefetch: {},
        status: 'pending',
        snapshotIds: oldIds,
        pagesMerged: [],
        record: null,
        attempts: 1,
        lastError: null,
        updatedAt: now,
      },
    ],
    createdAt: now,
    updatedAt: now,
    finishedAt: null,
    lastError: null,
    publicationId: null,
  };
  await store.saveJob(legacy);

  const crawl = new CrawlService(store, fetcher);
  const same = await crawl.startOrResume({ sourceId, seedUrl: LIST_URL, rule: LONG_RULE });
  assert.equal(same.jobId, legacyJobId, '升级前未完成作业必须可按原编号找到');
  const done = await crawl.run(legacyJobId);
  assert.equal(done.status, 'completed', done.lastError ?? '');
  const e = done.entries[0]!;
  assert.equal(e.record!.nested.rows?.items.length, P * R);
  assert.deepEqual(e.snapshotIds.slice(0, 2), oldIds, '旧随机快照 id 必须保留');
  assert.equal(e.snapshotIds.length, P);
  assert.deepEqual(e.pagesMerged, [1, 2, 3]);

  const expected = await uninterruptedRecord(P, R, 'src-legacy-expected');
  assert.deepEqual(e.record, expected);
});

test('在线产物与离线回放（从 entry.snapshotIds 读原快照 + 共享归并器）一致', async () => {
  const P = 4;
  const R = 6;
  const dir = await cleanDir();
  const store = new EmbeddedStore(dir);
  await store.init();
  await store.saveRule(LONG_RULE);
  const crawl = new CrawlService(store, buildSite(P, R));
  const job = await crawl.startOrResume({ sourceId: 'src-equiv', seedUrl: LIST_URL, rule: LONG_RULE });
  const done = await crawl.run(job.jobId);
  assert.equal(done.status, 'completed');
  const entry = done.entries[0]!;

  const snaps: Snapshot[] = [];
  for (const sid of entry.snapshotIds) {
    const s = await store.getSnapshot(sid);
    assert.ok(s, `原快照必须可读: ${sid}`);
    snaps.push(s!);
  }
  const offline = extractFromSnapshots(snaps, LONG_RULE);
  // 在线记录仅可能额外合入列表预取字段；本规则无预取，应严格 deepEqual。
  assert.deepEqual(entry.record, offline);
});

test('无 list 配置：seedUrl 直接作为单条详情，逐页归并与恢复同样成立', async () => {
  const P = 4;
  const R = 2;
  const dir = await cleanDir();
  const store = new MeterStore(dir);
  await store.init();
  const directRule: RuleDocument = { ...LONG_RULE, list: undefined };
  await store.saveRule(directRule);
  const seed = detailUrl(1, P, R);
  const f = new StaticFetcher();
  for (let p = 1; p <= P; p += 1) f.add(detailUrl(p, P, R), detailHtml(p, P, R), 'v1');

  const crawl = new CrawlService(store, f);
  const job = await crawl.startOrResume({ sourceId: 'src-direct', seedUrl: seed, rule: directRule });
  const done = await crawl.run(job.jobId);
  assert.equal(done.status, 'completed', done.lastError ?? '');
  assert.equal(done.entries.length, 1);
  assert.equal(done.entries[0]!.record!.nested.rows?.items.length, P * R);

  // 重启后作业已 completed，直接返回；记录仍可读取
  const reboot = new CrawlService(new MeterStore(dir), f);
  const again = await reboot.run(job.jobId);
  assert.equal(again.status, 'completed');
  assert.equal(again.entries[0]!.record!.nested.rows?.items.length, P * R);
});

test('穷尽故障点：在任意第 N 次 saveJob/saveSnapshot 一次性抛错后都能恢复且结果一致', async () => {
  const P = 5;
  const R = 2;
  const expected = await uninterruptedRecord(P, R, 'src-fault-sweep-expected');

  for (const method of ['saveJob', 'saveSnapshot'] as const) {
    // 先估算调用次数上界：完整跑一遍计数
    const countDir = await cleanDir();
    const counter = new MeterStore(countDir);
    await counter.init();
    await counter.saveRule(LONG_RULE);
    const countCrawl = new CrawlService(counter, buildSite(P, R));
    const cj = await countCrawl.startOrResume({ sourceId: `src-count-${method}`, seedUrl: LIST_URL, rule: LONG_RULE });
    await countCrawl.run(cj.jobId);
    const totalCalls = counter.writes.filter((w) => w.method === method).length;

    for (let n = 1; n <= totalCalls; n += 1) {
      const dir = await cleanDir();
      class OnceFault extends MeterStore {
        armed = false;
        jobCalls = 0;
        snapCalls = 0;
        override async saveJob(job: CrawlJob): Promise<void> {
          if (this.armed && method === 'saveJob' && ++this.jobCalls === n) throw new Error(`one-shot kill saveJob#${n}`);
          return super.saveJob(job);
        }
        override async saveSnapshot(s: Snapshot): Promise<void> {
          if (this.armed && method === 'saveSnapshot' && ++this.snapCalls === n) throw new Error(`one-shot kill saveSnapshot#${n}`);
          return super.saveSnapshot(s);
        }
      }
      const faulty = new OnceFault(dir);
      await faulty.init();
      await faulty.saveRule(LONG_RULE);
      const crawl1 = new CrawlService(faulty, buildSite(P, R));
      const job = await crawl1.startOrResume({ sourceId: `src-sweep-${method}-${n}`, seedUrl: LIST_URL, rule: LONG_RULE });
      faulty.armed = true;
      try {
        await crawl1.run(job.jobId);
      } catch {
        /* 模拟进程崩溃：调用方可能收到 reject，也可能收到 failed，均可重启 */
      }

      const rebootStore = new MeterStore(dir);
      await rebootStore.init();
      const crawl2 = new CrawlService(rebootStore, buildSite(P, R));
      let done = await crawl2.run(job.jobId);
      if (done.status !== 'completed') {
        // 一次性故障可能把条目标为 failed，再推进一次即可
        done = await crawl2.run(job.jobId);
      }
      assert.equal(done.status, 'completed', `[${method}#${n}] ${done.lastError ?? ''}`);
      assert.deepEqual(done.entries[0]!.record, expected, `[${method}#${n}] 恢复结果不一致`);
    }
  }
});

test('Store 兼容：Proxy 计量 + 屏蔽新分片方法（快照信封回退）仍可逐页提交恢复', async () => {
  const P = 5;
  const R = 3;
  const dir = await cleanDir();
  const inner = new EmbeddedStore(dir);
  await inner.init();
  await inner.saveRule(LONG_RULE);

  // 通用 Proxy 计量所有 save*/commit* 入参字节，并屏蔽新方法模拟旧 Store 包装器
  let bytes = 0;
  const proxy = new Proxy(inner, {
    get(target, prop, receiver) {
      if (prop === 'saveMergeChunk' || prop === 'getMergeChunk') return undefined;
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      return async (...args: unknown[]) => {
        if (/^save|^commit/.test(String(prop))) {
          bytes += args.reduce<number>((s, a) => s + Buffer.byteLength(JSON.stringify(a), 'utf8'), 0);
        }
        return Reflect.apply(v as (...a: unknown[]) => unknown, target, args);
      };
    },
  }) as unknown as Store;

  const crawl = new CrawlService(proxy, buildSite(P, R));
  const job = await crawl.startOrResume({ sourceId: 'src-proxy', seedUrl: LIST_URL, rule: LONG_RULE });
  const done = await crawl.run(job.jobId);
  assert.equal(done.status, 'completed', done.lastError ?? '');
  assert.equal(done.entries[0]!.record!.nested.rows?.items.length, P * R);
  assert.ok(bytes > 0);

  // 同一目录重启（这次恢复原生分片能力也应能读回快照信封路径产生的游标结果）
  const reboot = new CrawlService(new EmbeddedStore(dir), buildSite(P, R));
  const again = await reboot.run(job.jobId);
  assert.equal(again.status, 'completed');
});

test('内置 MockFetcher + RULE_V1：A 公告第 2 页提交前/后中断，重启结果与干净运行一致', async () => {
  // 干净基准
  const expectedDir = await cleanDir();
  const expectedStore = new EmbeddedStore(expectedDir);
  await expectedStore.init();
  await expectedStore.saveRule(RULE_V1);
  const expectedCrawl = new CrawlService(expectedStore, new MockFetcher(createMockState()));
  const ejob = await expectedCrawl.startOrResume({ sourceId: 'mock-cp-expected', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  const expectedDone = await expectedCrawl.run(ejob.jobId);
  assert.equal(expectedDone.status, 'completed');
  const expectedRecords = expectedDone.entries.map((e) => e.record);

  for (const mode of ['before', 'after'] as const) {
    const sourceId = `mock-cp-${mode}`;
    const dir = await cleanDir();
    const crash = new (class extends MeterStore {
      override async saveJob(job: CrawlJob): Promise<void> {
        const a = job.entries[0] as (typeof job.entries)[number] & { mergedPageCount?: number };
        if (a?.entryUrl.includes('G2026-018') && a.mergedPageCount === 2) {
          if (mode === 'before') throw new Error('kill before A p2 commit');
          await super.saveJob(job);
          throw new Error('kill after A p2 commit');
        }
        return super.saveJob(job);
      }
    })(dir);
    await crash.init();
    await crash.saveRule(RULE_V1);
    const c1 = new CrawlService(crash, new MockFetcher(createMockState()));
    const job = await c1.startOrResume({ sourceId, seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    await assert.rejects(() => c1.run(job.jobId), /kill (before|after) A p2/);

    const disk = await crash.getJob(job.jobId);
    const cursor = (disk!.entries[0] as { mergedPageCount?: number }).mergedPageCount ?? 0;
    assert.equal(cursor, mode === 'before' ? 1 : 2);

    const rebootStore = new MeterStore(dir);
    await rebootStore.init();
    const c2 = new CrawlService(rebootStore, new MockFetcher(createMockState()));
    const same = await c2.startOrResume({ sourceId, seedUrl: MOCK_URLS.list, rule: RULE_V1 });
    assert.equal(same.jobId, job.jobId);
    const done = await c2.run(job.jobId);
    assert.equal(done.status, 'completed', done.lastError ?? '');
    assert.deepEqual(done.entries.map((e) => e.record), expectedRecords);

    // A 公告已归并的原页不得在恢复时被 getSnapshot 重读
    const mergedIds = new Set(
      Array.from({ length: cursor }, (_, i) => rawSnapshotIdOf(job.jobId, 'e0', i + 1)),
    );
    for (const id of rebootStore.snapshotReads) assert.ok(!mergedIds.has(id), `重读已归并原页 ${id}`);
  }
});
