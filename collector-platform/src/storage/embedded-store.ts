/**
 * 嵌入式文件存储：零外部进程，原子写（tmp+rename），发布用独立 current 指针文件，
 * 保证发布中途崩溃时 currentPublication 仍指向上一完整发布。
 */
import { mkdir, readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type {
  Store,
  RuleDocument,
  Snapshot,
  RegressionFixture,
  CrawlJob,
  RegressionReport,
  Publication,
  SourceConfig,
  PageAttempt,
} from '../core/types.js';

export class EmbeddedStore implements Store {
  constructor(private readonly root: string) {}

  private dir(kind: string): string {
    return join(this.root, kind);
  }

  private path(kind: string, id: string): string {
    return join(this.dir(kind), `${id}.json`);
  }

  async init(): Promise<void> {
    for (const d of ['rules', 'snapshots', 'fixtures', 'jobs', 'reports', 'publications', 'sources', 'meta', 'attempts']) {
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
    await this.atomicWriteJson(this.path('jobs', j.jobId), j);
  }
  getJob(id: string): Promise<CrawlJob | null> {
    return this.readJson<CrawlJob>(this.path('jobs', id));
  }
  listJobs(): Promise<CrawlJob[]> {
    return this.listJson<CrawlJob>('jobs');
  }

  /**
   * 页面尝试只追加不改写历史：终态与登记态共用同一文件名（同一 attemptId 的两份原子写），
   * 重启产生的新尝试永远使用新 attemptId/新文件，因此旧的 in_flight 记录原样保留。
   */
  async savePageAttempt(a: PageAttempt): Promise<void> {
    await this.atomicWriteJson(join(this.dir('attempts'), `${a.jobId}__${a.attemptId}.json`), a);
  }

  async listPageAttempts(jobId: string): Promise<PageAttempt[]> {
    const dir = this.dir('attempts');
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => f.startsWith(`${jobId}__`) && f.endsWith('.json'));
    const out: PageAttempt[] = [];
    for (const f of files) {
      const v = await this.readJson<PageAttempt>(join(dir, f));
      if (v) out.push(v);
    }
    // 先按开始时间，再按尝试 id：同一时刻（强杀前后）也能稳定区分新旧尝试
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.attemptId.localeCompare(b.attemptId));
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
