/**
 * 嵌入式文件存储：零外部进程，原子写（tmp+rename），发布用独立 current 指针文件，
 * 保证发布中途崩溃时 currentPublication 仍指向上一完整发布。
 */
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  legacyChangePage,
  legacyExpectationPage,
  normalizePage,
  normalizeStoredSummary,
} from '../core/report-paging.js';
import type {
  ChangePage,
  ChangeStream,
  ExpectationPage,
  RecordChange,
  RegressionReportWriter,
  Store,
  RuleDocument,
  Snapshot,
  RegressionFixture,
  CrawlJob,
  RegressionReport,
  RegressionReportSummary,
  Publication,
  SourceConfig,
} from '../core/types.js';

/** 报告 id 用作目录名/文件名：只保留安全字符，杜绝路径穿越 */
function safeSegment(id: string): string {
  return id.replace(/[^A-Za-z0-9._@-]/g, '_');
}

export class EmbeddedStore implements Store {
  constructor(private readonly root: string) {}

  private dir(kind: string): string {
    return join(this.root, kind);
  }

  private path(kind: string, id: string): string {
    return join(this.dir(kind), `${id}.json`);
  }

  async init(): Promise<void> {
    for (const d of ['rules', 'snapshots', 'fixtures', 'jobs', 'reports', 'publications', 'sources', 'meta']) {
      await mkdir(join(this.root, d), { recursive: true });
    }
  }

  async close(): Promise<void> {
    /* 无资源需要释放 */
  }

