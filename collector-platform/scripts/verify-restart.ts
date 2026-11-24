/**
 * 真实进程级中断恢复验证（由 npm run verify:restart 调用）：
 * 启动服务 -> 跑一个检查点步长 -> 强杀进程 -> 新进程重启 -> 续跑到完成。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';

const PORT = 8137;
const BASE = `http://localhost:${PORT}`;
const dataDir = await mkdtemp(join(tmpdir(), 'collector-restart-'));

function startServer(): ChildProcess {
  // 独立进程组，便于整组强杀（npx 会派生 sh/node 子进程）
  return spawn('npx', ['tsx', 'src/server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
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
  if (srv.pid) process.kill(-srv.pid, signal);
  await new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.killed) return resolve();
    srv.once('exit', () => resolve());
    setTimeout(resolve, 3000);
  });
  await waitPortClosed();
}
const post = async (path: string, body: unknown) =>
  (await fetch(`${BASE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  console.log(cond ? `  ✅ ${name}${detail ? ` — ${detail}` : ''}` : `  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures += 1;
};

try {
  // 第一次进程
  let srv = startServer();
  await waitReady();
  const job = await post('/api/jobs/start', { ruleId: 'rule-mock-notice', version: '1.0.0', sourceId: 'mock-source', useMock: true });
  await post(`/api/jobs/${job.jobId}/run`, { maxEntriesPerCall: 1 });
  const midway = await (await fetch(`${BASE}/api/jobs/${job.jobId}`)).json();
  check('强杀前完成 1/4 条目', midway.entries.filter((e: any) => e.status === 'done').length === 1);
  await stop(srv, 'SIGKILL');

  // 第二次进程：仅靠磁盘检查点恢复
  srv = startServer();
  await waitReady();
  const resumed = await post('/api/jobs/start', { ruleId: 'rule-mock-notice', version: '1.0.0', sourceId: 'mock-source', useMock: true });
  check('重启后回到同一作业（未新建）', resumed.jobId === job.jobId);
  let status = 'running';
  for (let i = 0; i < 8; i += 1) {
    const r = await post(`/api/jobs/${job.jobId}/run`, {});
    status = r.status;
    if (status !== 'running' && status !== 'failed') break;
  }
  check('重启续跑后整批 completed', status === 'completed', status);
  const final = await (await fetch(`${BASE}/api/jobs/${job.jobId}`)).json();
  check('4 个条目全部成功', final.entries.length === 4 && final.entries.every((e: any) => e.status === 'done'));

  // 页面尝试诊断：强杀前后的每次尝试与页面地址都可识别
  const attempts = await (await fetch(`${BASE}/api/jobs/${job.jobId}/attempts`)).json();
  const outcomes = new Set(attempts.map((a: any) => a.outcome));
  check('尝试结局可识别（fetched/reused）', outcomes.has('fetched') && outcomes.has('reused'));
  check('每条尝试都带页面地址', attempts.every((a: any) => a.url.startsWith('http')));
  check('fetched 尝试均带已落盘快照 id', attempts.filter((a: any) => a.outcome === 'fetched').every((a: any) => !!a.snapshotId));
  check('重启后已采页面复用快照（reused）而非重新请求', attempts.some((a: any) => a.outcome === 'reused'));
  check('作业详情内嵌 pageAttempts', Array.isArray(final.pageAttempts) && final.pageAttempts.length === attempts.length);
  await stop(srv, 'SIGKILL');
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
