/**
 * 真实进程级"请求途中强杀"恢复验证（由 npm run verify:kill 调用）：
 *  1. 启动服务，对目标详情页注入 slow 故障（请求挂起）；
 *  2. 触发一次推进，待 in_flight 尝试落盘后，在请求途中 SIGKILL 强杀进程；
 *  3. 不带故障重启，续跑到完成；
 *  4. 断言：旧 in_flight 尝试原样保留、新尝试 fetched 且 id 不同、
 *     只有检查点落盘的页面带 snapshotId，整批 completed。
 * 全程嵌入式文件存储 + 内置模拟站点，无外部依赖。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

const PORT = 8139;
const BASE = `http://localhost:${PORT}`;
const dataDir = await mkdtemp(join(tmpdir(), 'collector-kill-'));

function startServer(extraEnv: NodeJS.ProcessEnv = {}): ChildProcess {
  // 独立进程组，便于用负 PID 整组强杀（npx 会派生 sh/node 子进程，只杀 wrapper 会留孤儿）
  return spawn('npx', ['tsx', 'src/server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...extraEnv },
    stdio: 'ignore',
    detached: true,
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitReady(): Promise<void> {
  for (let i = 0; i < 40; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch { /* 未就绪 */ }
    await wait(150);
  }
  throw new Error('服务未就绪');
}
/** 等到监听端口彻底关闭（TCP 连接被拒），避免下一个进程 EADDRINUSE */
async function waitPortClosed(): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    const closed = await new Promise<boolean>((resolve) => {
      const sock = connect({ port: PORT, host: '127.0.0.1' });
      sock.once('connect', () => { sock.destroy(); resolve(false); });
      sock.once('error', () => resolve(true));
    });
    if (closed) return;
    await wait(150);
  }
  throw new Error('监听端口未按预期关闭');
}
async function stop(srv: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  if (srv.pid) process.kill(-srv.pid, signal); // 杀掉整个进程组（含 npx/sh/node 服务进程）
  await new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.killed) return resolve();
    srv.once('exit', () => resolve());
    setTimeout(resolve, 3000);
  });
  await waitPortClosed();
}
const post = async (path: string, body: unknown) =>
  (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (path: string) => (await fetch(`${BASE}${path}`)).json();

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(cond ? `  ✅ ${name}${detail ? ` — ${detail}` : ''}` : `  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

const HANG_URL_PART = 'G2026-021';

try {
  // 第一次进程：先正常跑完第一个条目，再让第二个条目的请求挂起
  let srv = startServer();
  await waitReady();
  const job = await post('/api/jobs/start', { ruleId: 'rule-mock-notice', version: '1.0.0', sourceId: 'mock-source', useMock: true });
  await post(`/api/jobs/${job.jobId}/run`, { maxEntriesPerCall: 1 });
  await stop(srv, 'SIGKILL');

  // 第二次进程：注入 slow 故障，发起一个永远挂起的详情请求
  srv = startServer({ MOCK_FAULTS: `${HANG_URL_PART}:slow`, MOCK_SLOW_DELAY_MS: '600000' });
  await waitReady();
  const runPromise = post(`/api/jobs/${job.jobId}/run`, { maxEntriesPerCall: 1 });
  runPromise.catch(() => {}); // 强杀会中断该挂起请求，拒绝是预期行为，先挂接住避免未处理拒绝
  let inflight: any = null;
  for (let i = 0; i < 50 && !inflight; i += 1) {
    await wait(150);
    const attempts = await get(`/api/jobs/${job.jobId}/attempts`);
    inflight = attempts.find((a: any) => a.outcome === 'in_flight' && a.url.includes(HANG_URL_PART));
  }
  check('请求途中已登记 in_flight 尝试（结局未知）', !!inflight, inflight ? inflight.url : '未观察到');
  // 在请求仍挂起时强杀进程（SIGKILL，无优雅退出）
  await stop(srv, 'SIGKILL');

  // 第三次进程：清除故障，仅靠磁盘检查点恢复并续跑
  srv = startServer();
  await waitReady();
  const resumed = await post('/api/jobs/start', { ruleId: 'rule-mock-notice', version: '1.0.0', sourceId: 'mock-source', useMock: true });
  check('强杀后重启回到同一作业', resumed.jobId === job.jobId);
  let status = 'running';
  for (let i = 0; i < 8; i += 1) {
    const r = await post(`/api/jobs/${job.jobId}/run`, {});
    status = r.status;
    if (status === 'completed' || status === 'failed' || status === 'edition_changed') break;
  }
  check('续跑后整批 completed', status === 'completed', status);

  const attempts = await get(`/api/jobs/${job.jobId}/attempts`);
  const stale = attempts.filter((a: any) => inflight && a.attemptId === inflight.attemptId);
  check('旧 in_flight 尝试原样保留且不被改写', stale.length === 1 && stale[0].outcome === 'in_flight' && stale[0].finishedAt === null);
  const samePage = attempts.filter((a: any) => a.url.includes(HANG_URL_PART));
  const fresh = samePage.find((a: any) => inflight && a.attemptId !== inflight.attemptId && a.outcome === 'fetched');
  check('同页面存在可区分的新尝试（fetched，attemptId 不同）', !!fresh, samePage.map((a: any) => `${a.outcome}:${a.attemptId.slice(-6)}`).join(' | '));
  check('每个 fetched 尝试都带已落盘快照 id 与页面地址',
    attempts.filter((a: any) => a.outcome === 'fetched').every((a: any) => a.snapshotId && a.url.startsWith('http')));
  check('无快照的尝试仅为 in_flight（只有检查点落盘才算成功）',
    attempts.filter((a: any) => a.snapshotId === null).every((a: any) => a.outcome === 'in_flight'));
  check('存在 reused 尝试：重启复用已落盘快照而非重新请求',
    attempts.some((a: any) => a.outcome === 'reused'));

  const finalJob = await get(`/api/jobs/${job.jobId}`);
  check('作业详情内嵌 pageAttempts 诊断', Array.isArray(finalJob.pageAttempts) && finalJob.pageAttempts.length === attempts.length);
  await stop(srv, 'SIGKILL');
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
