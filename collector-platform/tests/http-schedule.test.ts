/**
 * 定时采集 REST 接口的离线集成测试：起真实 HTTP 服务（内存模拟站点 + 临时文件存储），
 * 验证配置接口、到点自动推进、租约查看与人工发布边界。无外部网络/进程依赖。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { createApp } from '../src/service/app.js';
import { createHttpServer } from '../src/server/http.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../src/mock/site.js';
import { VirtualClock } from '../src/core/clock.js';

let dataDir: string;
let base: string;
let server: Server;
let clock: VirtualClock;

const jsonFetch = async (path: string, init?: RequestInit): Promise<{ status: number; body: any }> => {
  const r = await fetch(`${base}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
    body: init?.body ? init.body : undefined,
  });
  return { status: r.status, body: await r.json() };
};
const post = (path: string, body?: unknown) =>
  jsonFetch(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

test('HTTP：配置定时采集 -> 到点自动推进 -> 租约与作业可查 -> 不自动发布', async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'collector-http-'));
  clock = new VirtualClock();
  clock.setNow(Date.now());
  const app = await createApp({
    dataDir,
    fetcher: new MockFetcher(createMockState()),
    fetcherFactory: () => new MockFetcher(createMockState()),
    clock,
    autoStartScheduler: false, // 用手动 tick 接口驱动，确定性验证
  });
  server = createHttpServer(app, { port: 0 });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('未取得监听端口');
  base = `http://127.0.0.1:${addr.port}`;
  after(async () => {
    app.scheduler.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await app.store.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  // 1. 非法间隔被拒
  const bad = await post('/api/schedules', {
    sourceId: 'src-http', ruleId: 'rule-mock-notice', version: '1.0.0',
    intervalMs: 0, takeoverTimeoutMs: 400, seedUrl: MOCK_URLS.list,
  });
  assert.equal(bad.status, 500);
  assert.match(bad.body.error, /intervalMs/);

  // 2. 合法配置入库
  const created = await post('/api/schedules', {
    sourceId: 'src-http', name: 'HTTP 来源', ruleId: 'rule-mock-notice', version: '1.0.0',
    intervalMs: 1000, takeoverTimeoutMs: 400, seedUrl: MOCK_URLS.list,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.ruleVersion, '1.0.0');
  const listed = await jsonFetch('/api/schedules');
  assert.equal(listed.body.length, 1);

  // 3. 未到点 tick 不产生作业
  await post('/api/schedules/src-http/tick');
  assert.equal((await jsonFetch('/api/jobs')).body.filter((j: any) => j.sourceId === 'src-http').length, 0);

  // 4. 到点 tick，后台链自动完成
  await clock.advance(1001);
  await post('/api/schedules/src-http/tick');
  await app.scheduler.waitIdle('src-http');
  const jobs = (await jsonFetch('/api/jobs')).body.filter((j: any) => j.sourceId === 'src-http');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'completed');

  // 5. 租约已释放、可查；自动采集没有产生发布
  const lease = await jsonFetch('/api/leases/src-http');
  assert.equal(lease.body.state, 'released');
  assert.equal((await jsonFetch('/api/publications?sourceId=src-http')).body.length, 0);

  // 6. 禁用后不再被调度
  await post('/api/schedules/src-http/enabled', { enabled: false });
  assert.equal((await jsonFetch('/api/schedules/src-http')).body.enabled, false);

  // 7. 手动作业接口对未知规则版本返回 404
  const notFound = await post('/api/jobs/start', {
    sourceId: 'src-http2', ruleId: 'nope', version: '9.9.9', seedUrl: MOCK_URLS.list,
  });
  assert.equal(notFound.status, 404);
});
