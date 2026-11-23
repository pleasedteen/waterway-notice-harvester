/**
 * 嵌入式文件存储：零外部进程，原子写（tmp+rename），发布用独立 current 指针文件，
 * 保证发布中途崩溃时 currentPublication 仍指向上一完整发布。
 */
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { LeaseLostError } from '../core/errors.js';
import type {
  Store,
  RuleDocument,
  Snapshot,
  RegressionFixture,
  CrawlJob,
  RegressionReport,
  Publication,
  SourceConfig,
  ScheduleConfig,
  SourceLease,
  LeaseAcquireResult,
  JobFence,
} from '../core/types.js';

export class EmbeddedStore implements Store {
  /** 进程内按来源串行化租约竞争（两个实例在同进程内的测试也互斥） */
  private readonly leaseMutex = new Map<string, Promise<unknown>>();
  /**
   * 进程内权威围栏视图：每次租约易主/换轮即更新。
   * 已失效的 owner 在争抢锁文件之前就被快速拒绝，避免失联实例恢复后长时间持锁阻塞他人。
   */
  private readonly fenceView = new Map<string, { ownerId: string; fencingToken: number; state: string }>();

  constructor(private readonly root: string) {}

  private dir(kind: string): string {
    return join(this.root, kind);
  }

  private path(kind: string, id: string): string {
    return join(this.dir(kind), `${id}.json`);
  }

