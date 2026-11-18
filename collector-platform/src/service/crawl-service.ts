/**
 * 采集编排：
 * - 每个条目/分页完成即落检查点，进程重启后从断点继续；
 * - 全程校验来源 revision，发现换版 => 作业置 edition_changed 并阻断发布；
 * - 列表发现同样断点续跑：沿用已采列表页快照推导下一页继续，绝不因"已有部分条目"
 *   跳过发现阶段（否则列表第 2 页失败后重跑会漏公告却显示完成）；
 * - 列表/详情达到页数上限仍有下一页 => 整批不完整（truncated / 条目 failed），禁止发布；
 * - 分页失败不丢弃已采页，条目标 failed 且整批不完整；
 * - "未采到"绝不解释为删除：只有整批成功完成才可发布，发布集仅来自本批记录。
 */
import { contentHash, type Fetcher } from '../fetch/fetcher.js';
import {
  applyPrefetch,
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
  JobStatus,
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
      listDiscovery: 'pending',
      listNextUrl: null,
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

    // 旧版本作业缺少列表发现状态：一律按 pending 重新核对（沿用已有快照，不会重复抓取）
    job.listDiscovery ??= 'pending';
    job.listNextUrl ??= null;

    // 1. 列表发现（带列表分页，可断点续跑）：沿用已采列表页快照继续，
    //    直到无下一页（completed）或确认达到上限仍有下一页（truncated）。
    if (job.listDiscovery === 'pending') {
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
    if (job.listDiscovery === 'truncated') {
      // 达到页数上限仍有下一页：整批不完整，绝不置 completed
      job.status = 'failed';
      job.lastError = `列表分页达到上限仍有下一页未采集: ${job.listNextUrl ?? '?'}，批次不完整`;
      job.updatedAt = nowIso();
      await this.store.saveJob(job);
      return job;
    }
    // discoverEntries 可能检出换版（checkRevision 改写 job.status）
    const statusAfterDiscovery: JobStatus = job.status;
    if (statusAfterDiscovery === 'edition_changed') {
      await this.store.saveJob(job);
      return job;
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

    // 3. 整批改判：列表发现完整 + 所有条目 done 才能 completed
    job.updatedAt = nowIso();
    if (job.listDiscovery === 'completed' && job.entries.every((e) => e.status === 'done')) {
      job.status = 'completed';
      job.finishedAt = nowIso();
    } else if (job.entries.some((e) => e.status === 'failed')) {
      job.status = 'failed';
      job.lastError = job.lastError ?? '存在失败条目，批次不完整';
    }
    await this.store.saveJob(job);
    return job;
  }

  /**
   * 列表发现（断点续跑）：
   * - 已采列表页快照直接复用，从最后一个快照离线推导下一页继续抓取；
   * - 每页落检查点；抓取失败抛出，状态保持 pending，重跑从断点页重试；
   * - 达到 maxPages 仍有下一页 => truncated（整批不完整）。
   */
  private async discoverEntries(job: CrawlJob, rule: RuleDocument): Promise<void> {
    // 无列表配置：seedUrl 即单条详情
    if (!rule.list) {
      if (job.entries.length === 0) {
        job.entries.push(this.newEntry(job.seedUrl, {}));
      }
      job.listDiscovery = 'completed';
      job.listNextUrl = null;
      await this.store.saveJob(job);
      return;
    }

    const pagination = rule.list.pagination;
    const maxPages = pagination?.maxPages ?? 1;
    const seen = new Set(job.entries.map((e) => e.entryUrl));

    // 续跑：已有列表页快照不重复抓取
    const listSnaps: Snapshot[] = [];
    for (const sid of job.listSnapshotIds) {
      const s = await this.store.getSnapshot(sid);
      if (s) listSnaps.push(s);
    }
    const lastSnap = listSnaps[listSnaps.length - 1];
    let listUrl: string | null =
      listSnaps.length === 0
        ? job.seedUrl
        : pagination
          ? extractNextPage(lastSnap!.html, pagination, lastSnap!.url)
          : null;

    while (listUrl) {
      if (listSnaps.length >= maxPages) {
        job.listDiscovery = 'truncated';
        job.listNextUrl = listUrl;
        job.updatedAt = nowIso();
        await this.store.saveJob(job);
        return;
      }
      const fetched = await this.fetcher.fetch(listUrl);
      this.checkRevision(job, fetched.revision, listUrl);
      if (job.status === 'edition_changed') return;
      const snap = await this.persistSnapshot(job, fetched, listUrl);
      if (!job.listSnapshotIds.includes(snap.snapshotId)) job.listSnapshotIds.push(snap.snapshotId);
      listSnaps.push(snap);
      for (const e of extractListEntries(snap.html, rule, listUrl)) {
        if (seen.has(e.url)) continue;
        seen.add(e.url);
        job.entries.push(this.newEntry(e.url, e.prefetch));
      }
      listUrl = pagination ? extractNextPage(snap.html, pagination, listUrl) : null;
      await this.store.saveJob(job); // 每页落检查点
    }
    job.listDiscovery = 'completed';
    job.listNextUrl = null;
    await this.store.saveJob(job);
  }

  private newEntry(entryUrl: string, prefetch: JobEntryState['prefetch']): JobEntryState {
    return {
      entryUrl,
      prefetch,
      status: 'pending',
      snapshotIds: [],
      pagesMerged: [],
      record: null,
      attempts: 0,
      lastError: null,
      updatedAt: nowIso(),
    };
  }

  private async crawlEntry(job: CrawlJob, rule: RuleDocument, entry: JobEntryState): Promise<void> {
    entry.attempts += 1;
    const pages: PageDocument[] = [];
    // 续跑：已成功的分页快照直接复用，不重复抓取
    const existingSnaps: Snapshot[] = [];
    for (const sid of entry.snapshotIds) {
      const s = await this.store.getSnapshot(sid);
      if (s) existingSnaps.push(s);
    }
    for (const s of existingSnaps) {
      pages.push({ url: s.url, html: s.html, page: pages.length + 1 });
    }

    const maxPages = rule.pagination?.maxPages ?? 1;
    let nextUrl: string | null = pages.length === 0 ? entry.entryUrl : this.nextUrlOf(rule, pages[pages.length - 1]!);
    try {
      // 页数上限按条目总分页数计（含续跑复用的快照），防止跨次运行绕过上限
      while (nextUrl && pages.length < maxPages) {
        const fetched = await this.fetcher.fetch(nextUrl);
        this.checkRevision(job, fetched.revision, nextUrl);
        if (job.status === 'edition_changed') return;
        const snap = await this.persistSnapshot(job, fetched, nextUrl);
        if (!entry.snapshotIds.includes(snap.snapshotId)) entry.snapshotIds.push(snap.snapshotId);
        pages.push({ url: nextUrl, html: snap.html, page: pages.length + 1 });
        await this.store.saveJob(job); // 每页落检查点
        nextUrl = rule.pagination ? extractNextPage(snap.html, rule.pagination, nextUrl) : null;
      }
      if (nextUrl) {
        // 达到页数上限仍有下一页：条目续页不完整，绝不按残缺页面合并出"完成"记录
        throw new Error(`详情续页达到上限(maxPages=${maxPages})仍有下一页未采集: ${nextUrl}`);
      }

      // 合并预取字段（缺失不覆盖详情页结果）
      const record: BusinessRecord = mergeDetailPages(pages, rule);
      applyPrefetch(record, entry.prefetch);
      entry.record = record;
      entry.pagesMerged = record.pagesMerged;
      entry.status = 'done';
      entry.lastError = null;
    } catch (e) {
      // 分页失败/续页截断：保留已采页面与检查点，条目标 failed，整批不完整
      entry.status = 'failed';
      entry.lastError = (e as Error).message;
      job.lastError = `条目 ${entry.entryUrl} 采集失败: ${entry.lastError}`;
    }
    entry.updatedAt = nowIso();
    job.updatedAt = nowIso();
    await this.store.saveJob(job);
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

  private async persistSnapshot(job: CrawlJob, fetched: Awaited<ReturnType<Fetcher['fetch']>>, url: string): Promise<Snapshot> {
    const snapshot: Snapshot = {
      snapshotId: newId('snap'),
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