  private async atomicWriteJson(file: string, data: unknown): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
    await rename(tmp, file);
  }

  private async readJson<T>(file: string): Promise<T | null> {
    if (!existsSync(file)) return null;
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  }

  private async listJson<T>(kind: string): Promise<T[]> {
    const dir = this.dir(kind);
    if (!existsSync(dir)) return [];
    const entries = await readdir(dir, { withFileTypes: true });
    const out: T[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.includes('.tmp-')) continue;
      const v = await this.readJson<T>(join(dir, e.name));
      if (v) out.push(v);
    }
    return out;
  }

  async saveRule(rule: RuleDocument): Promise<void> {
    const existing = await this.getRule(rule.ruleId, rule.version);
    if (existing) {
      // 规则版本不可变：内容哈希必须一致
      if (JSON.stringify(existing) !== JSON.stringify(rule)) {
        throw new Error(`规则版本不可变: ${rule.ruleId}@${rule.version} 已存在且内容不同`);
      }
      return;
    }
    await this.atomicWriteJson(this.path('rules', `${rule.ruleId}__${rule.version}`), rule);
  }

  getRule(ruleId: string, version: string): Promise<RuleDocument | null> {
    return this.readJson<RuleDocument>(this.path('rules', `${ruleId}__${version}`));
  }

  async listRules(ruleId?: string): Promise<RuleDocument[]> {
    const all = await this.listJson<RuleDocument>('rules');
    return all.filter((r) => !ruleId || r.ruleId === ruleId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveSnapshot(s: Snapshot): Promise<void> {
    await this.atomicWriteJson(this.path('snapshots', s.snapshotId), s);
  }
  getSnapshot(id: string): Promise<Snapshot | null> {
    return this.readJson<Snapshot>(this.path('snapshots', id));
  }
  async listSnapshots(sourceId?: string): Promise<Snapshot[]> {
    const all = await this.listJson<Snapshot>('snapshots');
    return all.filter((s) => !sourceId || s.sourceId === sourceId).sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  }

  async saveFixture(f: RegressionFixture): Promise<void> {
    await this.atomicWriteJson(this.path('fixtures', f.fixtureId), f);
  }
  getFixture(id: string): Promise<RegressionFixture | null> {
    return this.readJson<RegressionFixture>(this.path('fixtures', id));
  }
  listFixtures(): Promise<RegressionFixture[]> {
    return this.listJson<RegressionFixture>('fixtures');
  }

  async saveJob(j: CrawlJob): Promise<void> {
    await this.atomicWriteJson(this.path('jobs', j.jobId), j);
  }
  getJob(id: string): Promise<CrawlJob | null> {
    return this.readJson<CrawlJob>(this.path('jobs', id));
  }
  listJobs(): Promise<CrawlJob[]> {
    return this.listJson<CrawlJob>('jobs');
  }

  private reportDir(reportId: string): string {
    return join(this.dir('reports'), safeSegment(reportId));
  }

  private reportPagePath(reportId: string, stream: ChangeStream | 'expectation', page: number): string {
    return join(this.reportDir(reportId), stream, `p${page}.json`);
  }

  /**
   * 开始写一份分页报告：明细页逐页落盘，commit 原子写摘要后才可见。
   * 摘要写入失败或进程中断时，残留的明细页没有摘要指向，读取方不会看到半份报告。
   */
  createRegressionReportWriter(reportId: string): RegressionReportWriter {
    const dir = this.reportDir(reportId);
    return {
      writeChangePage: async (stream, page, pageSize, changes) => {
        await this.atomicWriteJson(this.reportPagePath(reportId, stream, page), { page, pageSize, changes });
      },
      writeExpectationPage: async (page, pageSize, mismatches) => {
        await this.atomicWriteJson(this.reportPagePath(reportId, 'expectation', page), { page, pageSize, mismatches });
      },
      commit: async (summary) => {
        // 清掉超出本次页数的陈旧页（复用报告 id / 重写更小的报告时）
        await this.removeStalePages(reportId, summary);
        await this.atomicWriteJson(this.path('reports', safeSegment(reportId)), summary);
      },
      abort: async () => {
        await rm(dir, { recursive: true, force: true });
      },
    };
  }

  /** 删除摘要声明页数之外的残留明细页 */
  private async removeStalePages(reportId: string, summary: RegressionReportSummary): Promise<void> {
    const limits: { dir: ChangeStream | 'expectation'; pages: number }[] = [
      { dir: 'record', pages: summary.streams.record.pages },
      { dir: 'expectation', pages: summary.streams.expectation.pages },
    ];
    if (summary.streams.source) limits.push({ dir: 'source', pages: summary.streams.source.pages });
    if (summary.streams.rule) limits.push({ dir: 'rule', pages: summary.streams.rule.pages });
    for (const { dir, pages } of limits) {
      const streamDir = join(this.reportDir(reportId), dir);
      if (!existsSync(streamDir)) continue;
      for (const name of await readdir(streamDir)) {
        const m = /^p(\d+)\.json$/.exec(name);
        if (m && Number(m[1]) >= pages) await rm(join(streamDir, name), { force: true });
      }
    }
    // 本次没有该变化流时，整个流目录都应清掉
    for (const stream of ['source', 'rule']) {
      if (stream === 'source' && summary.streams.source) continue;
      if (stream === 'rule' && summary.streams.rule) continue;
      await rm(join(this.reportDir(reportId), stream), { recursive: true, force: true });
    }
  }

  /** 保存完整报告：先分页写明细，再原子写摘要 */
  async saveRegressionReport(r: RegressionReport): Promise<void> {
    const writer = this.createRegressionReportWriter(r.reportId);
    const writeAll = async (stream: ChangeStream, changes: RecordChange[], pageSize: number) => {
      for (let p = 0, start = 0; start < changes.length; p += 1, start += pageSize) {
        await writer.writeChangePage(stream, p, pageSize, changes.slice(start, start + pageSize));
      }
    };
    await writeAll('record', r.recordChanges, r.streams.record.pageSize);
    if (r.sourceChanges) await writeAll('source', r.sourceChanges, r.streams.source!.pageSize);
    if (r.ruleChanges) await writeAll('rule', r.ruleChanges, r.streams.rule!.pageSize);
    for (let p = 0, start = 0; start < r.expectationMismatches.length; p += 1, start += r.streams.expectation.pageSize) {
      await writer.writeExpectationPage(
        p,
        r.streams.expectation.pageSize,
        r.expectationMismatches.slice(start, start + r.streams.expectation.pageSize),
      );
    }
    const { recordChanges, sourceChanges, ruleChanges, expectationMismatches, ...summary } = r;
    void recordChanges;
    void sourceChanges;
    void ruleChanges;
    void expectationMismatches;
    await writer.commit(summary);
  }

  /** 只读摘要：不加载任何变化明细 */
  async getRegressionReport(id: string): Promise<RegressionReportSummary | null> {
    const doc = await this.readJson<Record<string, unknown>>(this.path('reports', safeSegment(id)));
    return doc ? normalizeStoredSummary(doc) : null;
  }

  /** 摘要列表：只读各报告的摘要文件 */
  async listRegressionReports(): Promise<RegressionReportSummary[]> {
    const all = await this.listJson<Record<string, unknown>>('reports');
    return all
      .filter((d) => typeof d?.reportId === 'string')
      .map((d) => normalizeStoredSummary(d))
      .sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  }

  /** 按页读取变化明细：一次只读一页（旧格式内联报告也按页切片） */
  async getReportChangePage(
    reportId: string,
    stream: ChangeStream,
    page: number,
  ): Promise<ChangePage | null> {
    const doc = await this.readJson<Record<string, unknown>>(this.path('reports', safeSegment(reportId)));
    if (!doc) return null;
    if (!doc.streams) return legacyChangePage(doc, reportId, stream, page);
    const summary = normalizeStoredSummary(doc);
    const index = stream === 'record' ? summary.streams.record : stream === 'source' ? summary.streams.source : summary.streams.rule;
    if (!index) return null;
    const p = normalizePage(page);
    if (p >= index.pages) {
      return { reportId, stream, page: p, pageSize: index.pageSize, pages: index.pages, total: index.total, changes: [] };
    }
    const stored = await this.readJson<{ changes: ChangePage['changes'] }>(
      this.reportPagePath(reportId, stream, p),
    );
    return {
      reportId,
      stream,
      page: p,
      pageSize: index.pageSize,
      pages: index.pages,
      total: index.total,
      changes: stored?.changes ?? [],
    };
  }

  async getReportExpectationPage(reportId: string, page: number): Promise<ExpectationPage | null> {
    const doc = await this.readJson<Record<string, unknown>>(this.path('reports', safeSegment(reportId)));
    if (!doc) return null;
    if (!doc.streams) return legacyExpectationPage(doc, reportId, page);
    const summary = normalizeStoredSummary(doc);
    const index = summary.streams.expectation;
    const p = normalizePage(page);
    if (p >= index.pages) {
      return { reportId, page: p, pageSize: index.pageSize, pages: index.pages, total: index.total, mismatches: [] };
    }
    const stored = await this.readJson<{ mismatches: string[] }>(this.reportPagePath(reportId, 'expectation', p));
    return {
      reportId,
      page: p,
      pageSize: index.pageSize,
      pages: index.pages,
      total: index.total,
      mismatches: stored?.mismatches ?? [],
    };
  }

  /**
   * 原子发布：先写完整 publication 文件，再 rename 切换 current 指针。
   * 若在写 publication 时崩溃，current 仍指向上一版；rename 是原子的。
   */
  async commitPublication(pub: Publication): Promise<void> {
    const pubFile = this.path('publications', pub.publicationId);
    await this.atomicWriteJson(pubFile, pub);
    const pointer = join(this.dir('meta'), `current__${pub.sourceId}.json`);
    await this.atomicWriteJson(pointer, { publicationId: pub.publicationId, publishedAt: pub.publishedAt });
  }

  async getCurrentPublication(sourceId: string): Promise<Publication | null> {
    const pointer = await this.readJson<{ publicationId: string }>(join(this.dir('meta'), `current__${sourceId}.json`));
    if (!pointer) return null;
    return this.getPublication(pointer.publicationId);
  }
  getPublication(id: string): Promise<Publication | null> {
    return this.readJson<Publication>(this.path('publications', id));
  }
  async listPublications(sourceId?: string): Promise<Publication[]> {
    const all = await this.listJson<Publication>('publications');
    return all.filter((p) => !sourceId || p.sourceId === sourceId).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  }

  async saveSource(s: SourceConfig): Promise<void> {
    await this.atomicWriteJson(this.path('sources', s.sourceId), s);
  }
  getSource(id: string): Promise<SourceConfig | null> {
    return this.readJson<SourceConfig>(this.path('sources', id));
  }
  listSources(): Promise<SourceConfig[]> {
    return this.listJson<SourceConfig>('sources');
  }
}
