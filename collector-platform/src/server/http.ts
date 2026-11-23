/**
 * 本地 HTTP 服务：REST 接口 + 单页网页界面。
 * 不引入前端框架，原生 HTML/JS，启动即可用。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../service/app.js';
import { MOCK_URLS } from '../mock/site.js';
import { LeaseBusyError, LeaseLostError } from '../core/errors.js';
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

export function createHttpServer(app: App, opts: { port: number; mockState?: unknown }): Server {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      if (e instanceof LeaseBusyError) return send(res, 409, { error: e.message, busyOwnerId: e.busyOwnerId });
      if (e instanceof LeaseLostError) return send(res, 410, { error: e.message });
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
    if (p.startsWith('/api/jobs/') && method === 'GET') {
      const j = await app.store.getJob(p.split('/').pop()!);
      return send(res, j ? 200 : 404, j ?? { error: '作业不存在' });
    }

    if (p === '/api/jobs/start' && method === 'POST') {
      const body = await readBody(req);
      const rule = await app.store.getRule(body.ruleId, body.version);
      if (!rule) return send(res, 404, { error: '规则版本不存在' });
      const sourceId = body.sourceId ?? 'mock-source';
      const seedUrl = body.seedUrl ?? MOCK_URLS.list;
      // 人工启动同样经过来源租约：同来源同轮只允许一个实例推进
      const step = await app.scheduler.manualStart({ sourceId, seedUrl, rule });
      return send(res, 201, step);
    }
    if (p.match(/^\/api\/jobs\/[^/]+\/run$/) && method === 'POST') {
      const jobId = p.split('/')[3]!;
      const body = await readBody(req).catch(() => ({}));
      // 手动续跑遵守同源并发限制：租约被其他实例持有且未到接管时限 => 409
      const step = await app.scheduler.manualRunStep(jobId, body.maxEntriesPerCall);
      return send(res, 200, step);
    }

    /* ---------------- 按来源定时采集 ---------------- */
    if (p === '/api/schedules' && method === 'GET') {
      return send(res, 200, await app.store.listSchedules());
    }
    if (p.match(/^\/api\/schedules\/[^/]+$/) && method === 'GET') {
      const sourceId = decodeURIComponent(p.split('/').pop()!);
      const s = await app.store.getSchedule(sourceId);
      return send(res, s ? 200 : 404, s ?? { error: '定时配置不存在' });
    }
    if (p === '/api/schedules' && method === 'POST') {
      const body = await readBody(req);
      const schedule = await app.scheduler.upsertSchedule({
        sourceId: body.sourceId,
        name: body.name ?? body.sourceId,
        seedUrl: body.seedUrl ?? MOCK_URLS.list,
        ruleId: body.ruleId,
        ruleVersion: body.version ?? body.ruleVersion,
        intervalMs: Number(body.intervalMs),
        takeoverTimeoutMs: Number(body.takeoverTimeoutMs),
        maxEntriesPerCall: body.maxEntriesPerCall,
        enabled: body.enabled,
      });
      return send(res, 201, schedule);
    }
    if (p.match(/^\/api\/schedules\/[^/]+$/) && method === 'PUT') {
      const sourceId = decodeURIComponent(p.split('/').pop()!);
      const old = await app.store.getSchedule(sourceId);
      if (!old) return send(res, 404, { error: '定时配置不存在' });
      const body = await readBody(req);
      const schedule = await app.scheduler.upsertSchedule({
        sourceId,
        name: body.name ?? old.name,
        seedUrl: body.seedUrl ?? old.seedUrl,
        ruleId: body.ruleId ?? old.ruleId,
        ruleVersion: body.version ?? body.ruleVersion ?? old.ruleVersion,
        intervalMs: body.intervalMs !== undefined ? Number(body.intervalMs) : old.intervalMs,
        takeoverTimeoutMs:
          body.takeoverTimeoutMs !== undefined ? Number(body.takeoverTimeoutMs) : old.takeoverTimeoutMs,
        maxEntriesPerCall: body.maxEntriesPerCall ?? old.maxEntriesPerCall,
        enabled: body.enabled ?? old.enabled,
      });
      return send(res, 200, schedule);
    }
    if (p.match(/^\/api\/schedules\/[^/]+\/enabled$/) && method === 'POST') {
      const sourceId = decodeURIComponent(p.split('/')[3]!);
      const body = await readBody(req);
      return send(res, 200, await app.scheduler.setEnabled(sourceId, Boolean(body.enabled)));
    }
    if (p.match(/^\/api\/schedules\/[^/]+\/tick$/) && method === 'POST') {
      // 手动触发一次调度评估（测试/运维用）：受间隔门控与租约限制
      const sourceId = decodeURIComponent(p.split('/')[3]!);
      const s = await app.store.getSchedule(sourceId);
      if (!s) return send(res, 404, { error: '定时配置不存在' });
      await app.scheduler.tick();
      return send(res, 200, { triggered: true, schedule: await app.store.getSchedule(sourceId) });
    }
    if (p.match(/^\/api\/leases\/[^/]+$/) && method === 'GET') {
      const sourceId = decodeURIComponent(p.split('/').pop()!);
      const lease = await app.store.getLease(sourceId);
      return send(res, lease ? 200 : 404, lease ?? { error: '租约不存在' });
    }
    if (p === '/api/leases' && method === 'GET') {
      const sourceIds = (await app.store.listSchedules()).map((s) => s.sourceId);
      const leases = (
        await Promise.all(sourceIds.map(async (id) => [id, await app.store.getLease(id)] as const))
      ).filter(([, l]) => l !== null).map(([, l]) => l);
      return send(res, 200, leases);
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