  async init(): Promise<void> {
    for (const d of ['rules', 'snapshots', 'fixtures', 'jobs', 'reports', 'publications', 'sources', 'meta', 'schedules', 'leases', 'locks']) {
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

  async saveJob(j: CrawlJob, fence?: JobFence): Promise<void> {
    if (fence) {
      // 围栏写保护：先做无锁快速校验，再在锁内确认当前活跃租约的 owner/token 一致。
      // 旧实例被接管后的迟到结果在此被拒，不能改写进度。
      const view = this.fenceView.get(j.sourceId);
      if (view && (view.ownerId !== fence.ownerId || view.fencingToken !== fence.fencingToken || view.state !== 'active')) {
        throw new LeaseLostError(j.sourceId, fence.fencingToken, `作业写入围栏失效（快速校验）: ${j.jobId}`);
      }
      const lease = await this.readJson<SourceLease>(this.path('leases', j.sourceId));
      if (!lease || lease.state !== 'active') {
        throw new LeaseLostError(j.sourceId, fence.fencingToken, `来源 ${j.sourceId} 无活跃租约，拒绝写入作业 ${j.jobId}`);
      }
      if (lease.ownerId !== fence.ownerId || lease.fencingToken !== fence.fencingToken) {
        throw new LeaseLostError(
          j.sourceId,
          fence.fencingToken,
          `作业写入围栏失效: 当前 owner=${lease.ownerId}#${lease.fencingToken}，请求 ${fence.ownerId}#${fence.fencingToken}`,
        );
      }
    }
    await this.atomicWriteJson(this.path('jobs', j.jobId), j);
  }
  getJob(id: string): Promise<CrawlJob | null> {
    return this.readJson<CrawlJob>(this.path('jobs', id));
  }
  listJobs(): Promise<CrawlJob[]> {
    return this.listJson<CrawlJob>('jobs');
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

  /* --------------------------- 定时配置 --------------------------- */

  async saveSchedule(s: ScheduleConfig): Promise<void> {
    const existing = await this.getSchedule(s.sourceId);
    const merged: ScheduleConfig = existing
      ? { ...existing, ...s, lastTriggeredAt: s.lastTriggeredAt ?? existing.lastTriggeredAt }
      : s;
    await this.atomicWriteJson(this.path('schedules', s.sourceId), merged);
  }
  getSchedule(sourceId: string): Promise<ScheduleConfig | null> {
    return this.readJson<ScheduleConfig>(this.path('schedules', sourceId));
  }
  async listSchedules(): Promise<ScheduleConfig[]> {
    return this.listJson<ScheduleConfig>('schedules');
  }
  async touchSchedule(sourceId: string, lastTriggeredAt: string): Promise<void> {
    const existing = await this.getSchedule(sourceId);
    if (!existing) throw new Error(`定时配置不存在: ${sourceId}`);
    existing.lastTriggeredAt = lastTriggeredAt;
    existing.updatedAt = lastTriggeredAt;
    await this.atomicWriteJson(this.path('schedules', sourceId), existing);
  }

  /* --------------------------- 来源租约 --------------------------- */

  /** 进程内按 key 串行执行（同实例并发触发去重的第一道闸） */
  private async withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.leaseMutex.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.leaseMutex.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /**
   * 跨进程锁文件：mkdir 原子创建，两个实例（进程）竞争时只有一个成功；
   * 临界区只做文件读写（毫秒级），结束即释放；崩溃残留锁由 staleMs 兜底。
   */
  private async withLockFile<T>(sourceId: string, fn: () => Promise<T>): Promise<T> {
    const lockDir = join(this.dir('locks'), this.encode(sourceId));
    const staleMs = 30_000;
    const maxWaitMs = 2_000;
    const deadline = Date.now() + maxWaitMs;
    while (Date.now() < deadline) {
      try {
        await mkdir(lockDir, { recursive: false });
        await writeFile(join(lockDir, 'born'), String(Date.now()), 'utf8');
        try {
          return await fn();
        } finally {
          await rm(lockDir, { recursive: true, force: true });
        }
      } catch {
        // 锁被占：轻微等待后重试；残留锁超过 staleMs 视为死锁清理
        try {
          const born = await readFile(join(lockDir, 'born'), 'utf8').catch(() => null);
          if (born && Date.now() - Number(born) > staleMs) {
            await rm(lockDir, { recursive: true, force: true });
          }
        } catch {
          /* 忽略统计失败 */
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    }
    throw new Error(`获取来源锁超时: ${sourceId}`);
  }

  private encode(id: string): string {
    return Buffer.from(id).toString('base64url');
  }

  /** 无锁快速围栏校验：失效 owner 在争抢锁文件之前就被拒绝 */
  private assertFenceFresh(sourceId: string, fence: JobFence): void {
    const view = this.fenceView.get(sourceId);
    if (view && (view.ownerId !== fence.ownerId || view.fencingToken !== fence.fencingToken || view.state !== 'active')) {
      throw new LeaseLostError(
        sourceId,
        fence.fencingToken,
        `围栏快速校验失败: 当前 ${view.ownerId}#${view.fencingToken}(${view.state})，请求 ${fence.ownerId}#${fence.fencingToken}`,
      );
    }
  }

  private assertOwner(lease: SourceLease | null, sourceId: string, fence: JobFence): SourceLease {
    // 快速路径：进程内围栏视图先判，失效 owner 不必进入锁文件争抢
    this.assertFenceFresh(sourceId, fence);
    if (!lease || lease.state !== 'active') {
      throw new LeaseLostError(sourceId, fence.fencingToken, `来源 ${sourceId} 无活跃租约`);
    }
    if (lease.ownerId !== fence.ownerId || lease.fencingToken !== fence.fencingToken) {
      throw new LeaseLostError(
        sourceId,
        fence.fencingToken,
        `租约已易主: 当前 ${lease.ownerId}#${lease.fencingToken}，请求 ${fence.ownerId}#${fence.fencingToken}`,
      );
    }
    return lease;
  }

  private rememberFence(lease: SourceLease): void {
    this.fenceView.set(lease.sourceId, {
      ownerId: lease.ownerId,
      fencingToken: lease.fencingToken,
      state: lease.state,
    });
  }

  async acquireLease(input: {
    sourceId: string;
    ownerId: string;
    requestedRound: string;
    nowMs: number;
    takeoverTimeoutMs: number;
  }): Promise<LeaseAcquireResult> {
    const { sourceId, ownerId, requestedRound, nowMs, takeoverTimeoutMs } = input;
    return this.withMutex(`lease:${sourceId}`, () =>
      this.withLockFile(sourceId, async (): Promise<LeaseAcquireResult> => {
        const file = this.path('leases', sourceId);
        const lease = await this.readJson<SourceLease>(file);

        // 无租约 / 已释放 => 新建（同轮只在此时启动一次）
        if (!lease || lease.state === 'released') {
          const created: SourceLease = {
            sourceId,
            round: requestedRound,
            ownerId,
            fencingToken: (lease?.fencingToken ?? 0) + 1,
            state: 'active',
            createdAtMs: nowMs,
            heartbeatAtMs: nowMs,
            jobId: null,
            releaseReason: null,
            availableAfterMs: null,
            updatedAt: new Date(nowMs).toISOString(),
          };
          await this.atomicWriteJson(file, created);
          this.rememberFence(created);
          return { mode: 'acquired', lease: created };
        }

        // 自己持有且同轮 => 续期（同实例重复触发不新建）
        if (lease.ownerId === ownerId && lease.round === requestedRound) {
          lease.heartbeatAtMs = nowMs;
          lease.updatedAt = new Date(nowMs).toISOString();
          await this.atomicWriteJson(file, lease);
          this.rememberFence(lease);
          return { mode: 'renewed', lease };
        }

        // 心跳超时 => 接管：保留 round（沿用原作业与检查点），易主并递增围栏令牌
        if (nowMs - lease.heartbeatAtMs > takeoverTimeoutMs) {
          const takenOver: SourceLease = {
            ...lease,
            ownerId,
            fencingToken: lease.fencingToken + 1,
            state: 'active',
            heartbeatAtMs: nowMs,
            releaseReason: null,
            availableAfterMs: null,
            updatedAt: new Date(nowMs).toISOString(),
          };
          await this.atomicWriteJson(file, takenOver);
          this.rememberFence(takenOver);
          return { mode: 'taken_over', lease: takenOver };
        }

        // 活跃且未超时 => 拒绝（同源并发限制）
        return { mode: 'busy', lease: null, busyOwnerId: lease.ownerId };
      }),
    );
  }

  async heartbeatLease(sourceId: string, fence: JobFence, nowMs: number = Date.now()): Promise<SourceLease> {
    this.assertFenceFresh(sourceId, fence);
    return this.withMutex(`lease:${sourceId}`, () =>
      this.withLockFile(sourceId, async () => {
        const lease = this.assertOwner(await this.readJson<SourceLease>(this.path('leases', sourceId)), sourceId, fence);
        lease.heartbeatAtMs = nowMs;
        lease.updatedAt = new Date(nowMs).toISOString();
        await this.atomicWriteJson(this.path('leases', sourceId), lease);
        this.rememberFence(lease);
        return lease;
      }),
    );
  }

  async attachJobToLease(sourceId: string, fence: JobFence, jobId: string): Promise<void> {
    this.assertFenceFresh(sourceId, fence);
    await this.withMutex(`lease:${sourceId}`, () =>
      this.withLockFile(sourceId, async () => {
        const lease = this.assertOwner(await this.readJson<SourceLease>(this.path('leases', sourceId)), sourceId, fence);
        lease.jobId = jobId;
        lease.updatedAt = new Date().toISOString();
        await this.atomicWriteJson(this.path('leases', sourceId), lease);
      }),
    );
  }

  async releaseLease(
    sourceId: string,
    fence: JobFence,
    reason: string,
    nowMs: number = Date.now(),
    availableAfterMs: number | null = null,
  ): Promise<void> {
    this.assertFenceFresh(sourceId, fence);
    await this.withMutex(`lease:${sourceId}`, () =>
      this.withLockFile(sourceId, async () => {
        const lease = this.assertOwner(await this.readJson<SourceLease>(this.path('leases', sourceId)), sourceId, fence);
        lease.state = 'released';
        lease.releaseReason = reason;
        lease.availableAfterMs = availableAfterMs;
        lease.updatedAt = new Date(nowMs).toISOString();
        await this.atomicWriteJson(this.path('leases', sourceId), lease);
        this.rememberFence(lease);
      }),
    );
  }

  async getLease(sourceId: string): Promise<SourceLease | null> {
    return this.readJson<SourceLease>(this.path('leases', sourceId));
  }
}
