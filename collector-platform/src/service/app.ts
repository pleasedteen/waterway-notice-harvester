/**
 * 应用装配：存储、规则、服务的统一工厂。
 * 默认嵌入式文件存储（无外部进程）；生产可注入 PostgresStore。
 */
import { EmbeddedStore } from '../storage/embedded-store.js';
import { CrawlService } from './crawl-service.js';
import { RegressionService } from './regression-service.js';
import { PublishService } from './publish-service.js';
import { RULE_V1, RULE_V2, RULE_REGRESSED } from '../core/rule-catalog.js';
import { newId, nowIso } from '../core/ids.js';
import type { Fetcher } from '../fetch/fetcher.js';
import type { RuleDocument, Snapshot, Store } from '../core/types.js';

export interface App {
  store: Store;
  crawl: CrawlService;
  regression: RegressionService;
  publish: PublishService;
}

export async function createApp(opts: { dataDir: string; fetcher: Fetcher; store?: Store }): Promise<App> {
  const store = opts.store ?? new EmbeddedStore(opts.dataDir);
  await store.init();
  // 内置规则版本入库（不可变；重复保存同内容是幂等的）
  for (const r of [RULE_V1, RULE_V2, RULE_REGRESSED]) {
    await store.saveRule(r);
  }
  return {
    store,
    crawl: new CrawlService(store, opts.fetcher),
    regression: new RegressionService(store),
    publish: new PublishService(store),
  };
}

/** 用抓取器离线构造快照对象（不经过作业，便于建夹具/测试） */
export async function snapshotFromFetcher(
  fetcher: Fetcher,
  sourceId: string,
  url: string,
): Promise<Snapshot> {
  const page = await fetcher.fetch(url);
  return {
    snapshotId: newId('snap'),
    sourceId,
    revision: page.revision,
    url: page.url,
    fetchedAt: nowIso(),
    statusCode: page.statusCode,
    contentType: page.contentType,
    html: page.html,
  };
}

export async function snapshotsFor(
  fetcher: Fetcher,
  sourceId: string,
  urls: string[],
): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  for (const url of urls) out.push(await snapshotFromFetcher(fetcher, sourceId, url));
  return out;
}

export function customRule(rule: RuleDocument): RuleDocument {
  return rule;
}
