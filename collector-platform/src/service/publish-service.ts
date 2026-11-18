/**
 * 发布服务。发布前置条件（任一不满足即拒绝）：
 *  1. 作业状态 completed（完整批次，无失败条目、无换版）；
 *  2. 列表发现完整（未达到上限截断、无未采下一页）；
 *  3. 全部条目来自同一来源修订；
 *  4. 作业使用的规则版本与待发布规则完全一致；
 *  5. 批次离线重放通过：按候选规则用作业快照重放列表发现、预取与详情续页，
 *     与检查点逐条一致（漏页/证据不足 => 拒绝，上一版本继续生效）；
 *  6. 该规则版本在全部相关夹具上回归通过（旧详情夹具逐字段比对）；
 *  7. 规则文档与整批结果在同一原子事务内一起生效。
 * 发布中途重启：current 指针未切换前，上一完整发布保持可读。
 */
import { newId, nowIso } from '../core/ids.js';
import { replayBatch } from './batch-replay.js';
import type { CrawlJob, Publication, RegressionReport, RuleDocument, Store } from '../core/types.js';

export interface PublishDecision {
  allowed: boolean;
  reasons: string[];
  reports: RegressionReport[];
}

export class PublishService {
  constructor(private readonly store: Store) {}

  async evaluate(jobId: string, rule: RuleDocument): Promise<PublishDecision> {
    const reasons: string[] = [];
    const job = await this.store.getJob(jobId);
    if (!job) return { allowed: false, reasons: [`作业不存在: ${jobId}`], reports: [] };

    if (job.status !== 'completed') reasons.push(`作业状态为 ${job.status}，仅 completed 可发布`);
    if (job.listDiscovery && job.listDiscovery !== 'completed') {
      reasons.push(`列表发现状态为 ${job.listDiscovery}（${job.listNextUrl ?? '无待采页'}），批次不完整`);
    }
    if (job.ruleId !== rule.ruleId || job.ruleVersion !== rule.version) {
      reasons.push(`规则版本不一致: 作业使用 ${job.ruleId}@${job.ruleVersion}，候选 ${rule.ruleId}@${rule.version}`);
    }
    const revisions = new Set<string>();
    for (const e of job.entries) {
      for (const sid of e.snapshotIds) {
        const snap = await this.store.getSnapshot(sid);
        if (snap) revisions.add(snap.revision.split(':')[0] ?? snap.revision);
      }
    }
    if (revisions.size > 1) reasons.push(`批次包含多个来源修订: ${[...revisions].join(', ')}`);
    if (job.entries.some((e) => e.status !== 'done' || !e.record)) reasons.push('存在未完成条目，批次不完整');

    // 批次离线重放：候选规则 + 作业快照，重放列表发现/预取/详情续页并逐条比对
    if (job.status === 'completed' && job.ruleId === rule.ruleId && job.ruleVersion === rule.version) {
      const replay = await replayBatch(job, rule, this.store);
      for (const p of replay.problems) reasons.push(`批次离线重放: ${p}`);
    }

    const reports = await this.runRegression(rule, job.sourceId, job.expectedRevision);
    const failed = reports.filter((r) => !r.passed);
    if (reports.length === 0) reasons.push('没有任何回归夹具，拒绝无回归发布');
    if (failed.length > 0) reasons.push(`回归未通过: ${failed.map((r) => `${r.fixtureId}(${r.failures}失败/${r.typeIncompatibilities}类型不兼容)`).join('; ')}`);

    return { allowed: reasons.length === 0, reasons, reports };
  }

  private async runRegression(rule: RuleDocument, sourceId: string, sourceRevision: string): Promise<RegressionReport[]> {
    const { RegressionService } = await import('./regression-service.js');
    const svc = new RegressionService(this.store);
    const all = await svc.replayAll(rule, sourceId);
    // 仅与本批次来源修订一致的夹具构成发布门禁（其他修订的夹具仍可用于对比/归因）
    const fixtures = await this.store.listFixtures();
    const matchingIds = new Set(
      fixtures
        .filter((f) => f.sourceId === sourceId && this.revisionFamily(f.expectedRevision) === this.revisionFamily(sourceRevision))
        .map((f) => f.fixtureId),
    );
    return all.filter((r) => matchingIds.has(r.fixtureId));
  }

  private revisionFamily(rev: string): string {
    // 来源修订可能是版本号或"版本:哈希"，取版本族
    return rev.split(':')[0] ?? rev;
  }

  async publish(jobId: string, rule: RuleDocument, note?: string): Promise<Publication> {
    const decision = await this.evaluate(jobId, rule);
    if (!decision.allowed) {
      throw new Error(`发布被拒绝:\n - ${decision.reasons.join('\n - ')}`);
    }
    const job = (await this.store.getJob(jobId)) as CrawlJob;
    const records = job.entries.map((e) => e.record!).filter(Boolean);
    const sourceRevision = job.expectedRevision;
    const pub: Publication = {
      publicationId: newId('pub'),
      sourceId: job.sourceId,
      ruleId: rule.ruleId,
      ruleVersion: rule.version,
      sourceRevision,
      jobId: job.jobId,
      regressionReportIds: decision.reports.map((r) => r.reportId),
      records,
      publishedAt: nowIso(),
      note,
    };
    await this.store.commitPublication(pub);
    job.publicationId = pub.publicationId;
    job.updatedAt = nowIso();
    await this.store.saveJob(job);
    return pub;
  }

  async history(sourceId: string): Promise<Publication[]> {
    return this.store.listPublications(sourceId);
  }

  async current(sourceId: string): Promise<Publication | null> {
    return this.store.getCurrentPublication(sourceId);
  }
}
