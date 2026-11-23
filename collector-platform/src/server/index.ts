/**
 * 服务启动入口。默认嵌入式存储 + 内置模拟站点，无需任何外部服务。
 * 环境变量：
 *   PORT         监听端口（默认 8080）
 *   DATA_DIR     数据目录（默认 ./.demo-data/server）
 *   PG_CONNECTION_STRING  设置后使用 PostgreSQL 生产存储
 */
import { createApp } from '../service/app.js';
import { createHttpServer } from './http.js';
import { MockFetcher, createMockState } from '../mock/site.js';
import { EmbeddedStore } from '../storage/embedded-store.js';
import type { Store } from '../core/types.js';

async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const dataDir = process.env.DATA_DIR ?? './.demo-data/server';
  const pgConn = process.env.PG_CONNECTION_STRING;

  const mockState = createMockState();
  let store: Store = new EmbeddedStore(dataDir);
  if (pgConn) {
    const [{ PostgresStore }, { default: pg }] = await Promise.all([
      import('../storage/pg-store.js'),
      import('pg'),
    ]);
    store = new PostgresStore(new pg.Pool({ connectionString: pgConn }));
  }

  const app = await createApp({
    dataDir,
    fetcher: new MockFetcher(mockState),
    // 定时调度每个来源、每轮运行使用独立抓取器，避免一个来源的故障/挂起状态串到其他来源
    fetcherFactory: () => new MockFetcher(createMockState()),
    store,
  });

  const server = createHttpServer(app, { port, mockState });
  server.listen(port, () => {
    console.log(`采集台已启动: http://localhost:${port}`);
    console.log(`存储模式: ${pgConn ? 'PostgreSQL' : '嵌入式文件存储 (' + dataDir + ')'}`);
    console.log('数据来源: 内置模拟站点（不访问真实外站）');
  });

  const shutdown = (): void => {
    console.log('\n收到退出信号，关闭服务（已落检查点的作业可重启续跑）...');
    app.scheduler.stop();
    server.close(() => {
      void app.store.close().then(() => process.exit(0));
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('启动失败:', e);
  process.exit(1);
});
