/**
 * 采集编排：
 * - 每个条目/分页完成即落检查点，进程重启后从断点继续；
 * - 列表页与详情页每次处理都写一条 append-only 页面尝试（PageAttempt），
 *   可区分 fetched（重新请求成功）/ reused（复用快照，未发请求）/ failed（失败）/ in_flight（结局未知的旧尝试）；
 * - 尝试在发请求前先登记 in_flight，请求途中强杀 => 该尝试永久停留在 in_flight，
 *   重启后的新尝试另写新行，旧尝试不被覆盖，新旧可凭 attemptId/startedAt 区分；
 * - 只有快照与作业检查点都已落盘的页面才记 fetched、才算采集成功；
 * - 全程校验来源 revision，发现换版 => 作业置 edition_changed 并阻断发布；
 * - 分页失败不丢弃已采页，条目标 failed 且整批不完整；
 * - "未采到"绝不解释为删除：只有整批成功完成才可发布，发布集仅来自本批记录。
 */
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
  PageAttempt,
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
      listDiscoveryDone: false,
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

    // 1. 列表发现（带列表分页）。已落盘的列表页快照始终先复用（记 reused，不发请求），
    //    仅崩溃/失败时缺失的续页才补抓；完整跑完后置 listDiscoveryDone。
    if (!job.listDiscoveryDone || job.listSnapshotIds.length > 0) {
      try {
        await this.discoverEntries(job, rule);
      } catch (e) {
        job.status = 'failed';
        job.lastError = `列表发现失败: ${(e as Error).message}`;
        job.updatedAt = nowIso();
        await this.store.saveJob(job);
        return job;
      }
      if (job.status === 'edition_changed') {
        await this.store.saveJob(job);
        return job;
      }
    }

    // 2. 逐条采集详情（含续页）。已完成条目只在首次续跑时补记一次 reused 诊断，
    //    不消耗步长预算、不发请求；未完成条目正常推进。
    const budget = opts.maxEntriesPerCall ?? Number.MAX_SAFE_INTEGER;
    let processed = 0;
    for (const entry of job.entries) {
      if (entry.status === 'done') {
        if (!entry.reuseLogged) await this.logReusedPages(job, entry);
        continue;
      }
      if (processed >= budget) break;
      processed += 1;
      await this.crawlEntry(job, rule, entry);
      if (job.status === 'edition_changed') {
        await this.store.saveJob(job);
        return job;
      }
    }

    // 3. 整批改判：failed 作业在本次推进时先回到 running（仍有失败条目则在下面重新判 failed）；
    //    但列表发现未完成（listDiscoveryDone=false）说明批次不完整，必须保持 failed 可续跑；
    //    edition_changed 等其他终态同样不被覆盖。
    job.updatedAt = nowIso();
    if (job.status === 'failed' && job.listDiscoveryDone) job.status = 'running';
    if (job.status === 'running') {
      if (job.entries.every((e) => e.status === 'done')) {
        job.status = 'completed';
        job.finishedAt = nowIso();
      } else if (job.entries.some((e) => e.status === 'failed')) {
        job.status = 'failed';
        job.lastError = job.lastError ?? '存在失败条目，批次不完整';
      }
    }
    await this.store.saveJob(job);
    return job;
  }

  /**
   * 列表发现（可续跑）：已落盘的列表页快照直接复用（记 reused，不发请求），
   * 只有崩溃时尚未抓到的续页才重新请求。
   */
  private async discoverEntries(job: CrawlJob, rule: RuleDocument): Promise<void> {
    const maxPages = rule.list?.pagination?.maxPages ?? 1;
    const seen = new Set(job.entries.map((e) => e.entryUrl));

    // 1) 复用已落盘的列表快照：逐页重建条目，并据此定位续跑起点。
    //    reused 诊断每个作业只记一次（listReuseLogged 检查点），重复续跑只静默装载。
    let listUrl: string | null = job.seedUrl;
    let listPageNo = 0;
    for (const sid of job.listSnapshotIds) {
      const snap = await this.store.getSnapshot(sid);
      if (!snap) continue;
      listPageNo += 1;
      this.absorbListEntries(job, snap.html, rule, snap.url, seen);
      if (!job.listReuseLogged) {
        await this.recordAttempt(job, {
          kind: 'list',
          entryUrl: null,
          page: listPageNo,
          url: snap.url,
          outcome: 'reused',
          snapshotId: snap.snapshotId,
          error: null,
        });
      }
      if (rule.list?.pagination) listUrl = extractNextPage(snap.html, rule.list.pagination, snap.url);
    }
    if (listPageNo > 0) job.listReuseLogged = true;

    // 2) 抓取剩余列表续页（首轮或崩溃在列表阶段时进入）
    let interrupted = false;
    while (listUrl && listPageNo < maxPages) {
      listPageNo += 1;
      const fetched = await this.fetchWithAttempt(job, {
        kind: 'list',
        entryUrl: null,
        page: listPageNo,
        url: listUrl,
        persist: (f, url) => this.persistSnapshot(job, f, url),
        revisionCheck: (revision, url) => this.checkRevision(job, revision, url),
        isEditionChanged: () => job.status === 'edition_changed',
      });
      if (job.status === 'edition_changed') return;
      if (!fetched) {
        // 本次请求失败：failed 尝试已写，先落检查点保留已采列表页，作业置 failed 等待下次续跑
        interrupted = true;
        job.status = 'failed';
        job.lastError = `列表第 ${listPageNo} 页抓取失败（详见页面尝试诊断）: ${listUrl}`;
        job.updatedAt = nowIso();
        await this.store.saveJob(job);
        break;
      }
      const { snap } = fetched;
      if (!job.listSnapshotIds.includes(snap.snapshotId)) job.listSnapshotIds.push(snap.snapshotId);
      this.absorbListEntries(job, snap.html, rule, snap.url, seen);
      await this.store.saveJob(job); // 每个列表页落检查点
      if (!rule.list?.pagination) {
        listUrl = null;
        break;
      }
      listUrl = extractNextPage(snap.html, rule.list.pagination, snap.url);
    }

    // 仅当分页确实走到终点（无下一页或达上限）才标记完成；中途失败保持可续跑
    job.listDiscoveryDone = !interrupted;
    await this.store.saveJob(job);
  }

  private absorbListEntries(
    job: CrawlJob,
    html: string,
    rule: RuleDocument,
    url: string,
    seen: Set<string>,
  ): void {
    for (const e of extractListEntries(html, rule, url)) {
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
  }

  /**
   * 为条目已落盘的分页快照写 reused 尝试（不发请求），返回按页序装载的页面文档。
   * 仅当确实存在历史快照时才置 reuseLogged（全新抓取的条目不留该标记，
   * 这样它在日后重启续跑时仍会补记一次 reused）；每个条目至多记一次。
   */
  private async logReusedPages(job: CrawlJob, entry: JobEntryState): Promise<PageDocument[]> {
    const pages: PageDocument[] = [];
    for (const sid of entry.snapshotIds) {
      const s = await this.store.getSnapshot(sid);
      if (!s) continue;
      const pageNo = pages.length + 1;
      pages.push({ url: s.url, html: s.html, page: pageNo });
      await this.recordAttempt(job, {
        kind: 'detail',
        entryUrl: entry.entryUrl,
        page: pageNo,
        url: s.url,
        outcome: 'reused',
        snapshotId: s.snapshotId,
        error: null,
      });
    }
    if (pages.length > 0) {
      entry.reuseLogged = true;
      entry.updatedAt = nowIso();
      job.updatedAt = nowIso();
      await this.store.saveJob(job);
    }
    return pages;
  }

  /** 仅装载已落盘快照为页面文档（复用诊断已记过时使用，不产生新写入） */
  private async loadReusedPages(entry: JobEntryState): Promise<PageDocument[]> {
    const pages: PageDocument[] = [];
    for (const sid of entry.snapshotIds) {
      const s = await this.store.getSnapshot(sid);
      if (s) pages.push({ url: s.url, html: s.html, page: pages.length + 1 });
    }
    return pages;
  }

  private async crawlEntry(job: CrawlJob, rule: RuleDocument, entry: JobEntryState): Promise<void> {
    entry.attempts += 1;

    // 续跑：已成功落盘的分页快照直接复用（记 reused，不重复抓取）；已记过则只装载
    const pages: PageDocument[] = entry.reuseLogged
      ? await this.loadReusedPages(entry)
      : await this.logReusedPages(job, entry);

    let nextUrl: string | null =
      pages.length === 0 ? entry.entryUrl : this.nextUrlOf(rule, pages[pages.length - 1]!);
    let guard = pages.length;
    try {
      while (nextUrl && guard < (rule.pagination?.maxPages ?? 1)) {
        guard += 1;
        const pageNo = guard;
        const fetched = await this.fetchWithAttempt(job, {
          kind: 'detail',
          entryUrl: entry.entryUrl,
          page: pageNo,
          url: nextUrl,
          persist: (f, url) => this.persistSnapshot(job, f, url),
          revisionCheck: (revision, url) => this.checkRevision(job, revision, url),
          isEditionChanged: () => job.status === 'edition_changed',
        });
        if (job.status === 'edition_changed') return;
        if (!fetched) throw new Error(`第 ${pageNo} 页抓取失败（详见页面尝试诊断）: ${nextUrl}`);
        const { snap } = fetched;
        if (!entry.snapshotIds.includes(snap.snapshotId)) entry.snapshotIds.push(snap.snapshotId);
        pages.push({ url: nextUrl, html: snap.html, page: pageNo });
        await this.store.saveJob(job); // 每页落检查点：先持久化，尝试才算成功
        nextUrl = rule.pagination ? extractNextPage(snap.html, rule.pagination, nextUrl) : null;
      }

      // 合并预取字段（缺失不覆盖详情页结果）
      const record: BusinessRecord = mergeDetailPages(pages, rule);
      for (const [k, v] of Object.entries(entry.prefetch)) {
        if (!record.fields[k] && v.value.status !== 'missing') record.fields[k] = v;
      }
      entry.record = record;
      entry.pagesMerged = record.pagesMerged;
      entry.status = 'done';
      entry.lastError = null;
    } catch (e) {
      // 分页失败：保留已采页面与检查点，条目标 failed，整批不完整
      entry.status = 'failed';
      entry.lastError = (e as Error).message;
      job.lastError = `条目 ${entry.entryUrl} 采集失败: ${entry.lastError}`;
    }
    entry.updatedAt = nowIso();
    job.updatedAt = nowIso();
    await this.store.saveJob(job);
  }

  /**
   * 带尝试登记的页面抓取：
   * 1) 先落一条 in_flight 尝试（请求途中强杀 => 它永久停留在 in_flight）；
   * 2) 发请求、校验修订、持久化快照；
   * 3) 成功则把同一尝试落定为 fetched（快照与检查点均已落盘），失败落定为 failed。
   * 每次调用只新增一条尝试，写入量与历史尝试次数无关。
   */
  private async fetchWithAttempt(
    job: CrawlJob,
    spec: {
      kind: 'list' | 'detail';
      entryUrl: string | null;
      page: number;
      url: string;
      persist: (f: Awaited<ReturnType<Fetcher['fetch']>>, url: string) => Promise<Snapshot>;
      revisionCheck: (revision: string, url: string) => void;
      isEditionChanged: () => boolean;
    },
  ): Promise<{ snap: Snapshot } | null> {
    const attemptId = newId('att');
    const startedAt = nowIso();
    const base = {
      attemptId,
      jobId: job.jobId,
      kind: spec.kind,
      entryUrl: spec.entryUrl,
      page: spec.page,
      url: spec.url,
      startedAt,
    };
    await this.store.savePageAttempt({ ...base, outcome: 'in_flight', snapshotId: null, error: null, finishedAt: null });

    try {
      const fetched = await this.fetcher.fetch(spec.url);
      spec.revisionCheck(fetched.revision, spec.url);
      if (spec.isEditionChanged()) {
        await this.store.savePageAttempt({
          ...base,
          outcome: 'failed',
          snapshotId: null,
          error: job.lastError,
          finishedAt: nowIso(),
        });
        return null;
      }
      const snap = await spec.persist(fetched, spec.url);
      await this.store.savePageAttempt({
        ...base,
        outcome: 'fetched',
        snapshotId: snap.snapshotId,
        error: null,
        finishedAt: nowIso(),
      });
      return { snap };
    } catch (e) {
      await this.store.savePageAttempt({
        ...base,
        outcome: 'failed',
        snapshotId: null,
        error: (e as Error).message,
        finishedAt: nowIso(),
      });
      return null;
    }
  }

  /** 复用快照等无需发请求的结局，直接写一条终态尝试（仍是每次处理一条） */
  private async recordAttempt(
    job: CrawlJob,
    spec: Omit<PageAttempt, 'attemptId' | 'jobId' | 'startedAt' | 'finishedAt'> & { finishedAt?: string | null },
  ): Promise<void> {
    const now = nowIso();
    await this.store.savePageAttempt({
      attemptId: newId('att'),
      jobId: job.jobId,
      startedAt: now,
      finishedAt: spec.finishedAt ?? now,
      ...spec,
    });
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
