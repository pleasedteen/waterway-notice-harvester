/**
 * PostgreSQL 生产存储。DDL 幂等；发布在单事务内完成（先插完整 publication/records，
 * 最后切换 current 指针），事务中断自动回滚，current 保留上一完整发布。
 */
import type { Pool } from 'pg';
import type {
  Store,
  RuleDocument,
  Snapshot,
  RegressionFixture,
  CrawlJob,
  RegressionReport,
  Publication,
  SourceConfig,
  BusinessRecord,
  PageAttempt,
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
      CREATE TABLE IF NOT EXISTS page_attempts (
        attempt_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, doc JSONB NOT NULL,
        started_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_page_attempts_job ON page_attempts (job_id, started_at);
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

  async saveJob(j: CrawlJob): Promise<void> {
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

  /**
   * 尝试诊断 append-only：新尝试插入；只有仍处 in_flight 的同一尝试可落定终态，
   * 已终态的历史行与重启后遗留的 in_flight 旧尝试都不会被改写。
   */
  async savePageAttempt(a: PageAttempt): Promise<void> {
    await this.pool.query(
      `INSERT INTO page_attempts (attempt_id, job_id, doc, started_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (attempt_id) DO UPDATE
       SET doc = EXCLUDED.doc, started_at = EXCLUDED.started_at
       WHERE page_attempts.doc->>'outcome' = 'in_flight'`,
      [a.attemptId, a.jobId, JSON.stringify(a), a.startedAt],
    );
  }

  async listPageAttempts(jobId: string): Promise<PageAttempt[]> {
    const r = await this.pool.query<{ doc: PageAttempt }>(
      `SELECT doc FROM page_attempts WHERE job_id=$1 ORDER BY started_at, attempt_id`,
      [jobId],
    );
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
}

export type { BusinessRecord };
