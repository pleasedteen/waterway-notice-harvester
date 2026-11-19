/**
 * PostgreSQL 生产存储。DDL 幂等；发布在单事务内完成（先插完整 publication/records，
 * 最后切换 current 指针），事务中断自动回滚，current 保留上一完整发布。
 */
import type { Pool } from 'pg';
import {
  legacyChangePage,
  legacyExpectationPage,
  normalizeStoredSummary,
  normalizePage,
} from '../core/report-paging.js';
import type {
  ChangePage,
  ChangeStream,
  ExpectationPage,
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
  BusinessRecord,
  RecordChange,
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
      CREATE TABLE IF NOT EXISTS regression_report_changes (
        report_id TEXT NOT NULL,
        stream TEXT NOT NULL,
        page INT NOT NULL,
        page_size INT NOT NULL,
        changes JSONB NOT NULL,
        PRIMARY KEY (report_id, stream, page)
      );
      CREATE TABLE IF NOT EXISTS regression_report_expectations (
        report_id TEXT NOT NULL,
        page INT NOT NULL,
        page_size INT NOT NULL,
        mismatches JSONB NOT NULL,
        PRIMARY KEY (report_id, page)
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
   * 分页报告写入器：明细逐页写独立表，摘要 commit 后报告才可见。
   * 中断只会留下没有摘要指向的孤立页，读取方按摘要页数翻页，看不到半份报告。
   */
  createRegressionReportWriter(reportId: string): RegressionReportWriter {
    return {
      writeChangePage: async (stream, page, pageSize, changes) => {
        await this.pool.query(
          `INSERT INTO regression_report_changes (report_id, stream, page, page_size, changes)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (report_id, stream, page) DO UPDATE SET page_size=EXCLUDED.page_size, changes=EXCLUDED.changes`,
          [reportId, stream, page, pageSize, JSON.stringify(changes)],
        );
      },
      writeExpectationPage: async (page, pageSize, mismatches) => {
        await this.pool.query(
          `INSERT INTO regression_report_expectations (report_id, page, page_size, mismatches)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (report_id, page) DO UPDATE SET page_size=EXCLUDED.page_size, mismatches=EXCLUDED.mismatches`,
          [reportId, page, pageSize, JSON.stringify(mismatches)],
        );
      },
      commit: async (summary) => {
        // 清掉超出本次页数的陈旧页（复用报告 id / 重写更小的报告时）
        await this.removeStalePages(reportId, summary);
        await this.pool.query(
          `INSERT INTO regression_reports (report_id, doc) VALUES ($1,$2)
           ON CONFLICT (report_id) DO UPDATE SET doc=EXCLUDED.doc`,
          [reportId, JSON.stringify(summary)],
        );
      },
      abort: async () => {
        await this.pool.query(`DELETE FROM regression_report_changes WHERE report_id=$1`, [reportId]);
        await this.pool.query(`DELETE FROM regression_report_expectations WHERE report_id=$1`, [reportId]);
      },
    };
  }

  /** 删除摘要声明页数之外的残留明细页 */
  private async removeStalePages(reportId: string, summary: RegressionReportSummary): Promise<void> {
    await this.pool.query(
      `DELETE FROM regression_report_changes WHERE report_id=$1 AND page >= $2`,
      [reportId, summary.streams.record.pages],
    );
    const streams: ChangeStream[] = ['source', 'rule'];
    for (const s of streams) {
      const index = summary.streams[s];
      if (index) {
        await this.pool.query(
          `DELETE FROM regression_report_changes WHERE report_id=$1 AND stream=$2 AND page >= $3`,
          [reportId, s, index.pages],
        );
      } else {
        await this.pool.query(`DELETE FROM regression_report_changes WHERE report_id=$1 AND stream=$2`, [reportId, s]);
      }
    }
    await this.pool.query(
      `DELETE FROM regression_report_expectations WHERE report_id=$1 AND page >= $2`,
      [reportId, summary.streams.expectation.pages],
    );
  }

  /** 兼容入口：把完整报告的明细分页写入后提交摘要 */
  async saveRegressionReport(rep: RegressionReport): Promise<void> {
    const writer = this.createRegressionReportWriter(rep.reportId);
    const writeAll = async (stream: ChangeStream, changes: RecordChange[], pageSize: number) => {
      for (let p = 0, start = 0; start < changes.length; p += 1, start += pageSize) {
        await writer.writeChangePage(stream, p, pageSize, changes.slice(start, start + pageSize));
      }
    };
    await writeAll('record', rep.recordChanges, rep.streams.record.pageSize);
    if (rep.sourceChanges) await writeAll('source', rep.sourceChanges, rep.streams.source!.pageSize);
    if (rep.ruleChanges) await writeAll('rule', rep.ruleChanges, rep.streams.rule!.pageSize);
    for (let p = 0, start = 0; start < rep.expectationMismatches.length; p += 1, start += rep.streams.expectation.pageSize) {
      await writer.writeExpectationPage(
        p,
        rep.streams.expectation.pageSize,
        rep.expectationMismatches.slice(start, start + rep.streams.expectation.pageSize),
      );
    }
    const { recordChanges, sourceChanges, ruleChanges, expectationMismatches, ...summary } = rep;
    void recordChanges;
    void sourceChanges;
    void ruleChanges;
    void expectationMismatches;
    await writer.commit(summary);
  }

  /** 只读摘要：SQL 只取 doc，不 join 明细表 */
  async getRegressionReport(id: string): Promise<RegressionReportSummary | null> {
    const r = await this.pool.query<{ doc: Record<string, unknown> }>(
      `SELECT doc FROM regression_reports WHERE report_id=$1`,
      [id],
    );
    return r.rows[0]?.doc ? normalizeStoredSummary(r.rows[0].doc) : null;
  }

  async listRegressionReports(): Promise<RegressionReportSummary[]> {
    const r = await this.pool.query<{ doc: Record<string, unknown> }>(
      `SELECT doc FROM regression_reports ORDER BY doc->>'ranAt' DESC`,
    );
    return r.rows.map((x) => normalizeStoredSummary(x.doc));
  }

  async getReportChangePage(
    reportId: string,
    stream: ChangeStream,
    page: number,
  ): Promise<ChangePage | null> {
    const summary = await this.getRegressionReport(reportId);
    if (!summary) return null;
    if (!summary.streams) {
      // 旧格式报告（无 streams 字段且明细可能内联）：回退到 doc 内切片
      const raw = await this.pool.query<{ doc: Record<string, unknown> }>(
        `SELECT doc FROM regression_reports WHERE report_id=$1`,
        [reportId],
      );
      return legacyChangePage(raw.rows[0]?.doc, reportId, stream, page);
    }
    const index = stream === 'record' ? summary.streams.record : stream === 'source' ? summary.streams.source : summary.streams.rule;
    if (!index) return null;
    const p = normalizePage(page);
    if (p >= index.pages) {
      return {
        reportId,
        stream,
        page: p,
        pageSize: index.pageSize,
        pages: index.pages,
        total: index.total,
        changes: [],
      };
    }
    const r = await this.pool.query<{ changes: ChangePage['changes'] }>(
      `SELECT changes FROM regression_report_changes WHERE report_id=$1 AND stream=$2 AND page=$3`,
      [reportId, stream, p],
    );
    return {
      reportId,
      stream,
      page: p,
      pageSize: index.pageSize,
      pages: index.pages,
      total: index.total,
      changes: r.rows[0]?.changes ?? [],
    };
  }

  async getReportExpectationPage(reportId: string, page: number): Promise<ExpectationPage | null> {
    const summary = await this.getRegressionReport(reportId);
    if (!summary) return null;
    if (!summary.streams) {
      const raw = await this.pool.query<{ doc: Record<string, unknown> }>(
        `SELECT doc FROM regression_reports WHERE report_id=$1`,
        [reportId],
      );
      return legacyExpectationPage(raw.rows[0]?.doc, reportId, page);
    }
    const index = summary.streams.expectation;
    const p = normalizePage(page);
    if (p >= index.pages) {
      return {
        reportId,
        page: p,
        pageSize: index.pageSize,
        pages: index.pages,
        total: index.total,
        mismatches: [],
      };
    }
    const r = await this.pool.query<{ mismatches: string[] }>(
      `SELECT mismatches FROM regression_report_expectations WHERE report_id=$1 AND page=$2`,
      [reportId, p],
    );
    return {
      reportId,
      page: p,
      pageSize: index.pageSize,
      pages: index.pages,
      total: index.total,
      mismatches: r.rows[0]?.mismatches ?? [],
    };
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
