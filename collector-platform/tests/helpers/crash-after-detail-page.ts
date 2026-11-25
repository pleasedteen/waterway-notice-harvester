/**
 * 真实进程崩溃验证子进程：在第一张详情原页原子保存成功后立即 SIGKILL 自己。
 * 不执行条目提交，也没有机会运行 catch/finally，用于模拟最严格的进程退出窗口。
 */
import { EmbeddedStore } from '../../src/storage/embedded-store.js';
import { CrawlService } from '../../src/service/crawl-service.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../../src/mock/site.js';
import { RULE_V1 } from '../../src/core/rule-catalog.js';
import type { Snapshot } from '../../src/core/types.js';

const dataDir = process.argv[2];
if (!dataDir) throw new Error('missing dataDir argument');

class KillAfterRawPageStore extends EmbeddedStore {
  override async saveSnapshot(snapshot: Snapshot): Promise<void> {
    await super.saveSnapshot(snapshot);
    if (snapshot.url === MOCK_URLS.detailA1) {
      process.kill(process.pid, 'SIGKILL');
    }
  }
}

const store = new KillAfterRawPageStore(dataDir);
await store.init();
await store.saveRule(RULE_V1);
const crawl = new CrawlService(store, new MockFetcher(createMockState()));
const job = await crawl.startOrResume({
  sourceId: 'src-real-page-crash',
  seedUrl: MOCK_URLS.list,
  rule: RULE_V1,
});
await crawl.run(job.jobId).catch(() => {
  // SIGKILL 通常会直接终止；这里仅防止异常路径产生未处理拒绝。
});

setTimeout(() => {
  console.error('crash child failed to terminate');
  process.exit(2);
}, 5000).unref();
