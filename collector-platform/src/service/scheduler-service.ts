/**
 * 按来源定时采集调度器：
 *  - 通过接口配置采集间隔与规则版本，到点自动推进作业，发布仍由人工确认（本服务不调用发布）；
 *  - 两个实例共用数据时，以来源租约保证同一来源同一轮只启动一次，手动续跑同样受同源并发限制；
 *  - 每个来源一条独立异步链：一个来源请求挂起不会拖住其他来源；
 *  - 推进实例失联（心跳超过接管时限）后，另一实例沿用同一轮/同一作业接管，
 *    保留规则版本与已确认页检查点、不重抓已确认页；围栏令牌保证旧实例迟到结果不能改写进度。
 */
import { randomUUID } from 'node:crypto';
import { SystemClock, type Clock } from '../core/clock.js';
import { LeaseBusyError, LeaseLostError } from '../core/errors.js';
import { nowIso } from '../core/ids.js';
import type { Fetcher } from '../fetch/fetcher.js';
import { CrawlService } from './crawl-service.js';
import {
  IDLE_JOB_STATUSES,
  type CrawlJob,
  type JobFence,
  type RuleDocument,
  type ScheduleConfig,
  type SourceLease,
  type Store,
} from '../core/types.js';

export interface SchedulerOptions {
  store: Store;
  /** 按来源产出抓取器（每次运行独立实例，避免跨来源状态串扰） */
  fetcherFactory: (sourceId: string) => Fetcher;
  clock?: Clock;
  /** 实例标识；缺省随机生成（两个实例必须不同） */
  instanceId?: string;
  /** 后台 tick 周期毫秒，默认 200 */
  tickMs?: number;
  /** 失败作业退避毫秒，默认 5000（手动续跑忽略退避） */
  failureBackoffMs?: number;
}

export interface UpsertScheduleInput {
  sourceId: string;
  name: string;
  seedUrl: string;
  ruleId: string;
  ruleVersion: string;
  intervalMs: number;
  takeoverTimeoutMs: number;
  maxEntriesPerCall?: number;
  enabled?: boolean;
}

export interface ManualStartInput {
  sourceId: string;
  seedUrl: string;
  rule: RuleDocument;
  /** 覆盖定时配置中的接管时限（可选） */
  takeoverTimeoutMs?: number;
}

/** 手动/调度一次推进的结果 */
export interface StepResult {
  outcome: 'started' | 'resumed' | 'taken_over' | 'busy' | 'cooldown' | 'idle' | 'lease_lost';
  job: CrawlJob | null;
  lease: SourceLease | null;
  detail?: string;
}

