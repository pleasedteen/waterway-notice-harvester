/**
 * 抽取引擎测试：跨行跨列、续表合并、嵌套列表、四态、业务身份、声明式规则通用性。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockFetcher, createMockState, MOCK_URLS } from '../src/mock/site.js';
import { RULE_V1 } from '../src/core/rule-catalog.js';
import { extractFromSnapshots, extractListEntries, extractNextPage } from '../src/core/extractor.js';
import { compareExpectations } from '../src/core/regression.js';
import {
  goldenNoticeA, goldenNoticeB, goldenNoticeC, goldenNoticeBad,
} from '../src/core/golden.js';
import type { BusinessRecord, Snapshot } from '../src/core/types.js';

async function snap(url: string, edition: 'v1' | 'v2' = 'v1'): Promise<Snapshot> {
  const st = createMockState();
  st.edition = edition;
  const p = await new MockFetcher(st).fetch(url);
  return {
    snapshotId: `t_${edition}_${Buffer.from(url).toString('base64url')}`,
    sourceId: 's', revision: p.revision, url: p.url, fetchedAt: new Date().toISOString(),
    statusCode: p.statusCode, contentType: p.contentType, html: p.html,
  };
}
const strip = (r: BusinessRecord): BusinessRecord => {
  const c: BusinessRecord = JSON.parse(JSON.stringify(r)) as BusinessRecord;
  delete c.fields.listNoticeNo;
  delete c.fields.listTitle;
  return c;
};

test('A 公告：续页合并、跨行跨列表头、重复表头与汇总行跳过', async () => {
  const rec = extractFromSnapshots([await snap(MOCK_URLS.detailA1), await snap(MOCK_URLS.detailA2)], RULE_V1);
  assert.deepEqual(rec.pagesMerged, [1, 2]);
  assert.equal(rec.nested.limitRows?.items.length, 5);
  assert.equal(compareExpectations([strip(goldenNoticeA())], [rec]).length, 0);
  // 证据带表格行列定位
  const truck = rec.nested.limitRows!.items[0]!;
  assert.ok(truck.fields.weightLimit!.evidence[0]!.row);
  assert.ok(truck.fields.weightLimit!.evidence[0]!.col);
});

test('B 公告：脏 HTML/全角数字/等价单位归一', async () => {
  const rec = extractFromSnapshots([await snap(MOCK_URLS.detailB)], RULE_V1);
  assert.equal(compareExpectations([strip(goldenNoticeB())], [rec]).length, 0);
});

test('C 公告：0 是有效限值，— 是明确无值，缺失元素是 missing', async () => {
  const rec = extractFromSnapshots([await snap(MOCK_URLS.detailC)], RULE_V1);
  assert.equal(compareExpectations([strip(goldenNoticeC())], [rec]).length, 0);
  assert.equal(rec.fields.contactPhone!.value.status, 'missing');
});

test('异常公告：身份字段缺失产生记录级失败而非静默丢弃', async () => {
  const rec = extractFromSnapshots([await snap(MOCK_URLS.detailBad)], RULE_V1);
  assert.equal(rec.recordError, goldenNoticeBad().recordError);
});

test('列表页：条目链接发现、列表分页、预取字段', async () => {
  const st = createMockState();
  const page = await new MockFetcher(st).fetch(MOCK_URLS.list);
  const entries = extractListEntries(page.html, RULE_V1, MOCK_URLS.list);
  assert.equal(entries.length, 4);
  assert.equal(entries[0]!.prefetch.listNoticeNo!.value.status, 'ok');
  const next = extractNextPage(page.html, RULE_V1.list!.pagination!, MOCK_URLS.list);
  assert.equal(next, MOCK_URLS.listP2);
  const page2 = await new MockFetcher(st).fetch(MOCK_URLS.listP2);
  assert.equal(extractNextPage(page2.html, RULE_V1.list!.pagination!, MOCK_URLS.listP2), null);
});

test('v2 真实业务变化：仅 A 公告货车限重 30000 -> 28000 kg', async () => {
  const v1 = extractFromSnapshots([await snap(MOCK_URLS.detailA1, 'v1'), await snap(MOCK_URLS.detailA2, 'v1')], RULE_V1);
  const v2 = extractFromSnapshots([await snap(MOCK_URLS.detailA1, 'v2'), await snap(MOCK_URLS.detailA2, 'v2')], RULE_V1);
  const w1 = v1.nested.limitRows!.items.find((i) => i.identity?.includes('北岸') && i.identity?.includes('货车'))!;
  const w2 = v2.nested.limitRows!.items.find((i) => i.identity?.includes('北岸') && i.identity?.includes('货车'))!;
  assert.equal(w1.fields.weightLimit!.value.value, 30000);
  assert.equal(w2.fields.weightLimit!.value.value, 28000);
  // 其他行不受影响
  assert.equal(v1.nested.limitRows!.items.length, v2.nested.limitRows!.items.length);
});
