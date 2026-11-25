/**
 * 采集编排：
 * - 详情抽取是"逐页提交 + 可恢复"的归并流程：每页片段写归并分片并推进游标；
 *   恢复时只折叠分片、只读尚未归并的原页，累计检查点写入量随页数线性；
 * - 在线逐页归并与离线回放共用 core/extractor 的同一折叠器；
 * - 每个条目/分页完成即落检查点，进程重启后从断点继续，旧检查点按原作业编号迁移；
 * - 全程校验来源 revision，发现换版 => 作业置 edition_changed 并阻断发布；
 * - 分页失败不丢弃已采页，条目标 failed 且整批不完整；
 * - "未采到"绝不解释为删除：只有整批成功完成才可发布，发布集仅来自本批记录。
 */
import { contentHash, type Fetcher } from '../fetch/fetcher.js';
import {
  extractListEntries,
  extractNextPage,
  extractDetailPage,
  createDetailMergeState,
  mergeFragmentIntoState,
  type PageDocument,
} from '../core/extractor.js';
import {
  ChunkBackend,
  chunkIdOf,
  entryKeyOf,
  rawSnapshotIdOf,
} from '../core/merge-checkpoint.js';
import { newId, nowIso } from '../core/ids.js';
import type {
  BusinessRecord,
  CrawlJob,
  JobEntryState,
  MergeChunkDoc,
  RuleDocument,
  Snapshot,
  Store,
} from '../core/types.js';

export interface StartJobInput {
  sourceId: string;
  seedUrl: string;
  rule: RuleDocument;
  expectedRevision?: string;
}

export class CrawlService {
  constructor(
    private readonly store: Store,
    private readonly fetcher: Fetcher,
  ) {}

  /** 启动新作业；若存在同来源同规则的未完成作业，直接返回它（重启续跑入口） */
  async startOrResume(input: StartJobInput): Promise<CrawlJob> {
    const existing = await this.findResumable(input.sourceId, input.rule.ruleId, input.rule.version);
    if (existing) return existing;

    const first = await this.fetcher.fetch(input.seedUrl);
    const revision = input.expectedRevision ?? first.revision;
    const job: CrawlJob = {
      jobId: newId('job'),
      sourceId: input.sourceId,
      seedUrl: input.seedUrl,
      ruleId: input.rule.ruleId,
      ruleVersion: input.rule.version,
      expectedRevision: revision,
      status: 'running',
      listSnapshotIds: [],
      entries: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
      finishedAt: null,
      lastError: null,
      publicationId: null,
    };
    await this.store.saveJob(job);
    // 无 list 时 seedUrl 即第一条详情的第 1 页：把启动探测抓取复用为 p1 原快照，避免重复抓取。
    if (!input.rule.list) {
      await this.persistSnapshot(job, first, input.seedUrl, rawSnapshotIdOf(job.jobId, entryKeyOf(0), 1));
    }
    return job;
  }

  private async findResumable(sourceId: string, ruleId: string, ruleVersion: string): Promise<CrawlJob | null> {
    const jobs = await this.store.listJobs();
    return (
      jobs.find(
        (j) =>
          j.sourceId === sourceId &&
          j.ruleId === ruleId &&
          j.ruleVersion === ruleVersion &&
          (j.status === 'running' || j.status === 'failed'),
      ) ?? null
    );
  }

