/**
 * 真实进程级中断恢复验证（由 npm run verify:restart 调用）：
 * 启动服务 -> 跑一个检查点步长 -> 强杀进程 -> 新进程重启 -> 续跑到完成。
 */
import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8137;
const BASE = `http://localhost:${PORT}`;
const dataDir = await mkdtemp(join(tmpdir(), 'collector-restart-'));

function startServer(): ReturnType<typeof spawn> {
  // 直接 spawn node（不经 npx/sh 包装），保证 kill 信号作用于服务进程本身，
  // 否则包装进程被杀、服务子进程残留占用端口，下一轮验证会连到旧进程
  return spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
    stdio: 'ignore',
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
  if (!job?.jobId) throw new Error(`作业启动失败: ${JSON.stringify(job)}`);
  await post(`/api/jobs/${job.jobId}/run`, { maxEntriesPerCall: 1 });
  const midway = await (await fetch(`${BASE}/api/jobs/${job.jobId}`)).json();
  check('强杀前完成 1/5 条目', (midway.entries ?? []).filter((e: any) => e.status === 'done').length === 1);
  srv.kill('SIGKILL');
  await wait(800);

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
  check('5 个条目全部成功', final.entries.length === 5 && final.entries.every((e: any) => e.status === 'done'));
  srv.kill('SIGTERM');
  await wait(300);
} finally {
  await rm(dataDir, { recursive: true, force: true });
}
process.exit(failures === 0 ? 0 : 1);
