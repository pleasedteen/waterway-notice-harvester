/**
 * 采集编排：
 * - 列表发现按页落检查点；详情原始页用确定性检查点 ID 单独保存；
 * - 条目提交只写该条目的检查点，作业整批数据由 Store.getJob 合并返回；
 * - 因此详情翻页/崩溃恢复的额外读写只与当前条目页数有关，不随已完成条目数增长；
 * - 全程校验来源 revision，发现换版 => 作业置 edition_changed 并阻断发布；
 * - 分页失败不丢弃已采页，条目标 failed 且整批不完整；
 * - “未采到”绝不解释为删除：只有整批成功完成才可发布，发布集仅来自本批记录。
 */
import { createHash } from 'node:crypto';
import { contentHash, type Fetcher } from '../fetch/fetcher.js';
import {
  extractListEntries,
  extractNextPage,
  mergeDetailPages,
  type PageDocument,
} from '../core/extractor.js';
import { newId, nowIso } from '../core/ids.js';
import type {
  BusinessRecord,
  CrawlJob,
  JobEntryState,
  JobProgressCheckpoint,
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

/**
 * 模拟进程在检查点 I/O 边界退出时，存储层抛出的错误必须继续向上传播，
 * 不能被“单条详情解析/网络失败”的 catch 误提交成 failed 条目。
 */
class CheckpointIoError extends Error {
  constructor(override readonly cause: unknown) {
    super(`检查点持久化失败: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'CheckpointIoError';
  }
}

function detailPageCheckpointId(jobId: string, entryIndex: number, pageNumber: number, url: string): string {
  const digest = createHash('sha256')
    .update([jobId, String(entryIndex), String(pageNumber), url].join('\u0000'))
    .digest('hex')
    .slice(0, 24);
  return `snap_detail_${digest}`;
}

export class CrawlService {
  constructor(
    private readonly store: Store,
    private readonly fetcher: Fetcher,
  ) {}

  /** 启动新作业；若存在同来源同规则的未完成作业，直接返回它（重启续跑入口） */
  async startOrResume(input: StartJobInput): Promise<CrawlJob> {
    const existing = await this.findResumable(input.sourceId, input.rule.ruleId, input.rule.version);
    // 轻量索引可能略滞后于 progress/job 文档；以 getJob 合并后的权威状态为准。
    if (existing && (existing.status === 'running' || existing.status === 'failed')) return existing;

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
    return job;
  }

  private async findResumable(sourceId: string, ruleId: string, ruleVersion: string): Promise<CrawlJob | null> {
    if (this.store.findResumableJobId) {
      const jobId = await this.store.findResumableJobId(sourceId, ruleId, ruleVersion);
      if (!jobId) return null;
      return this.store.getJob(jobId);
    }
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
        if (e instanceof CheckpointIoError) throw e;
        job.status = 'failed';
        job.lastError = `列表发现失败: ${(e as Error).message}`;
        job.updatedAt = nowIso();
        await this.persistJobState(job);
        return job;
      }
      if (job.status === 'edition_changed') {
        await this.persistJobState(job);
        return job;
      }
    }

    // 2. 逐条采集详情（含续页），跳过已完成。getJob 是唯一允许随整批数据增长的读取。
    const budget = opts.maxEntriesPerCall ?? Number.MAX_SAFE_INTEGER;
    let processed = 0;
    for (const [entryIndex, entry] of job.entries.entries()) {
      if (entry.status === 'done') continue;
      if (processed >= budget) break;
      processed += 1;
      await this.crawlEntry(job, rule, entry, entryIndex);
      if (job.status === 'edition_changed') {
        job.updatedAt = nowIso();
        await this.persistJobState(job);
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
    await this.persistJobState(job);
    return job;
  }

  private async discoverEntries(job: CrawlJob, rule: RuleDocument): Promise<void> {
    const seen = new Set<string>();
    let listUrl: string | null = job.seedUrl;
    let listPageNo = 0;
    while (listUrl && listPageNo < (rule.list?.pagination?.maxPages ?? 1)) {
      listPageNo += 1;
      const fetched = await this.fetcher.fetch(listUrl);
      this.checkRevision(job, fetched.revision, listUrl);
      if (job.status === 'edition_changed') return;
      const snap = await this.persistSnapshot(job, fetched, listUrl, newId('snap'));
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
      // 每页列表发现后立即持久化条目索引。该文档此刻只有 pending 元数据，
      // 详情记录随后走按条目检查点，避免将来把已完成记录反复整批重写。
      await this.store.saveJob(job);
      if (!rule.list?.pagination) break;
      listUrl = extractNextPage(snap.html, rule.list.pagination, listUrl);
    }
  }

  private async crawlEntry(
    job: CrawlJob,
    rule: RuleDocument,
    entry: JobEntryState,
    entryIndex: number,
  ): Promise<void> {
    entry.attempts += 1;
    entry.status = 'pending';
    entry.lastError = null;
    entry.updatedAt = nowIso();

    let pages: PageDocument[];
    try {
      pages = await this.loadExistingPages(entry);
    } catch (e) {
      throw new CheckpointIoError(e);
    }

    const maxPages = rule.pagination?.maxPages ?? 1;
    let nextUrl: string | null = pages.length === 0 ? entry.entryUrl : this.nextUrlOf(rule, pages[pages.length - 1]!);
    let pageCount = pages.length;

    while (nextUrl && pageCount < maxPages) {
      const pageNumber = pageCount + 1;
      const deterministicSnapshotId = detailPageCheckpointId(job.jobId, entryIndex, pageNumber, nextUrl);

      // 即使进程在“原页 saveSnapshot 成功后、条目检查点写入前”退出，
      // 也能凭 job/entryIndex/pageNumber/url 的确定性 ID 找回该页，而不重新抓取。
      let snap: Snapshot | null;
      try {
        snap = await this.store.getSnapshot(deterministicSnapshotId);
      } catch (e) {
        throw new CheckpointIoError(e);
      }

      if (!snap) {
        let fetched: Awaited<ReturnType<Fetcher['fetch']>>;
        try {
          fetched = await this.fetcher.fetch(nextUrl);
        } catch (e) {
          await this.markEntryFailed(job, entry, entryIndex, (e as Error).message);
          return;
        }

        this.checkRevision(job, fetched.revision, nextUrl);
        if (job.status === 'edition_changed') return;

        try {
          snap = await this.persistSnapshot(job, fetched, nextUrl, deterministicSnapshotId);
        } catch (e) {
          throw new CheckpointIoError(e);
        }
      }

      if (!entry.snapshotIds.includes(snap.snapshotId)) entry.snapshotIds.push(snap.snapshotId);
      pages.push({ url: nextUrl, html: snap.html, page: pages.length + 1 });
      pageCount += 1;
      entry.updatedAt = nowIso();

      // 轻量推进检查点：只覆盖当前条目。崩溃在这次写入前后都可恢复。
      try {
        await this.persistEntryState(job.jobId, entryIndex, entry);
      } catch (e) {
        throw new CheckpointIoError(e);
      }

      try {
        nextUrl = rule.pagination ? this.nextUrlOf(rule, pages[pages.length - 1]!) : null;
      } catch (e) {
        await this.markEntryFailed(job, entry, entryIndex, `分页链接解析失败: ${(e as Error).message}`);
        return;
      }
    }

    // 合并与提交在所有原页落盘之后进行。提交检查点通过原子 rename 一次生效，
    // 对外不会出现 status=done 但 record 缺失的半成品。
    let record: BusinessRecord;
    try {
      record = mergeDetailPages(pages, rule);
    } catch (e) {
      await this.markEntryFailed(job, entry, entryIndex, (e as Error).message);
      return;
    }

    for (const [k, v] of Object.entries(entry.prefetch)) {
      if (!record.fields[k] && v.value.status !== 'missing') record.fields[k] = v;
    }
    entry.record = record;
    entry.pagesMerged = record.pagesMerged;
    entry.status = 'done';
    entry.lastError = null;
    entry.updatedAt = nowIso();
    job.updatedAt = nowIso();

    try {
      await this.persistEntryState(job.jobId, entryIndex, entry);
    } catch (e) {
      throw new CheckpointIoError(e);
    }
  }

  private async loadExistingPages(entry: JobEntryState): Promise<PageDocument[]> {
    const pages: PageDocument[] = [];
    // 旧作业的随机 snapshot id 仍由整份 job 带回；这里只读当前条目的页，不遍历其他条目。
    for (const sid of entry.snapshotIds) {
      const s = await this.store.getSnapshot(sid);
      if (s) pages.push({ url: s.url, html: s.html, page: pages.length + 1 });
    }
    return pages;
  }

  private nextUrlOf(rule: RuleDocument, lastPage: PageDocument): string | null {
    if (!rule.pagination) return null;
    return extractNextPage(lastPage.html, rule.pagination, lastPage.url);
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
    snapshotId: string,
  ): Promise<Snapshot> {
    const snapshot: Snapshot = {
      snapshotId,
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

  private async persistEntryState(jobId: string, entryIndex: number, entry: JobEntryState): Promise<void> {
    if (this.store.saveJobEntryCheckpoint) {
      await this.store.saveJobEntryCheckpoint(jobId, entryIndex, entry);
    }
    // 对只实现基础 Store 的替身，确定性 snapshot id 已足以恢复原页；
    // 整批 job 会在本次 run 结束时按旧接口保存一次。
  }

  private async persistJobState(job: CrawlJob): Promise<void> {
    try {
      if (this.store.saveJobProgress) {
        const progress: JobProgressCheckpoint = {
          status: job.status,
          updatedAt: job.updatedAt,
          finishedAt: job.finishedAt,
          lastError: job.lastError,
          publicationId: job.publicationId,
          sourceId: job.sourceId,
          ruleId: job.ruleId,
          ruleVersion: job.ruleVersion,
        };
        await this.store.saveJobProgress(job.jobId, progress);
        return;
      }
      await this.store.saveJob(job);
    } catch (e) {
      if (e instanceof CheckpointIoError) throw e;
      throw new CheckpointIoError(e);
    }
  }

  private async markEntryFailed(
    job: CrawlJob,
    entry: JobEntryState,
    entryIndex: number,
    message: string,
  ): Promise<void> {
    entry.status = 'failed';
    entry.lastError = message;
    entry.updatedAt = nowIso();
    job.lastError = `条目 ${entry.entryUrl} 采集失败: ${message}`;
    job.updatedAt = nowIso();
    try {
      await this.persistEntryState(job.jobId, entryIndex, entry);
    } catch (e) {
      throw new CheckpointIoError(e);
    }
  }

  /** 作业产出的完整记录（仅 completed 时有意义） */
  async collectRecords(jobId: string): Promise<BusinessRecord[]> {
    const job = await this.store.getJob(jobId);
    if (!job) throw new Error(`作业不存在: ${jobId}`);
    return job.entries.filter((e) => e.record).map((e) => e.record!) as BusinessRecord[];
  }
}
