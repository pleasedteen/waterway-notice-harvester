/**
 * 嵌入式文件存储：零外部进程，原子写（tmp+rename），发布用独立 current 指针文件，
 * 保证发布中途崩溃时 currentPublication 仍指向上一完整发布。
 */
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  Store,
  RuleDocument,
  Snapshot,
  RegressionFixture,
  CrawlJob,
  JobEntryState,
  JobProgressCheckpoint,
  RegressionReport,
  Publication,
  SourceConfig,
} from '../core/types.js';

interface JobIndexRecord {
  jobId: string;
  sourceId: string;
  ruleId: string;
  ruleVersion: string;
  status: string;
  updatedAt: string;
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
    for (const d of ['rules', 'snapshots', 'fixtures', 'jobs', 'job-entry-checkpoints', 'job-progress', 'reports', 'publications', 'sources', 'meta']) {
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
    const files = await readdir(dir);
    const out: T[] = [];
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const v = await this.readJson<T>(join(dir, f));
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
    // 既有整批作业接口：完整写入后，以整份文档为准，清理细粒度附属检查点。
    await this.atomicWriteJson(this.path('jobs', j.jobId), j);
    await rm(this.jobEntryCheckpointDir(j.jobId), { recursive: true, force: true });
    await rm(this.progressPath(j.jobId), { force: true });
    await this.writeJobIndex({
      jobId: j.jobId,
      sourceId: j.sourceId,
      ruleId: j.ruleId,
      ruleVersion: j.ruleVersion,
      status: j.status,
      updatedAt: j.updatedAt,
    });
  }

  async getJob(id: string): Promise<CrawlJob | null> {
    const job = await this.readJson<CrawlJob>(this.path('jobs', id));
    if (!job) return null;

    const progress = await this.getJobProgress(id);
    if (progress) Object.assign(job, progress);

    const rows = await this.readJobEntryCheckpointRows(id);
    if (rows.length > 0) {
      const baseEntries = Array.isArray(job.entries) ? job.entries : [];
      const byIndex = new Map(rows.map((r) => [r.index, r.entry]));
      const maxIndex = rows.reduce((max, r) => Math.max(max, r.index), -1);
      const merged: JobEntryState[] = [];
      for (let i = 0; i < Math.max(baseEntries.length, maxIndex + 1); i += 1) {
        const checkpoint = byIndex.get(i);
        const base = baseEntries[i];
        if (checkpoint) merged[i] = checkpoint;
        else if (base) merged[i] = base;
      }
      job.entries = merged.filter((e): e is JobEntryState => Boolean(e));
    }
    return job;
  }

