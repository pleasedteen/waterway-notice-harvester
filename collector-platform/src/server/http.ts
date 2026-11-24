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

    if (p === '/api/reports' && method === 'GET') return send(res, 200, await app.store.listRegressionReports());
    if (p.startsWith('/api/reports/') && method === 'GET') {
      const r = await app.store.getRegressionReport(p.split('/').pop()!);
      return send(res, r ? 200 : 404, r ?? { error: '报告不存在' });
    }

    if (p === '/api/regression/run' && method === 'POST') {
      const body = await readBody(req);
      const rule = await app.store.getRule(body.ruleId, body.version);
      if (!rule) return send(res, 404, { error: '规则版本不存在' });
      if (body.fixtureId) {
        return send(res, 200, await app.regression.replay(body.fixtureId, rule));
      }
      return send(res, 200, await app.regression.replayAll(rule, body.sourceId));
    }

    if (p === '/api/jobs' && method === 'GET') return send(res, 200, await app.store.listJobs());
    if (p.match(/^\/api\/jobs\/[^/]+\/attempts$/) && method === 'GET') {
      const jobId = p.split('/')[3]!;
      const exists = await app.store.getJob(jobId);
      if (!exists) return send(res, 404, { error: '作业不存在' });
      return send(res, 200, await app.store.listPageAttempts(jobId));
    }
    if (p.startsWith('/api/jobs/') && method === 'GET') {
      const jobId = p.split('/').pop()!;
      const j = await app.store.getJob(jobId);
      if (!j) return send(res, 404, { error: '作业不存在' });
      // 详情页附带页面尝试诊断：值班员可识别每次尝试的结局与页面地址
      return send(res, 200, { ...j, pageAttempts: await app.store.listPageAttempts(jobId) });
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
    if (p.startsWith('/api/publications/') && method === 'GET') {
      const pub = await app.store.getPublication(p.split('/').pop()!);
      return send(res, pub ? 200 : 404, pub ?? { error: '发布不存在' });
    }
    if (p === '/api/publications/current' && method === 'GET') {
      const sourceId = url.searchParams.get('sourceId') ?? 'mock-source';
      return send(res, 200, await app.publish.current(sourceId));
    }

    if (p === '/api/sources' && method === 'GET') return send(res, 200, await app.store.listSources());

    send(res, 404, { error: '未匹配的路由', path: p });
  }

  return server;
}