  /** 推进作业（可反复调用，每次处理若干条目；崩溃后再次调用即续跑） */
  async run(jobId: string, opts: { maxEntriesPerCall?: number } = {}): Promise<CrawlJob> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`作业不存在: ${jobId}`);
    if (['completed', 'edition_changed', 'aborted'].includes(job.status)) return job;

    const rule = await this.store.getRule(job.ruleId, job.ruleVersion);
    if (!rule) throw new Error(`规则缺失: ${job.ruleId}@${job.ruleVersion}`);

    // 1. 发现列表条目（带列表分页），结果同样检查点化
    if (job.entries.length === 0) {
      try {
        await this.discoverEntries(job, rule);
      } catch (e) {
        job.status = 'failed';
        job.lastError = `列表发现失败: ${(e as Error).message}`;
        job.updatedAt = nowIso();
        await this.store.saveJob(job);
        return job;
      }
    }

    // 2. 逐条采集详情（含续页），跳过已完成
    const budget = opts.maxEntriesPerCall ?? Number.MAX_SAFE_INTEGER;
    let processed = 0;
    for (const entry of job.entries) {
      if (entry.status === 'done') continue;
      if (processed >= budget) break;
      processed += 1;
      await this.crawlEntry(job, rule, entry);
      if (job.status === 'edition_changed') {
        await this.store.saveJob(job);
        return job;
      }
    }

    // 3. 整批改判：所有条目 done 才能 completed
    job.updatedAt = nowIso();
    if (job.entries.every((e) => e.status === 'done')) {
      job.status = 'completed';
      job.finishedAt = nowIso();
    } else if (job.entries.some((e) => e.status === 'failed')) {
      job.status = 'failed';
      job.lastError = job.lastError ?? '存在失败条目，批次不完整';
    }
    await this.store.saveJob(job);
    return job;
  }

  private async discoverEntries(job: CrawlJob, rule: RuleDocument): Promise<void> {
    // 无 list 配置：按 RuleDocument 契约，seedUrl 本身就是单条详情页。
    if (!rule.list) {
      job.entries.push({
        entryUrl: job.seedUrl,
        prefetch: {},
        status: 'pending',
        snapshotIds: [],
        pagesMerged: [],
        record: null,
        attempts: 0,
        lastError: null,
        updatedAt: nowIso(),
      });
      await this.store.saveJob(job);
      return;
    }
    const seen = new Set<string>();
    let listUrl: string | null = job.seedUrl;
    let listPageNo = 0;
    while (listUrl && listPageNo < (rule.list?.pagination?.maxPages ?? 1)) {
      listPageNo += 1;
      const fetched = await this.fetcher.fetch(listUrl);
      this.checkRevision(job, fetched.revision, listUrl);
      if (job.status === 'edition_changed') return;
      const snap = await this.persistSnapshot(job, fetched, listUrl);
      if (!job.listSnapshotIds.includes(snap.snapshotId)) job.listSnapshotIds.push(snap.snapshotId);
      const entries = extractListEntries(snap.html, rule, listUrl);
      for (const e of entries) {
        if (seen.has(e.url)) continue;
        seen.add(e.url);
        job.entries.push({
          entryUrl: e.url,
          prefetch: e.prefetch,
          status: 'pending',
          snapshotIds: [],
          pagesMerged: [],
          record: null,
          attempts: 0,
          lastError: null,
          updatedAt: nowIso(),
        });
      }
      if (!rule.list?.pagination) break;
      listUrl = extractNextPage(snap.html, rule.list.pagination, listUrl);
      await this.store.saveJob(job);
    }
  }

  /**
   * 采集并归并一个条目（逐页提交、可恢复）。
   *
   * 检查点协议：
   *  1. （恢复时）按 entry.mergedPageCount 从归并分片折叠出累计状态，不读已归并原页；
   *  2. 每页：取未归并原页（优先复用同 id 快照，否则联网抓取）-> 抽取单页片段
   *     -> 写该页归并分片 -> 推进 mergedPageCount/nextPageUrl 并 saveJob 提交；
   *  3. 全部页完成后用同一归并器产出 entry.record，补齐 snapshotIds 并置 done。
   *
   * 提交前后中断都安全：
   *  - 提交前中断：游标未前进，恢复时重做该页（确定性分片/快照 id 覆盖写，归并不重复计数）；
   *  - 提交后中断：游标已前进，恢复时只读其后尚未归并的原页/分片。
   */
  private async crawlEntry(job: CrawlJob, rule: RuleDocument, entry: JobEntryState): Promise<void> {
    entry.attempts += 1;
    const entryIndex = job.entries.indexOf(entry);
    // 正常路径条目就在 job.entries 中，使用稳定下标；极端情况下用 URL 哈希避免多条目分片键碰撞。
    const entryKey = entryIndex >= 0 ? entryKeyOf(entryIndex) : `u${stableHash(entry.entryUrl)}`;
    const chunks = new ChunkBackend(this.store, job.sourceId);
    const mergeState = createDetailMergeState();
    /** 已归并页对应的原快照 id（按页序），终态写回 entry.snapshotIds */
    const rawSnapshotIds: string[] = [];

    let mergedCount = 0;
    let nextUrl: string | null = null;

    try {
      if (typeof entry.mergedPageCount === 'number') {
        // 新检查点：只从逐页分片恢复归并状态；绝不 getSnapshot 已归并的原页。
        mergedCount = entry.mergedPageCount;
        for (let p = 1; p <= mergedCount; p += 1) {
          const chunk = await chunks.getChunk(chunkIdOf(job.jobId, entryKey, p));
          if (!chunk) {
            // 分片缺失属于存储不一致；回退到该页原快照重建，仍保证结果正确。
            const rebuilt = await this.rebuildChunkFromRawSnapshot(job, chunks, entry, entryKey, p, rule);
            mergeFragmentIntoState(mergeState, rebuilt.fragment);
            rawSnapshotIds.push(rebuilt.snapshotId);
            continue;
          }
          mergeFragmentIntoState(mergeState, chunk.fragment);
          rawSnapshotIds.push(chunk.snapshotId);
        }
        nextUrl =
          entry.nextPageUrl !== undefined
            ? entry.nextPageUrl
            : mergedCount === 0
              ? entry.entryUrl
              : (await chunks.getChunk(chunkIdOf(job.jobId, entryKey, mergedCount)))?.nextPageUrl ?? null;
      } else {
        // 升级前旧检查点：snapshotIds 中所有原页都尚未经新归并器提交，
        // 读取它们并一次性重建分片/游标（仅升级恢复时发生，按原作业编号续跑）。
        const existingSnaps: Snapshot[] = [];
        for (const sid of entry.snapshotIds) {
          const s = await this.store.getSnapshot(sid);
          if (s) existingSnaps.push(s);
        }
        const pages: PageDocument[] = existingSnaps.map((s, i) => ({
          url: s.url,
          html: s.html,
          page: i + 1,
        }));
        for (const page of pages) {
          const fragment = extractDetailPage(page, rule);
          const following = rule.pagination
            ? extractNextPage(page.html, rule.pagination, page.url)
            : null;
          const chunk: MergeChunkDoc = {
            kind: 'detail-merge-chunk',
            version: 1,
            chunkId: chunkIdOf(job.jobId, entryKey, page.page),
            jobId: job.jobId,
            entryKey,
            page: page.page,
            snapshotId: existingSnaps[page.page - 1]!.snapshotId,
            nextPageUrl: following,
            fragment,
          };
          await chunks.saveChunk(chunk);
          mergeFragmentIntoState(mergeState, fragment);
          rawSnapshotIds.push(chunk.snapshotId);
        }
        mergedCount = pages.length;
        nextUrl =
          pages.length === 0
            ? entry.entryUrl
            : rule.pagination
              ? extractNextPage(pages[pages.length - 1]!.html, rule.pagination, pages[pages.length - 1]!.url)
              : null;
        entry.mergedPageCount = mergedCount;
        entry.nextPageUrl = nextUrl;
      }

      // 逐页抓取/复用未归并原页 -> 抽取 -> 写分片 -> saveJob 提交游标。
      const maxPages = rule.pagination?.maxPages ?? 1;
      let processed = mergedCount;
      while (nextUrl && processed < maxPages) {
        const pageNo = processed + 1;
        processed = pageNo;

        // 优先复用"已抓未归并"的确定性原快照（提交前中断窗口），否则联网抓取。
        const rawId = rawSnapshotIdOf(job.jobId, entryKey, pageNo);
        const existing = await this.store.getSnapshot(rawId);
        let html: string;
        let url: string;
        let snapshotId: string;
        let revision: string;
        if (existing && existing.html) {
          html = existing.html;
          url = existing.url || nextUrl;
          snapshotId = existing.snapshotId;
          revision = existing.revision;
        } else {
          const fetched = await this.fetcher.fetch(nextUrl);
          // 与历史行为一致：先校验 revision，换版直接阻断，不落该页快照/分片。
          this.checkRevision(job, fetched.revision, nextUrl);
          if (job.status === 'edition_changed') return;
          const snap = await this.persistSnapshot(job, fetched, nextUrl, rawId);
          html = snap.html;
          url = nextUrl;
          snapshotId = snap.snapshotId;
          revision = snap.revision;
        }
        this.checkRevision(job, revision, url);
        if (job.status === 'edition_changed') return;

        const page: PageDocument = { url, html, page: pageNo };
        const fragment = extractDetailPage(page, rule);
        const following = rule.pagination ? extractNextPage(html, rule.pagination, url) : null;

        const chunk: MergeChunkDoc = {
          kind: 'detail-merge-chunk',
          version: 1,
          chunkId: chunkIdOf(job.jobId, entryKey, pageNo),
          jobId: job.jobId,
          entryKey,
          page: pageNo,
          snapshotId,
          nextPageUrl: following,
          fragment,
        };
        // 先写本分页分片（每页 O(本页大小)），再以 saveJob 游标推进作为提交点。
        await chunks.saveChunk(chunk);
        mergeFragmentIntoState(mergeState, fragment);
        if (rawSnapshotIds.length < pageNo) rawSnapshotIds.push(snapshotId);
        else rawSnapshotIds[pageNo - 1] = snapshotId;

        mergedCount = pageNo;
        entry.mergedPageCount = mergedCount;
        entry.nextPageUrl = following;
        // 既有字段的轻量可见性：提交后即可见已归并页码（仅标量序号，不承载累计记录）。
        entry.pagesMerged = Array.from({ length: mergedCount }, (_, i) => i + 1);
        await this.store.saveJob(job); // 逐页检查点提交点（作业文档不随页数累积膨胀）

        nextUrl = following;
      }

      // 归并完成：折叠状态即最终记录，再合并预取字段（缺失不覆盖详情页结果）。
      const record: BusinessRecord = mergeState.record ?? (() => {
        throw new Error('归并失败：无可用分页');
      })();
      record.pagesMerged = [...mergeState.pageNumbers];
      for (const [k, v] of Object.entries(entry.prefetch)) {
        if (!record.fields[k] && v.value.status !== 'missing') record.fields[k] = v;
      }
      entry.record = record;
      entry.pagesMerged = [...record.pagesMerged];
      entry.snapshotIds = rawSnapshotIds.slice();
      entry.status = 'done';
      entry.lastError = null;
      entry.nextPageUrl = null;
    } catch (e) {
      // 分页/提交失败：保留已采页面与检查点，条目标 failed，整批不完整。
      // 已得到的原快照 id 尽量写回（旧字段语义：失败时 snapshotIds.length >= 1）。
      if (rawSnapshotIds.length > 0) entry.snapshotIds = rawSnapshotIds.slice();
      entry.status = 'failed';
      entry.lastError = (e as Error).message;
      job.lastError = `条目 ${entry.entryUrl} 采集失败: ${entry.lastError}`;
    }
    entry.updatedAt = nowIso();
    job.updatedAt = nowIso();
    await this.store.saveJob(job);
  }

  /** 分片缺失的防御性重建：按条目 snapshotIds 中的对应原快照重新抽取该页 */
  private async rebuildChunkFromRawSnapshot(
    job: CrawlJob,
    chunks: ChunkBackend,
    entry: JobEntryState,
    entryKey: string,
    page: number,
    rule: RuleDocument,
  ): Promise<MergeChunkDoc> {
    const sid = entry.snapshotIds[page - 1];
    if (!sid) throw new Error(`归并检查点分片缺失且无原快照索引: page ${page}`);
    const snap = await this.store.getSnapshot(sid);
    if (!snap) throw new Error(`归并检查点分片与原快照均缺失: page ${page} (${sid})`);
    const pageDoc: PageDocument = { url: snap.url, html: snap.html, page };
    const fragment = extractDetailPage(pageDoc, rule);
    const chunk: MergeChunkDoc = {
      kind: 'detail-merge-chunk',
      version: 1,
      chunkId: chunkIdOf(job.jobId, entryKey, page),
      jobId: job.jobId,
      entryKey,
      page,
      snapshotId: sid,
      nextPageUrl: rule.pagination ? extractNextPage(snap.html, rule.pagination, snap.url) : null,
      fragment,
    };
    await chunks.saveChunk(chunk);
    return chunk;
  }

  private checkRevision(job: CrawlJob, revision: string, url: string): void {
    if (revision !== job.expectedRevision) {
      job.status = 'edition_changed';
      job.lastError = `检测到换版: 期望 ${job.expectedRevision} 实际 ${revision} @ ${url}`;
      job.updatedAt = nowIso();
    }
  }

  private async persistSnapshot(
    job: CrawlJob,
    fetched: Awaited<ReturnType<Fetcher['fetch']>>,
    url: string,
    explicitId?: string,
  ): Promise<Snapshot> {
    const snapshot: Snapshot = {
      snapshotId: explicitId ?? newId('snap'),
      sourceId: job.sourceId,
      revision: fetched.revision || contentHash(fetched.html),
      url,
      fetchedAt: nowIso(),
      statusCode: fetched.statusCode,
      contentType: fetched.contentType,
      html: fetched.html,
    };
    await this.store.saveSnapshot(snapshot);
    return snapshot;
  }

  /** 作业产出的完整记录（仅 completed 时有意义） */
  async collectRecords(jobId: string): Promise<BusinessRecord[]> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`作业不存在: ${jobId}`);
    return job.entries.filter((e) => e.record).map((e) => e.record!) as BusinessRecord[];
  }
}

/** 非下标的稳定短哈希（仅用于异常引用场景的分片键，不含安全语义） */
function stableHash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}