  async listJobs(): Promise<CrawlJob[]> {
    // 走 getJob 合并细粒度检查点，保持“作业列表/详情仍返回整批数据”的既有接口。
    const dir = this.dir('jobs');
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    const jobs: CrawlJob[] = [];
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const job = await this.getJob(f.slice(0, -'.json'.length));
      if (job) jobs.push(job);
    }
    return jobs;
  }

  private jobEntryCheckpointDir(jobId: string): string {
    return join(this.dir('job-entry-checkpoints'), jobId);
  }

  private jobEntryCheckpointPath(jobId: string, entryIndex: number): string {
    const index = String(entryIndex).padStart(12, '0');
    return join(this.jobEntryCheckpointDir(jobId), `${index}.json`);
  }

  private progressPath(jobId: string): string {
    return this.path('job-progress', jobId);
  }

  async saveJobEntryCheckpoint(jobId: string, entryIndex: number, entry: JobEntryState): Promise<void> {
    await this.atomicWriteJson(this.jobEntryCheckpointPath(jobId, entryIndex), entry);
  }

  async getJobEntryCheckpoint(jobId: string, entryIndex: number): Promise<JobEntryState | null> {
    return this.readJson<JobEntryState>(this.jobEntryCheckpointPath(jobId, entryIndex));
  }

  async listJobEntryCheckpoints(jobId: string): Promise<JobEntryState[]> {
    const rows = await this.readJobEntryCheckpointRows(jobId);
    return rows.map((r) => r.entry);
  }

  private async readJobEntryCheckpointRows(
    jobId: string,
  ): Promise<Array<{ index: number; entry: JobEntryState }>> {
    const dir = this.jobEntryCheckpointDir(jobId);
    if (!existsSync(dir)) return [];
    const files = await readdir(dir);
    const rows: Array<{ index: number; entry: JobEntryState }> = [];
    for (const f of files) {
      const match = /^(\d+)\.json$/.exec(f);
      if (!match) continue;
      const entry = await this.readJson<JobEntryState>(join(dir, f));
      if (entry) rows.push({ index: Number(match[1]), entry });
    }
    return rows.sort((a, b) => a.index - b.index);
  }

  async saveJobProgress(jobId: string, progress: JobProgressCheckpoint): Promise<void> {
    await this.atomicWriteJson(this.progressPath(jobId), progress);
    let identity = {
      sourceId: progress.sourceId ?? '',
      ruleId: progress.ruleId ?? '',
      ruleVersion: progress.ruleVersion ?? '',
    };
    if (!identity.sourceId || !identity.ruleId || !identity.ruleVersion) {
      const existingIndex = await this.readJson<JobIndexRecord>(this.jobIndexPath(jobId));
      identity = {
        sourceId: identity.sourceId || existingIndex?.sourceId || '',
        ruleId: identity.ruleId || existingIndex?.ruleId || '',
        ruleVersion: identity.ruleVersion || existingIndex?.ruleVersion || '',
      };
    }
    const index: JobIndexRecord = { jobId, ...identity, status: progress.status, updatedAt: progress.updatedAt };
    if (index.sourceId && index.ruleId && index.ruleVersion) await this.writeJobIndex(index);
  }

  getJobProgress(jobId: string): Promise<JobProgressCheckpoint | null> {
    return this.readJson<JobProgressCheckpoint>(this.progressPath(jobId));
  }

  private jobIndexPath(jobId: string): string {
    return join(this.dir('meta'), `job-index__${jobId}.json`);
  }

  private writeJobIndex(index: JobIndexRecord): Promise<void> {
    return this.atomicWriteJson(this.jobIndexPath(index.jobId), index);
  }

  async findResumableJobId(sourceId: string, ruleId: string, ruleVersion: string): Promise<string | null> {
    const matches = (j: { sourceId: string; ruleId: string; ruleVersion: string; status: string }): boolean =>
      j.sourceId === sourceId &&
      j.ruleId === ruleId &&
      j.ruleVersion === ruleVersion &&
      (j.status === 'running' || j.status === 'failed');

    const metaDir = this.dir('meta');
    const indexedIds = new Set<string>();
    if (existsSync(metaDir)) {
      const metaFiles = await readdir(metaDir);
      for (const f of metaFiles) {
        if (!f.startsWith('job-index__') || !f.endsWith('.json')) continue;
        const index = await this.readJson<JobIndexRecord>(join(metaDir, f));
        if (!index) continue;
        indexedIds.add(index.jobId);
        if (matches(index)) return index.jobId;
      }
    }

    // 兼容旧版本留下的、没有轻量索引的整份 job JSON。只扫描未建索引的文件。
    const jobDir = this.dir('jobs');
    if (!existsSync(jobDir)) return null;
    const jobFiles = await readdir(jobDir);
    for (const f of jobFiles.filter((x) => x.endsWith('.json'))) {
      const jobId = f.slice(0, -'.json'.length);
      if (indexedIds.has(jobId)) continue;
      const job = await this.readJson<CrawlJob>(join(jobDir, f));
      if (job && matches(job)) return job.jobId;
    }
    return null;
  }

  async saveRegressionReport(r: RegressionReport): Promise<void> {
    await this.atomicWriteJson(this.path('reports', r.reportId), r);
  }
  getRegressionReport(id: string): Promise<RegressionReport | null> {
    return this.readJson<RegressionReport>(this.path('reports', id));
  }
  listRegressionReports(): Promise<RegressionReport[]> {
    return this.listJson<RegressionReport>('reports');
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