export class SchedulerService {
  private readonly store: Store;
  private readonly fetcherFactory: (sourceId: string) => Fetcher;
  private readonly clock: Clock;
  private readonly instanceId: string;
  private readonly tickMs: number;
  private readonly failureBackoffMs: number;
  /** 本实例正在推进的来源（独立异步链），保证同进程内同来源不并发 */
  private readonly running = new Set<string>();
  /** 每个来源当前运行链的 Promise（测试/优雅停机可确定性等待，而非靠固定 sleep） */
  private readonly inflight = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SchedulerOptions) {
    this.store = opts.store;
    this.fetcherFactory = opts.fetcherFactory;
    this.clock = opts.clock ?? new SystemClock();
    this.instanceId = opts.instanceId ?? `inst_${randomUUID().slice(0, 8)}`;
    this.tickMs = opts.tickMs ?? 200;
    this.failureBackoffMs = opts.failureBackoffMs ?? 5000;
  }

  get id(): string {
    return this.instanceId;
  }

  /* ------------------------------ 定时配置 ------------------------------ */

  async upsertSchedule(input: UpsertScheduleInput): Promise<ScheduleConfig> {
    if (!Number.isFinite(input.intervalMs) || input.intervalMs < 1) {
      throw new Error('采集间隔 intervalMs 必须为正整数毫秒');
    }
    if (!Number.isFinite(input.takeoverTimeoutMs) || input.takeoverTimeoutMs < 1) {
      throw new Error('接管时限 takeoverTimeoutMs 必须为正整数毫秒');
    }
    const rule = await this.store.getRule(input.ruleId, input.ruleVersion);
    if (!rule) throw new Error(`规则版本不存在: ${input.ruleId}@${input.ruleVersion}`);
    const existing = await this.store.getSchedule(input.sourceId);
    const schedule: ScheduleConfig = {
      sourceId: input.sourceId,
      name: input.name,
      seedUrl: input.seedUrl,
      ruleId: input.ruleId,
      ruleVersion: input.ruleVersion,
      intervalMs: input.intervalMs,
      takeoverTimeoutMs: input.takeoverTimeoutMs,
      maxEntriesPerCall: input.maxEntriesPerCall,
      enabled: input.enabled ?? existing?.enabled ?? true,
      createdAt: existing?.createdAt ?? nowIso(),
      updatedAt: nowIso(),
      lastTriggeredAt: existing?.lastTriggeredAt ?? null,
    };
    await this.store.saveSchedule(schedule);
    return schedule;
  }

  async setEnabled(sourceId: string, enabled: boolean): Promise<ScheduleConfig> {
    const s = await this.store.getSchedule(sourceId);
    if (!s) throw new Error(`定时配置不存在: ${sourceId}`);
    s.enabled = enabled;
    s.updatedAt = nowIso();
    await this.store.saveSchedule(s);
    return s;
  }

  listSchedules(): Promise<ScheduleConfig[]> {
    return this.store.listSchedules();
  }

  /* ------------------------------ 生命周期 ------------------------------ */

  start(): void {
    if (this.timer !== null) return;
    this.timer = this.clock.setInterval(() => {
      void this.tick().catch((e) => {
        if (!(e instanceof LeaseLostError)) console.error(`[${this.instanceId}] 调度 tick 异常:`, (e as Error).message);
      });
    }, this.tickMs);
  }

  stop(): void {
    if (this.timer !== null) {
      this.clock.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 一轮后台检查：接管过期租约 + 到点推进；每个来源独立异步链，互不阻塞 */
  async tick(): Promise<void> {
    const schedules = await this.store.listSchedules();
    await Promise.all(
      schedules
        .filter((s) => s.enabled)
        .map((s) =>
          this.evaluateSource(s).catch((e) => {
            console.error(`[${this.instanceId}] 来源 ${s.sourceId} 调度失败:`, (e as Error).message);
          }),
        ),
    );
  }

  /** 单个来源的调度评估（挂起的请求只挂在该来源自己的链上） */
  private async evaluateSource(schedule: ScheduleConfig): Promise<void> {
    if (this.running.has(schedule.sourceId)) return; // 本实例同来源不并发
    const now = this.clock.nowMs();
    const lease = await this.store.getLease(schedule.sourceId);

    // 1. 活跃租约心跳超时 => 优先接管原作业（无论间隔是否到点）
    if (lease && lease.state === 'active' && now - lease.heartbeatAtMs > schedule.takeoverTimeoutMs) {
      await this.startTracked(schedule, { takeOver: true });
      return;
    }

    // 2. 失败退避未到期 => 跳过（手动续跑不受此限）
    if (lease?.availableAfterMs && now < lease.availableAfterMs) return;

    // 3. 间隔门控：到点才开新一轮。上一轮完成/释放后也必须等满间隔，避免完成即重抓
    const due =
      schedule.lastTriggeredAt === null ||
      now - Date.parse(schedule.lastTriggeredAt) >= schedule.intervalMs;
    if (!due) return;

    await this.startTracked(schedule, {});
  }

  /* ------------------------------ 租约运行 ------------------------------ */

  private nextRound(schedule: ScheduleConfig, lease: SourceLease | null): string {
    const seq = lease ? Number(lease.round.split('#')[1] ?? '0') + 1 : 1;
    return `${schedule.sourceId}#r${seq}`;
  }

  /**
   * 尝试获取租约并在独立异步链中推进。
   * busy（别的实例持有且未超时）直接放弃，保证同来源同轮只启动一次。
   */
  private async startTracked(
    schedule: ScheduleConfig,
    opts: { takeOver?: boolean },
  ): Promise<void> {
    if (this.running.has(schedule.sourceId)) return;
    const lease0 = await this.store.getLease(schedule.sourceId);
    const requestedRound = opts.takeOver && lease0 ? lease0.round : this.nextRound(schedule, lease0);
    const acquired = await this.store.acquireLease({
      sourceId: schedule.sourceId,
      ownerId: this.instanceId,
      requestedRound,
      nowMs: this.clock.nowMs(),
      takeoverTimeoutMs: schedule.takeoverTimeoutMs,
    });
    if (acquired.mode === 'busy') return; // 同源并发限制：另一实例正在推进
    const lease = acquired.lease!;

    // 记录到点时间（接管不算新一轮触发，不重置间隔门控）
    if (acquired.mode === 'acquired') {
      await this.store.touchSchedule(schedule.sourceId, new Date(this.clock.nowMs()).toISOString());
    }

    this.running.add(schedule.sourceId);
    const chain = this.runWithLease(schedule, lease).finally(() => {
      this.running.delete(schedule.sourceId);
      this.inflight.delete(schedule.sourceId);
    });
    this.inflight.set(schedule.sourceId, chain);
  }

  /** 等待本实例某来源当前运行链结束（无运行则立即返回） */
  async waitIdle(sourceId: string): Promise<void> {
    await this.inflight.get(sourceId);
  }

  /** 等待本实例所有来源的运行链结束 */
  async waitAllIdle(): Promise<void> {
    while (this.inflight.size > 0) {
      await Promise.all([...this.inflight.values()]);
    }
  }

  /** 持有租约期间的完整推进链：心跳 + 围栏保护下跑到空闲态 */
  private async runWithLease(schedule: ScheduleConfig, lease: SourceLease): Promise<void> {
    const sourceId = schedule.sourceId;
    const fence: JobFence = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
    const guard = async (): Promise<void> => {
      const fresh = await this.store.heartbeatLease(sourceId, fence, this.clock.nowMs());
      if (fresh.round !== lease.round) {
        throw new LeaseLostError(sourceId, fence.fencingToken, `轮次已变化: ${lease.round} -> ${fresh.round}`);
      }
    };

    const crawl = new CrawlService(this.store, this.fetcherFactory(sourceId)).withFence(fence, guard);
    let job: CrawlJob;
    try {
      job = await crawl.startOrResume({
        sourceId,
        seedUrl: schedule.seedUrl,
        rule: (await this.store.getRule(schedule.ruleId, schedule.ruleVersion))!,
        round: lease.round,
      });
      if (!lease.jobId) await this.store.attachJobToLease(sourceId, fence, job.jobId);

      // 自动推进直到作业进入空闲态；每步前心跳，挂起的 fetch 只会停在本来源链上
      let current = job;
      let guard2 = 0;
      while (!IDLE_JOB_STATUSES.has(current.status) && guard2 < 1000) {
        guard2 += 1;
        await guard();
        current = await crawl.run(current.jobId, { maxEntriesPerCall: schedule.maxEntriesPerCall });
      }

      if (current.status === 'failed') {
        // 失败退避后再允许下一轮，避免故障期空转；检查点已保留，续跑不重抓已确认页
        await this.store.releaseLease(
          sourceId,
          fence,
          `作业失败待续跑: ${current.lastError ?? '未知错误'}`,
          this.clock.nowMs(),
          this.clock.nowMs() + this.failureBackoffMs,
        );
        return;
      }
      // completed / edition_changed 等：释放租约，发布留给人工确认
      await this.store.releaseLease(sourceId, fence, `作业进入 ${current.status}`, this.clock.nowMs());
    } catch (e) {
      if (e instanceof LeaseLostError) {
        // 已被接管：本实例立即停手，不释放、不重试（迟到写入也已被围栏拒绝）
        console.warn(`[${this.instanceId}] 来源 ${sourceId} 租约失效，停止推进: ${e.message}`);
        return;
      }
      // 其他异常：释放租约让其他实例/下一轮可以接手
      await this.store
        .releaseLease(sourceId, fence, `推进异常: ${(e as Error).message}`, this.clock.nowMs())
        .catch(() => undefined);
      throw e;
    }
  }

  /* ------------------------------ 人工入口（同样受同源并发限制） ------------------------------ */

  /**
   * 人工启动/续跑：获取租约 -> 启动或回到同轮作业 -> 立即释放（不长期占用）。
   * 关键：未完成作业所属轮次会被复用，因此"启动-释放-续跑"始终落在同一作业上。
   */
  async manualStart(input: ManualStartInput): Promise<StepResult> {
    const schedule = await this.requireLeasable(input.sourceId, input.takeoverTimeoutMs);
    if (this.running.has(input.sourceId)) {
      return { outcome: 'busy', job: null, lease: null, detail: '本实例正在推进该来源' };
    }
    const requestedRound = await this.roundForManual(input.sourceId, schedule);
    const acquired = await this.store.acquireLease({
      sourceId: input.sourceId,
      ownerId: this.instanceId,
      requestedRound,
      nowMs: this.clock.nowMs(),
      takeoverTimeoutMs: schedule.takeoverTimeoutMs,
    });
    if (acquired.mode === 'busy') {
      throw new LeaseBusyError(input.sourceId, acquired.busyOwnerId!);
    }
    const lease = acquired.lease!;
    const fence: JobFence = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
    try {
      const crawl = new CrawlService(this.store, this.fetcherFactory(input.sourceId)).withFence(fence, async () => {
        await this.store.heartbeatLease(input.sourceId, fence, this.clock.nowMs());
      });
      const job = await crawl.startOrResume({
        sourceId: input.sourceId,
        seedUrl: input.seedUrl,
        rule: input.rule,
        round: lease.round,
      });
      await this.store.attachJobToLease(input.sourceId, fence, job.jobId).catch(() => undefined);
      return {
        outcome: acquired.mode === 'taken_over' ? 'taken_over' : job.entries.length > 0 ? 'resumed' : 'started',
        job,
        lease,
      };
    } finally {
      await this.store
        .releaseLease(input.sourceId, fence, '人工启动完成，等待续跑', this.clock.nowMs())
        .catch(() => undefined);
    }
  }

  /** 人工推进一个检查点步长；来源被其他实例持有时按同源并发限制拒绝 */
  async manualRunStep(jobId: string, maxEntriesPerCall?: number): Promise<StepResult> {
    const job0 = await this.store.getJob(jobId);
    if (!job0) throw new Error(`作业不存在: ${jobId}`);
    const schedule = await this.requireLeasable(job0.sourceId);
    if (this.running.has(job0.sourceId)) {
      return { outcome: 'busy', job: job0, lease: null, detail: '本实例正在推进该来源' };
    }
    // 续跑沿用作业自身轮次（同源并发限制的粒度），保证多次手动续跑推进同一作业
    const requestedRound = job0.round ?? (await this.roundForManual(job0.sourceId, schedule));
    const acquired = await this.store.acquireLease({
      sourceId: job0.sourceId,
      ownerId: this.instanceId,
      requestedRound,
      nowMs: this.clock.nowMs(),
      takeoverTimeoutMs: schedule.takeoverTimeoutMs,
    });
    if (acquired.mode === 'busy') {
      throw new LeaseBusyError(job0.sourceId, acquired.busyOwnerId!);
    }
    const lease = acquired.lease!;
    const fence: JobFence = { ownerId: lease.ownerId, fencingToken: lease.fencingToken };
    try {
      const crawl = new CrawlService(this.store, this.fetcherFactory(job0.sourceId)).withFence(fence, async () => {
        await this.store.heartbeatLease(job0.sourceId, fence, this.clock.nowMs());
      });
      const job = await crawl.run(jobId, { maxEntriesPerCall });
      return {
        outcome: IDLE_JOB_STATUSES.has(job.status) ? 'idle' : acquired.mode === 'taken_over' ? 'taken_over' : 'resumed',
        job,
        lease,
      };
    } finally {
      await this.store
        .releaseLease(job0.sourceId, fence, '人工续跑一步完成', this.clock.nowMs())
        .catch(() => undefined);
    }
  }

  /**
   * 人工操作应使用的轮次：
   *  - 存在活跃租约 => 沿用其轮次（同轮并发限制）；
   *  - 存在未完成作业 => 沿用该作业的轮次（启动后续跑同一作业，不新开轮）；
   *  - 否则开新一轮。
   */
  private async roundForManual(sourceId: string, schedule: ScheduleConfig): Promise<string> {
    const lease = await this.store.getLease(sourceId);
    if (lease && lease.state === 'active') return lease.round;
    const unfinished = (await this.store.listJobs()).find(
      (j) => j.sourceId === sourceId && (j.status === 'running' || j.status === 'failed'),
    );
    if (unfinished?.round) return unfinished.round;
    return this.nextRound(schedule, lease);
  }

  /** 找到可用于租约判定的定时配置；HTTP 手动路径对未配置来源给出兜底配置 */
  private async requireLeasable(sourceId: string, overrideTimeoutMs?: number): Promise<ScheduleConfig> {
    const s = await this.store.getSchedule(sourceId);
    if (s) return s;
    // 未显式配置定时的来源，手动操作仍受同源并发限制（给一个保守的默认接管时限）
    return {
      sourceId,
      name: sourceId,
      seedUrl: '',
      ruleId: '',
      ruleVersion: '',
      intervalMs: Number.MAX_SAFE_INTEGER,
      takeoverTimeoutMs: overrideTimeoutMs ?? 30_000,
      enabled: false,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      lastTriggeredAt: null,
    };
  }
}
