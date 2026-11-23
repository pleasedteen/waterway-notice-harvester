/**
 * PostgreSQL 生产存储。DDL 幂等；发布在单事务内完成（先插完整 publication/records，
 * 最后切换 current 指针），事务中断自动回滚，current 保留上一完整发布。
 */
import type { Pool } from 'pg';
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

export class PostgresStore implements Store {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS rules (
        rule_id TEXT NOT NULL, version TEXT NOT NULL, doc JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (rule_id, version)
      );
      CREATE TABLE IF NOT EXISTS snapshots (
        snapshot_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, revision TEXT NOT NULL,
        url TEXT NOT NULL, fetched_at TIMESTAMPTZ NOT NULL, status_code INT,
        content_type TEXT, html TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS fixtures (
        fixture_id TEXT PRIMARY KEY, doc JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        job_id TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS regression_reports (
        report_id TEXT PRIMARY KEY, doc JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publications (
        publication_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, doc JSONB NOT NULL,
        published_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS current_publication (
        source_id TEXT PRIMARY KEY, publication_id TEXT NOT NULL,
        published_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sources (
        source_id TEXT PRIMARY KEY, doc JSONB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS schedules (
        source_id TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS source_leases (
        source_id TEXT PRIMARY KEY, doc JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async saveRule(rule: RuleDocument): Promise<void> {
    const existing = await this.getRule(rule.ruleId, rule.version);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(rule)) {
        throw new Error(`规则版本不可变: ${rule.ruleId}@${rule.version} 已存在且内容不同`);
      }
      return;
    }
    await this.pool.query(
      `INSERT INTO rules (rule_id, version, doc, created_at) VALUES ($1,$2,$3,$4)`,
      [rule.ruleId, rule.version, JSON.stringify(rule), rule.createdAt],
    );
  }

  async getRule(ruleId: string, version: string): Promise<RuleDocument | null> {
    const r = await this.pool.query<{ doc: RuleDocument }>(
      `SELECT doc FROM rules WHERE rule_id=$1 AND version=$2`,
      [ruleId, version],
    );
    return r.rows[0]?.doc ?? null;
  }

  async listRules(ruleId?: string): Promise<RuleDocument[]> {
    const r = await this.pool.query<{ doc: RuleDocument }>(
      `SELECT doc FROM rules ${ruleId ? 'WHERE rule_id=$1' : ''} ORDER BY created_at DESC`,
      ruleId ? [ruleId] : [],
    );
    return r.rows.map((x) => x.doc);
  }

  async saveSnapshot(s: Snapshot): Promise<void> {
    await this.pool.query(
      `INSERT INTO snapshots (snapshot_id, source_id, revision, url, fetched_at, status_code, content_type, html)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (snapshot_id) DO UPDATE SET html=EXCLUDED.html, fetched_at=EXCLUDED.fetched_at`,
      [s.snapshotId, s.sourceId, s.revision, s.url, s.fetchedAt, s.statusCode, s.contentType, s.html],
    );
  }
  async getSnapshot(id: string): Promise<Snapshot | null> {
    const r = await this.pool.query(`SELECT * FROM snapshots WHERE snapshot_id=$1`, [id]);
    return (r.rows[0] as Snapshot) ?? null;
  }
  async listSnapshots(sourceId?: string): Promise<Snapshot[]> {
    const r = await this.pool.query(
      `SELECT * FROM snapshots ${sourceId ? 'WHERE source_id=$1' : ''} ORDER BY fetched_at`,
      sourceId ? [sourceId] : [],
    );
    return r.rows as Snapshot[];
  }

  async saveFixture(f: RegressionFixture): Promise<void> {
    await this.pool.query(
      `INSERT INTO fixtures (fixture_id, doc) VALUES ($1,$2) ON CONFLICT (fixture_id) DO UPDATE SET doc=EXCLUDED.doc`,
      [f.fixtureId, JSON.stringify(f)],
    );
  }
  async getFixture(id: string): Promise<RegressionFixture | null> {
    const r = await this.pool.query<{ doc: RegressionFixture }>(`SELECT doc FROM fixtures WHERE fixture_id=$1`, [id]);
    return r.rows[0]?.doc ?? null;
  }
  async listFixtures(): Promise<RegressionFixture[]> {
    const r = await this.pool.query<{ doc: RegressionFixture }>(`SELECT doc FROM fixtures`);
    return r.rows.map((x) => x.doc);
  }

  async saveJob(j: CrawlJob, fence?: JobFence): Promise<void> {
    if (fence) {
      // 围栏写保护：行锁 + owner/token 校验，旧实例迟到的作业写入被拒
      const guard = await this.pool.query<{ doc: SourceLease }>(
        `SELECT doc FROM source_leases WHERE source_id=$1 FOR UPDATE`,
        [j.sourceId],
      );
      const lease = guard.rows[0]?.doc;
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
    await this.pool.query(
      `INSERT INTO jobs (job_id, doc, updated_at) VALUES ($1,$2,$3)
       ON CONFLICT (job_id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=EXCLUDED.updated_at`,
      [j.jobId, JSON.stringify(j), j.updatedAt],
    );
  }
  async getJob(id: string): Promise<CrawlJob | null> {
    const r = await this.pool.query<{ doc: CrawlJob }>(`SELECT doc FROM jobs WHERE job_id=$1`, [id]);
    return r.rows[0]?.doc ?? null;
  }
  async listJobs(): Promise<CrawlJob[]> {
    const r = await this.pool.query<{ doc: CrawlJob }>(`SELECT doc FROM jobs ORDER BY updated_at DESC`);
    return r.rows.map((x) => x.doc);
  }

  async saveRegressionReport(rep: RegressionReport): Promise<void> {
    await this.pool.query(
      `INSERT INTO regression_reports (report_id, doc) VALUES ($1,$2)
       ON CONFLICT (report_id) DO UPDATE SET doc=EXCLUDED.doc`,
      [rep.reportId, JSON.stringify(rep)],
    );
  }
  async getRegressionReport(id: string): Promise<RegressionReport | null> {
    const r = await this.pool.query<{ doc: RegressionReport }>(`SELECT doc FROM regression_reports WHERE report_id=$1`, [id]);
    return r.rows[0]?.doc ?? null;
  }
  async listRegressionReports(): Promise<RegressionReport[]> {
    const r = await this.pool.query<{ doc: RegressionReport }>(`SELECT doc FROM regression_reports`);
    return r.rows.map((x) => x.doc);
  }

  async commitPublication(pub: Publication): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO publications (publication_id, source_id, doc, published_at) VALUES ($1,$2,$3,$4)
         ON CONFLICT (publication_id) DO NOTHING`,
        [pub.publicationId, pub.sourceId, JSON.stringify(pub), pub.publishedAt],
      );
      await client.query(
        `INSERT INTO current_publication (source_id, publication_id, published_at) VALUES ($1,$2,$3)
         ON CONFLICT (source_id) DO UPDATE SET publication_id=EXCLUDED.publication_id, published_at=EXCLUDED.published_at`,
        [pub.sourceId, pub.publicationId, pub.publishedAt],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async getCurrentPublication(sourceId: string): Promise<Publication | null> {
    const r = await this.pool.query<{ publication_id: string }>(
      `SELECT publication_id FROM current_publication WHERE source_id=$1`,
      [sourceId],
    );
    const id = r.rows[0]?.publication_id;
    return id ? this.getPublication(id) : null;
  }
  async getPublication(id: string): Promise<Publication | null> {
    const r = await this.pool.query<{ doc: Publication }>(`SELECT doc FROM publications WHERE publication_id=$1`, [id]);
    return r.rows[0]?.doc ?? null;
  }
  async listPublications(sourceId?: string): Promise<Publication[]> {
    const r = await this.pool.query<{ doc: Publication }>(
      `SELECT doc FROM publications ${sourceId ? 'WHERE source_id=$1' : ''} ORDER BY published_at DESC`,
      sourceId ? [sourceId] : [],
    );
    return r.rows.map((x) => x.doc);
  }

  async saveSource(s: SourceConfig): Promise<void> {
    await this.pool.query(
      `INSERT INTO sources (source_id, doc) VALUES ($1,$2) ON CONFLICT (source_id) DO UPDATE SET doc=EXCLUDED.doc`,
      [s.sourceId, JSON.stringify(s)],
    );
  }
  async getSource(id: string): Promise<SourceConfig | null> {
    const r = await this.pool.query<{ doc: SourceConfig }>(`SELECT doc FROM sources WHERE source_id=$1`, [id]);
    return r.rows[0]?.doc ?? null;
  }
  async listSources(): Promise<SourceConfig[]> {
    const r = await this.pool.query<{ doc: SourceConfig }>(`SELECT doc FROM sources`);
    return r.rows.map((x) => x.doc);
  }

  /* --------------------------- 定时配置 --------------------------- */

  async saveSchedule(s: ScheduleConfig): Promise<void> {
    const existing = await this.getSchedule(s.sourceId);
    const merged: ScheduleConfig = existing
      ? { ...existing, ...s, lastTriggeredAt: s.lastTriggeredAt ?? existing.lastTriggeredAt }
      : s;
    await this.pool.query(
      `INSERT INTO schedules (source_id, doc, updated_at) VALUES ($1,$2,now())
       ON CONFLICT (source_id) DO UPDATE SET doc=EXCLUDED.doc, updated_at=now()`,
      [s.sourceId, JSON.stringify(merged)],
    );
  }
  async getSchedule(sourceId: string): Promise<ScheduleConfig | null> {
    const r = await this.pool.query<{ doc: ScheduleConfig }>(`SELECT doc FROM schedules WHERE source_id=$1`, [sourceId]);
    return r.rows[0]?.doc ?? null;
  }
  async listSchedules(): Promise<ScheduleConfig[]> {
    const r = await this.pool.query<{ doc: ScheduleConfig }>(`SELECT doc FROM schedules ORDER BY source_id`);
    return r.rows.map((x) => x.doc);
  }
  async touchSchedule(sourceId: string, lastTriggeredAt: string): Promise<void> {
    const existing = await this.getSchedule(sourceId);
    if (!existing) throw new Error(`定时配置不存在: ${sourceId}`);
    existing.lastTriggeredAt = lastTriggeredAt;
    existing.updatedAt = lastTriggeredAt;
    await this.pool.query(
      `UPDATE schedules SET doc=$2, updated_at=now() WHERE source_id=$1`,
      [sourceId, JSON.stringify(existing)],
    );
  }

  /* --------------------------- 来源租约 --------------------------- */

  async acquireLease(input: {
    sourceId: string;
    ownerId: string;
    requestedRound: string;
    nowMs: number;
    takeoverTimeoutMs: number;
  }): Promise<LeaseAcquireResult> {
    const { sourceId, ownerId, requestedRound, nowMs, takeoverTimeoutMs } = input;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // 行锁串行化两个实例的竞争（无行则插入空壳后再锁）
      await client.query(
        `INSERT INTO source_leases (source_id, doc) VALUES ($1, $2)
         ON CONFLICT (source_id) DO NOTHING`,
        [sourceId, JSON.stringify({ sourceId, placeholder: true })],
      );
      const res = await client.query<{ doc: SourceLease }>(
        `SELECT doc FROM source_leases WHERE source_id=$1 FOR UPDATE`,
        [sourceId],
      );
      const lease = res.rows[0]?.doc as SourceLease | undefined;
      const iso = new Date(nowMs).toISOString();

      if (!lease || lease.state === 'released' || (lease as { placeholder?: boolean }).placeholder) {
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
          updatedAt: iso,
        };
        await client.query(`UPDATE source_leases SET doc=$2, updated_at=now() WHERE source_id=$1`, [
          sourceId,
          JSON.stringify(created),
        ]);
        await client.query('COMMIT');
        return { mode: 'acquired', lease: created };
      }

      if (lease.ownerId === ownerId && lease.round === requestedRound) {
        lease.heartbeatAtMs = nowMs;
        lease.updatedAt = iso;
        await client.query(`UPDATE source_leases SET doc=$2, updated_at=now() WHERE source_id=$1`, [
          sourceId,
          JSON.stringify(lease),
        ]);
        await client.query('COMMIT');
        return { mode: 'renewed', lease };
      }

      if (nowMs - lease.heartbeatAtMs > takeoverTimeoutMs) {
        const takenOver: SourceLease = {
          ...lease,
          ownerId,
          fencingToken: lease.fencingToken + 1,
          state: 'active',
          heartbeatAtMs: nowMs,
          releaseReason: null,
          availableAfterMs: null,
          updatedAt: iso,
        };
        await client.query(`UPDATE source_leases SET doc=$2, updated_at=now() WHERE source_id=$1`, [
          sourceId,
          JSON.stringify(takenOver),
        ]);
        await client.query('COMMIT');
        return { mode: 'taken_over', lease: takenOver };
      }

      await client.query('COMMIT');
      return { mode: 'busy', lease: null, busyOwnerId: lease.ownerId };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  private async withLockedLease<T>(
    sourceId: string,
    fence: JobFence,
    fn: (lease: SourceLease) => Promise<{ lease: SourceLease; result: T } | { lease: SourceLease }>,
  ): Promise<T | void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const res = await client.query<{ doc: SourceLease }>(
        `SELECT doc FROM source_leases WHERE source_id=$1 FOR UPDATE`,
        [sourceId],
      );
      const lease = res.rows[0]?.doc;
      if (!lease || lease.state !== 'active' || lease.ownerId !== fence.ownerId || lease.fencingToken !== fence.fencingToken) {
        throw new LeaseLostError(
          sourceId,
          fence.fencingToken,
          `租约校验失败: ${lease ? `${lease.ownerId}#${lease.fencingToken}` : '无租约'} vs ${fence.ownerId}#${fence.fencingToken}`,
        );
      }
      const out = await fn(lease);
      await client.query(`UPDATE source_leases SET doc=$2, updated_at=now() WHERE source_id=$1`, [
        sourceId,
        JSON.stringify(out.lease),
      ]);
      await client.query('COMMIT');
      return 'result' in out ? out.result : undefined;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async heartbeatLease(sourceId: string, fence: JobFence, nowMs: number = Date.now()): Promise<SourceLease> {
    return (await this.withLockedLease(sourceId, fence, async (lease) => {
      lease.heartbeatAtMs = nowMs;
      lease.updatedAt = new Date(nowMs).toISOString();
      return { lease, result: lease };
    })) as SourceLease;
  }

  async attachJobToLease(sourceId: string, fence: JobFence, jobId: string): Promise<void> {
    await this.withLockedLease(sourceId, fence, async (lease) => {
      lease.jobId = jobId;
      lease.updatedAt = new Date().toISOString();
      return { lease };
    });
  }

  async releaseLease(
    sourceId: string,
    fence: JobFence,
    reason: string,
    nowMs: number = Date.now(),
    availableAfterMs: number | null = null,
  ): Promise<void> {
    await this.withLockedLease(sourceId, fence, async (lease) => {
      lease.state = 'released';
      lease.releaseReason = reason;
      lease.availableAfterMs = availableAfterMs;
      lease.updatedAt = new Date(nowMs).toISOString();
      return { lease };
    });
  }

  async getLease(sourceId: string): Promise<SourceLease | null> {
    const r = await this.pool.query<{ doc: SourceLease }>(`SELECT doc FROM source_leases WHERE source_id=$1`, [sourceId]);
    const lease = r.rows[0]?.doc;
    return lease && !(lease as { placeholder?: boolean }).placeholder ? lease : null;
  }
}

export type { BusinessRecord } from '../core/types.js';
