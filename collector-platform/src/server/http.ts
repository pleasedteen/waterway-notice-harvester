/**
 * 本地 HTTP 服务：REST 接口 + 单页网页界面。
 * 不引入前端框架，原生 HTML/JS，启动即可用。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../service/app.js';
import { HttpFetcher } from '../fetch/fetcher.js';
import { CrawlService } from '../service/crawl-service.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../mock/site.js';
import type { RuleDocument } from '../core/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body, null, 2));
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

export function createHttpServer(app: App, opts: { port: number; mockState?: ReturnType<typeof createMockState> }): Server {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      send(res, 500, { error: (e as Error).message });
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const p = url.pathname;
    const method = req.method ?? 'GET';

    if (p === '/' || p === '/index.html') {
      const html = await readFile(join(HERE, '..', 'web', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (p === '/api/health') return send(res, 200, { ok: true, time: new Date().toISOString() });

    if (p === '/api/rules' && method === 'GET') {
      const ruleId = url.searchParams.get('ruleId') ?? undefined;
      return send(res, 200, await app.store.listRules(ruleId));
    }
    if (p === '/api/rules' && method === 'POST') {
      const body = (await readBody(req)) as RuleDocument;
      if (!body.ruleId || !body.version || !body.identity) return send(res, 400, { error: '规则缺少 ruleId/version/identity' });
      await app.store.saveRule(body);
      return send(res, 201, { saved: `${body.ruleId}@${body.version}`, immutable: true });
    }

    if (p === '/api/snapshots' && method === 'GET') {
      return send(res, 200, await app.store.listSnapshots(url.searchParams.get('sourceId') ?? undefined));
    }
    if (p.startsWith('/api/snapshots/') && method === 'GET') {
      const s = await app.store.getSnapshot(p.split('/').pop()!);
      return send(res, s ? 200 : 404, s ?? { error: '快照不存在' });
    }

    if (p === '/api/fixtures' && method === 'GET') return send(res, 200, await app.store.listFixtures());
    if (p.startsWith('/api/fixtures/') && method === 'GET') {
      const f = await app.store.getFixture(p.split('/').pop()!);
      return send(res, f ? 200 : 404, f ?? { error: '夹具不存在' });
    }

    // 报告汇总：只返回摘要（全量计数 + 页索引），不含任何变化明细
    if (p === '/api/reports' && method === 'GET') return send(res, 200, await app.store.listRegressionReports());
    // 报告摘要 + 首屏（第 0 页）明细
    if (p.match(/^\/api\/reports\/[^/]+\/summary$/) && method === 'GET') {
      const id = p.split('/')[3]!;
      const summary = await app.store.getRegressionReport(id);
      if (!summary) return send(res, 404, { error: '报告不存在' });
      const record = await app.store.getReportChangePage(id, 'record', 0);
      const expectation = await app.store.getReportExpectationPage(id, 0);
      return send(res, 200, {
        ...summary,
        preview: {
          recordChanges: record?.changes ?? [],
          expectationMismatches: expectation?.mismatches ?? [],
        },
      });
    }
    // 按页读取变化明细：单页 ≤ 500 条
    if (p.match(/^\/api\/reports\/[^/]+\/changes\/[^/]+$/) && method === 'GET') {
      const parts = p.split('/');
      const id = parts[3]!;
      const stream = parts[5]!;
      if (stream !== 'record' && stream !== 'source' && stream !== 'rule') {
        return send(res, 400, { error: '变化流必须是 record/source/rule' });
      }
      const page = Number(url.searchParams.get('page') ?? '0');
      try {
        return send(res, 200, await app.regression.changePage(id, stream, page));
      } catch {
        return send(res, 404, { error: '报告或变化流不存在' });
      }
    }
    // 按页读取期望失配
    if (p.match(/^\/api\/reports\/[^/]+\/expectations$/) && method === 'GET') {
      const id = p.split('/')[3]!;
      const page = Number(url.searchParams.get('page') ?? '0');
      try {
        return send(res, 200, await app.regression.expectationPage(id, page));
      } catch {
        return send(res, 404, { error: '报告不存在' });
      }
    }
    // 报告摘要（不含明细）——放在 /summary 与 /changes 之后匹配
    if (p.startsWith('/api/reports/') && method === 'GET') {
      const r = await app.store.getRegressionReport(p.split('/').pop()!);
      return send(res, r ? 200 : 404, r ?? { error: '报告不存在' });
    }

    if (p === '/api/regression/run' && method === 'POST') {
      const body = await readBody(req);
      const rule = await app.store.getRule(body.ruleId, body.version);
      if (!rule) return send(res, 404, { error: '规则版本不存在' });
      // 只返回摘要（全量计数与页索引）；明细通过 /api/reports/:id/changes 翻页读取
      if (body.fixtureId) {
        return send(res, 200, await app.regression.replaySummary(body.fixtureId, rule));
      }
      return send(res, 200, await app.regression.replayAllSummaries(rule, body.sourceId));
    }

    if (p === '/api/jobs' && method === 'GET') return send(res, 200, await app.store.listJobs());
    if (p.startsWith('/api/jobs/') && method === 'GET') {
      const j = await app.store.getJob(p.split('/').pop()!);
      return send(res, j ? 200 : 404, j ?? { error: '作业不存在' });
    }

    if (p === '/api/jobs/start' && method === 'POST') {
      const body = await readBody(req);
      const rule = await app.store.getRule(body.ruleId, body.version);
      if (!rule) return send(res, 404, { error: '规则版本不存在' });
      const fetcher = body.useMock
        ? new MockFetcher(opts.mockState ?? createMockState())
        : new HttpFetcher();
      const crawl = new CrawlService(app.store, fetcher);
      const job = await crawl.startOrResume({
        sourceId: body.sourceId ?? 'mock-source',
        seedUrl: body.seedUrl ?? MOCK_URLS.list,
        rule,
      });
      return send(res, 201, job);
    }
    if (p.match(/^\/api\/jobs\/[^/]+\/run$/) && method === 'POST') {
      const jobId = p.split('/')[3]!;
      const body = await readBody(req).catch(() => ({}));
      // 续跑沿用启动时的抓取器（演示用 mock；生产中 fetcher 注入由进程配置决定）
      const fetcher = new MockFetcher(opts.mockState ?? createMockState());
      const crawl = new CrawlService(app.store, fetcher);
      const job = await crawl.run(jobId, { maxEntriesPerCall: body.maxEntriesPerCall });
      return send(res, 200, job);
    }

    if (p === '/api/publish/evaluate' && method === 'POST') {
      const body = await readBody(req);
      const rule = await app.store.getRule(body.ruleId, body.version);
      if (!rule) return send(res, 404, { error: '规则版本不存在' });
      return send(res, 200, await app.publish.evaluate(body.jobId, rule));
    }
    if (p === '/api/publish' && method === 'POST') {
      const body = await readBody(req);
      const rule = await app.store.getRule(body.ruleId, body.version);
      if (!rule) return send(res, 404, { error: '规则版本不存在' });
      try {
        const pub = await app.publish.publish(body.jobId, rule, body.note);
        return send(res, 201, pub);
      } catch (e) {
        return send(res, 409, { error: (e as Error).message });
      }
    }
    if (p === '/api/publications' && method === 'GET') {
      const sourceId = url.searchParams.get('sourceId') ?? undefined;
      return send(res, 200, await app.store.listPublications(sourceId));
    }
    // current 必须先于前缀匹配，否则会被当作 publicationId="current" 处理
    if (p === '/api/publications/current' && method === 'GET') {
      const sourceId = url.searchParams.get('sourceId') ?? 'mock-source';
      return send(res, 200, await app.publish.current(sourceId));
    }
    if (p.startsWith('/api/publications/') && method === 'GET') {
      const pub = await app.store.getPublication(p.split('/').pop()!);
      return send(res, pub ? 200 : 404, pub ?? { error: '发布不存在' });
    }

    if (p === '/api/sources' && method === 'GET') return send(res, 200, await app.store.listSources());

    send(res, 404, { error: '未匹配的路由', path: p });
  }

  return server;
}
