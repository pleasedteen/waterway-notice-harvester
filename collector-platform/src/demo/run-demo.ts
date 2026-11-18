/**
 * 一条命令的端到端演示（同时也是验收脚本）：
 *  1. 嵌套续表 / 跨行跨列表头 / 重复表头 / 汇总行 / 续页合并
 *  2. 脏 HTML、全角数字、等价单位归一；四态区分；0 是有效限值
 *  3. 快照回归夹具 + 候选规则重放（新增/删除/字段变化/类型不兼容/失败/证据）
 *  4. 真实业务变化 vs 规则行为变化的双变归因（含"无法判定"）
 *  5. 采集中断重启续跑
 *  6. 采集中换版阻断
 *  7. 分页失败 -> 批次不完整 -> 修复后续跑成功
 *  7b. 列表第二页失败 -> 重跑沿用快照补齐公告；漏页/页数截断作业禁止发布
 *  8. 原子发布闸门、退化规则被拒、上一完整发布保留、历史可查
 * 全程内存模拟站点，不访问真实外站；嵌入式文件存储，无数据库/缓存进程。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedStore } from '../storage/embedded-store.js';
import { CrawlService } from '../service/crawl-service.js';
import { RegressionService } from '../service/regression-service.js';
import { PublishService } from '../service/publish-service.js';
import { MockFetcher, createMockState, MOCK_URLS } from '../mock/site.js';
import { RULE_V1, RULE_V2, RULE_REGRESSED } from '../core/rule-catalog.js';
import {
  goldenNoticeA, goldenNoticeB, goldenNoticeC, goldenNoticeD, goldenNoticeBad, goldenNoticeA_v2,
} from '../core/golden.js';
import { extractFromSnapshots } from '../core/extractor.js';
import { canonicalKey } from '../core/normalize.js';
import { compareExpectations } from '../core/regression.js';
import type { BusinessRecord, CrawlJob, RuleDocument, Snapshot } from '../core/types.js';

let pass = 0;
let fail = 0;
const failures: string[] = [];

function banner(t: string): void {
  console.log(`\n${'═'.repeat(78)}\n  ${t}\n${'═'.repeat(78)}`);
}
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass += 1;
    console.log(`  ✅ ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    fail += 1;
    failures.push(name);
    console.log(`  ❌ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}
function v(rec: BusinessRecord, field: string): string {
  const cv = rec.fields[field]?.value;
  return cv ? canonicalKey(cv) : '<字段不存在>';
}
function nv(rec: BusinessRecord, list: string, itemId: string, field: string): string {
  const item = rec.nested[list]?.items.find((i) => i.identity?.includes(itemId));
  const cv = item?.fields[field]?.value;
  return cv ? canonicalKey(cv) : '<条目/字段不存在>';
}
/** 夹具期望不带列表页预取字段（重放只基于详情快照） */
function stripPrefetch(rec: BusinessRecord): BusinessRecord {
  const clone: BusinessRecord = JSON.parse(JSON.stringify(rec)) as BusinessRecord;
  delete clone.fields.listNoticeNo;
  delete clone.fields.listTitle;
  return clone;
}

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'collector-demo-'));
  console.log('数据目录（嵌入式文件存储，演示结束自动清理）:', dataDir);

  const store = new EmbeddedStore(dataDir);
  await store.init();
  await store.saveRule(RULE_V1);
  await store.saveRule(RULE_V2);
  await store.saveRule(RULE_REGRESSED);
  const crawl = new CrawlService(store, new MockFetcher(createMockState()));
  const regression = new RegressionService(store);
  const publish = new PublishService(store);

  const state = createMockState();
  const fetcher = new MockFetcher(state);

  /* ---------- 1. 离线快照抽取：续表/跨行跨列/脏HTML/等价单位/四态 ---------- */
  banner('1. 声明式抽取：嵌套续表、跨行跨列表头、脏 HTML、等价单位、四态');
  const snap = async (url: string, edition: 'v1' | 'v2' = 'v1'): Promise<Snapshot> => {
    const st = createMockState();
    st.edition = edition;
    const f = new MockFetcher(st);
    const page = await f.fetch(url);
    return {
      snapshotId: `snap_${edition}_${Buffer.from(url).toString('base64url')}_${Math.random().toString(36).slice(2, 8)}`,
      sourceId: 'mock-source', revision: page.revision, url: page.url,
      fetchedAt: new Date().toISOString(), statusCode: page.statusCode,
      contentType: page.contentType, html: page.html,
    };
  };

  const aPages = [await snap(MOCK_URLS.detailA1), await snap(MOCK_URLS.detailA2)];
  const recA = extractFromSnapshots(aPages, RULE_V1);
  const goldA = goldenNoticeA();
  check('A 公告两航段续页合并为一条记录（同号公告航段在行内区分）', recA.identity === goldA.identity, recA.identity);
  check('续页合并后 pagesMerged=[1,2]', JSON.stringify(recA.pagesMerged) === '[1,2]', JSON.stringify(recA.pagesMerged));
  check('跨行跨列表头正确映射 5 条限值行（重复表头/汇总行已跳过）',
    recA.nested.limitRows?.items.length === 5, `${recA.nested.limitRows?.items.length} 行`);
  check('北岸货车限重 30吨 -> 30000 kg', nv(recA, 'limitRows', '北岸接线段|vehicleType=货车', 'weightLimit') === 'ok:30000@kg');
  check('南岸危险品车限高"—"为明确无值 none', nv(recA, 'limitRows', '危险品车', 'heightLimit') === 'none:—');
  check('小型车"无限制"为 none 而非缺失或失败', nv(recA, 'limitRows', '小型车', 'weightLimit') === 'none:无限制');
  check('嵌套时间窗列表抽取 2 项', recA.nested.timeWindows?.items.length === 2);
  check('页面缺失元素 contactPhone = missing（区别于 none/error）', v(recA, 'contactPhone') === 'missing:');

  const recB = extractFromSnapshots([await snap(MOCK_URLS.detailB)], RULE_V1);
  const goldB = goldenNoticeB();
  check('脏 HTML 容错：公告号正确抽取', v(recB, 'noticeNo') === 'ok:G2026-021');
  check('全角数字 １５吨 -> 15000 kg', nv(recB, 'limitRows', '货车', 'weightLimit') === 'ok:15000@kg');
  check('４５０厘米 -> 4.5 m', nv(recB, 'limitRows', '货车', 'heightLimit') === 'ok:4.5@m');
  check('等价表示归一：15000千克 与 １５吨 canonical 相等',
    nv(recB, 'limitRows', '货车', 'weightLimit') === nv(recB, 'limitRows', '挂车', 'weightLimit'));
  check('日期多写法归一 2026/11/06 -> ISO', v(recB, 'effectiveDate') === 'ok:2026-11-06');
  check('与黄金期望 B 完全一致', compareExpectations([stripPrefetch(goldB)], [recB]).length === 0,
    compareExpectations([stripPrefetch(goldB)], [recB]).join('; '));

  const recC = extractFromSnapshots([await snap(MOCK_URLS.detailC)], RULE_V1);
  check('0 吨是有效限值：status=ok, value=0（不是 none/error）',
    nv(recC, 'limitRows', '非机动车', 'weightLimit') === 'ok:0@kg', nv(recC, 'limitRows', '非机动车', 'weightLimit'));
  check('同一行限高"—"仍为明确无值', nv(recC, 'limitRows', '非机动车', 'heightLimit') === 'none:—');
  check('与黄金期望 C 完全一致', compareExpectations([stripPrefetch(goldenNoticeC())], [recC]).length === 0,
    compareExpectations([stripPrefetch(goldenNoticeC())], [recC]).join('; '));

  const recBad = extractFromSnapshots([await snap(MOCK_URLS.detailBad)], RULE_V1);
  check('身份字段缺失 => 记录级失败标记', recBad.recordError === goldenNoticeBad().recordError, recBad.recordError ?? '');
  check('失败记录身份字段状态为 missing（不是静默丢弃）', v(recBad, 'noticeNo') === 'missing:');

  /* ---------- 2. 建立回归夹具 ---------- */
  banner('2. 建立带期望结果的回归夹具（快照永久保存，重放完全离线）');
  const v1Entries = [
    { entryUrl: MOCK_URLS.detailA1, snapshots: aPages },
    { entryUrl: MOCK_URLS.detailB, snapshots: [await snap(MOCK_URLS.detailB)] },
    { entryUrl: MOCK_URLS.detailC, snapshots: [await snap(MOCK_URLS.detailC)] },
    { entryUrl: MOCK_URLS.detailD, snapshots: [await snap(MOCK_URLS.detailD)] },
    { entryUrl: MOCK_URLS.detailBad, snapshots: [await snap(MOCK_URLS.detailBad)] },
  ];
  const fixture = await regression.createFixture({
    fixtureId: 'fixture-mock-v1',
    name: '模拟站点 v1 全量夹具（嵌套续表/脏HTML/等价单位/失败素材）',
    sourceId: 'mock-source',
    listSnapshots: [await snap(MOCK_URLS.list), await snap(MOCK_URLS.listP2)],
    entries: v1Entries,
    expectedRecords: [goldA, goldB, goldenNoticeC(), goldenNoticeD(), goldenNoticeBad()].map(stripPrefetch),
    note: '黄金期望，四态齐备',
  });
  check('夹具已保存且快照可独立离线重放', (await store.listSnapshots()).length >= 7,
    `${(await store.listSnapshots()).length} 个快照`);

  /* ---------- 3. 规则重放：通过 / 退化 ---------- */
  banner('3. 候选规则重放：正常规则通过，退化规则被捕获');
  const reportV1 = await regression.replay(fixture.fixtureId, RULE_V1);
  check('RULE_V1 重放与期望完全一致（回归通过）', reportV1.passed,
    `新增${reportV1.recordsAdded} 删除${reportV1.recordsRemoved} 字段变化${reportV1.fieldsChanged}`);
  check('期望比对零失配', reportV1.expectationMismatches.length === 0);

  const reportBad = await regression.replay(fixture.fixtureId, RULE_REGRESSED);
  check('退化规则回归不通过', !reportBad.passed);
  check('退化导致新增失败被统计', reportBad.failures > 0, `${reportBad.failures} 个新失败`);
  const anyEvidence = reportBad.recordChanges.some((r) => r.fieldChanges.some((c) => c.evidence.length > 0));
  check('字段变化可定位原始网页证据', anyEvidence);
  const broken = reportBad.recordChanges.find((r) => r.identity.includes('__broken_identity__'));
  check('退化规则把身份字段打坏，记录身份变化可见', broken !== undefined);

  /* ---------- 4. 双变归因 ---------- */
  banner('4. 网站与规则同时变化：来源变化 / 规则行为变化 / 无法判定');
  // 进化规则：新增 h1.title 字段（旧快照上也能抽取 => 规则行为变化可被隔离）
  const RULE_EVOLVED: RuleDocument = {
    ...RULE_V1,
    version: '3.0.0-evolved',
    createdAt: new Date().toISOString(),
    fields: [...RULE_V1.fields, { field: 'docTitle', type: 'string', selector: 'h1.title' }],
  };
  await store.saveRule(RULE_EVOLVED);
  const v2Entries = [
    { entryUrl: MOCK_URLS.detailA1, snapshots: [await snap(MOCK_URLS.detailA1, 'v2'), await snap(MOCK_URLS.detailA2, 'v2')] },
    { entryUrl: MOCK_URLS.detailB, snapshots: [await snap(MOCK_URLS.detailB, 'v2')] },
    { entryUrl: MOCK_URLS.detailC, snapshots: [await snap(MOCK_URLS.detailC, 'v2')] },
    { entryUrl: MOCK_URLS.detailD, snapshots: [await snap(MOCK_URLS.detailD, 'v2')] },
    { entryUrl: MOCK_URLS.detailBad, snapshots: [await snap(MOCK_URLS.detailBad, 'v2')] },
  ];
  const fixtureV2 = await regression.createFixture({
    fixtureId: 'fixture-mock-v2',
    name: '模拟站点 v2 夹具（A 公告限重真实变化 + 基线用于归因）',
    sourceId: 'mock-source',
    entries: v2Entries,
    expectedRecords: [goldenNoticeA_v2(), goldB, goldenNoticeC(), goldenNoticeD(), goldenNoticeBad()].map(stripPrefetch),
    note: '真实业务变化：30t -> 28t',
    baselineEntries: v1Entries,
    baselineRule: RULE_V1,
  });
  const reportEvolved = await regression.replay(fixtureV2.fixtureId, RULE_EVOLVED);
  check('进化规则在 v2 夹具上通过', reportEvolved.passed, reportEvolved.expectationMismatches.join('; '));
  check('归因为 both（来源真实变化 + 规则新增字段行为变化）',
    reportEvolved.attribution === 'both', reportEvolved.attributionReason ?? reportEvolved.attribution);

  const reportV1onV2 = await regression.replay(fixtureV2.fixtureId, RULE_V1);
  check('同一规则跨版本重放归因为 source_change（仅来源内容变化）',
    reportV1onV2.attribution === 'source_change', reportV1onV2.attributionReason ?? '');
  const weightChange = reportV1onV2.sourceChanges
    ?.flatMap((r) => r.fieldChanges)
    .find((c) => c.field === 'weightLimit');
  check('来源变化被精确定位到 weightLimit 30000kg -> 28000kg（带表格证据）',
    weightChange?.before?.value === 30000 &&
      weightChange?.after?.value === 28000 &&
      weightChange.evidence.some((e) => e.row !== null && e.col !== null),
    weightChange ? `${canonicalKey(weightChange.before!)} -> ${canonicalKey(weightChange.after!)}` : '未找到 weightLimit 变化');

  const reportUndet = await regression.replay(fixtureV2.fixtureId, RULE_REGRESSED);
  check('对照抽取存在失败时归因为 undeterminable（证据不足不武断）',
    reportUndet.attribution === 'undeterminable', reportUndet.attributionReason ?? '');

  /* ---------- 5. 中断恢复 ---------- */
  banner('5. 采集作业中断后重启续跑（检查点持久化）');
  const job1 = await crawl.startOrResume({ sourceId: 'mock-source', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  await crawl.run(job1.jobId, { maxEntriesPerCall: 1 });
  const midway = await store.getJob(job1.jobId);
  check('首跑只推进 1 个条目（模拟中断点）', midway?.entries.filter((e) => e.status === 'done').length === 1);
  check('检查点已持久化快照', (midway?.listSnapshotIds.length ?? 0) >= 1 && (midway?.entries[0]?.snapshotIds.length ?? 0) >= 1);
  // 模拟进程重启：全新服务实例、全新抓取器，仅靠存储中的检查点恢复
  const crawlAfterReboot = new CrawlService(new EmbeddedStore(dataDir), new MockFetcher(createMockState()));
  const resumed = await crawlAfterReboot.startOrResume({ sourceId: 'mock-source', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  check('重启后识别到可续跑作业（不新建）', resumed.jobId === job1.jobId);
  const done = await crawlAfterReboot.run(resumed.jobId);
  check('续跑后整批完成', done.status === 'completed', done.status);
  check('5 个条目全部成功（含列表第二页的 G2026-041）', done.entries.every((e) => e.status === 'done') && done.entries.length === 5);
  const recordAJob = done.entries.find((e) => e.entryUrl.includes('G2026-018'))!.record!;
  check('续跑产物与黄金期望 A 一致（含预取字段、四态、0/无值区分）',
    compareExpectations([goldA], [recordAJob]).length === 0,
    compareExpectations([goldA], [recordAJob]).join('; '));
  const recordCJob = done.entries.find((e) => e.entryUrl.includes('G2026-030'))!.record!;
  check('续跑产物与黄金期望 C 一致（0 限值保留）',
    compareExpectations([goldenNoticeC()], [recordCJob]).length === 0,
    compareExpectations([goldenNoticeC()], [recordCJob]).join('; '));

  /* ---------- 6. 采集中换版 ---------- */
  banner('6. 采集中换版：检测到来源修订变化，作业阻断');
  const switchState = createMockState();
  switchState.switchAfter = 3; // 第 3 个请求后网站换版
  const switchStore = new EmbeddedStore(await mkdtemp(join(tmpdir(), 'collector-switch-')));
  await switchStore.init();
  await switchStore.saveRule(RULE_V1);
  const switchCrawl = new CrawlService(switchStore, new MockFetcher(switchState));
  const switchJob = await switchCrawl.startOrResume({ sourceId: 'src-switch', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  const switched = await switchCrawl.run(switchJob.jobId);
  check('换版被检出，作业置 edition_changed', switched.status === 'edition_changed', switched.lastError ?? '');
  const switchPub = new PublishService(switchStore);
  const switchDecision = await switchPub.evaluate(switchJob.jobId, RULE_V1);
  check('换版批次禁止发布', !switchDecision.allowed && switchDecision.reasons.some((r) => r.includes('edition_changed')));

  /* ---------- 7. 分页失败与修复续跑 ---------- */
  banner('7. 分页失败：批次不完整不发布；故障消除后续跑成功');
  const faultState = createMockState();
  faultState.faults.set('G2026-018?page=2', 'error');
  const faultStore = new EmbeddedStore(await mkdtemp(join(tmpdir(), 'collector-fault-')));
  await faultStore.init();
  await faultStore.saveRule(RULE_V1);
  const faultCrawl = new CrawlService(faultStore, new MockFetcher(faultState));
  const faultJob = await faultCrawl.startOrResume({ sourceId: 'src-fault', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  const failedRun = await faultCrawl.run(faultJob.jobId);
  check('分页失败时作业 failed 且已采页面检查点保留',
    failedRun.status === 'failed' && failedRun.entries.some((e) => e.status === 'failed' && e.snapshotIds.length >= 1),
    failedRun.lastError ?? '');
  const faultDecision = await new PublishService(faultStore).evaluate(faultJob.jobId, RULE_V1);
  check('不完整批次禁止发布（未采到的数据不会被解释为删除）', !faultDecision.allowed);
  // 故障消除，用新抓取器续跑
  faultState.faults.clear();
  const recoveredCrawl = new CrawlService(faultStore, new MockFetcher(createMockState()));
  const recovered = await recoveredCrawl.run(faultJob.jobId);
  check('故障消除后续跑成功，批次 completed', recovered.status === 'completed', recovered.status);

  /* ---------- 7b. 列表第二页失败：续跑补齐；漏页/截断禁止发布 ---------- */
  banner('7b. 列表分页失败：重跑沿用快照补齐公告；漏页作业禁止发布');
  const lfStore = new EmbeddedStore(await mkdtemp(join(tmpdir(), 'collector-listfault-')));
  await lfStore.init();
  await lfStore.saveRule(RULE_V1);
  const lfRegression = new RegressionService(lfStore);
  await lfRegression.createFixture({
    fixtureId: 'fixture-list-fault', name: '列表漏页门禁夹具', sourceId: 'src-list-fault',
    entries: [
      { entryUrl: MOCK_URLS.detailA1, snapshots: [await snap(MOCK_URLS.detailA1), await snap(MOCK_URLS.detailA2)] },
      { entryUrl: MOCK_URLS.detailB, snapshots: [await snap(MOCK_URLS.detailB)] },
      { entryUrl: MOCK_URLS.detailC, snapshots: [await snap(MOCK_URLS.detailC)] },
      { entryUrl: MOCK_URLS.detailD, snapshots: [await snap(MOCK_URLS.detailD)] },
      { entryUrl: MOCK_URLS.detailBad, snapshots: [await snap(MOCK_URLS.detailBad)] },
    ],
    expectedRecords: [goldA, goldB, goldenNoticeC(), goldenNoticeD(), goldenNoticeBad()].map(stripPrefetch),
  });
  const lfState = createMockState();
  lfState.faults.set('list?page=2', 'error');
  const lfCrawl = new CrawlService(lfStore, new MockFetcher(lfState));
  const lfJob = await lfCrawl.startOrResume({ sourceId: 'src-list-fault', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  const lfFailed = await lfCrawl.run(lfJob.jobId);
  check('列表第二页失败：作业 failed，第一页条目与列表快照已落检查点',
    lfFailed.status === 'failed' && lfFailed.entries.length === 4 && lfFailed.listSnapshotIds.length === 1,
    lfFailed.lastError ?? '');
  const lfFirstSnap = lfFailed.listSnapshotIds[0];
  lfState.faults.clear();
  const lfDone = await new CrawlService(lfStore, new MockFetcher(lfState)).run(lfJob.jobId);
  check('重跑沿用第一页快照续采，第二页公告 G2026-041 补齐，整批 completed',
    lfDone.status === 'completed' && lfDone.entries.length === 5 &&
    lfDone.entries.some((e) => e.entryUrl.includes('G2026-041')) &&
    lfDone.listSnapshotIds[0] === lfFirstSnap,
    `条目 ${lfDone.entries.length}，列表快照 ${lfDone.listSnapshotIds.length}`);

  // 模拟旧版本漏页作业：缺第二页快照与条目，却自称 completed —— 离线重放必须拦截
  const legacy = JSON.parse(JSON.stringify(lfDone)) as CrawlJob;
  legacy.jobId = 'job-legacy-leak';
  legacy.status = 'completed';
  legacy.listSnapshotIds = legacy.listSnapshotIds.slice(0, 1);
  legacy.entries = legacy.entries.filter((e) => !e.entryUrl.includes('G2026-041'));
  delete (legacy as Partial<CrawlJob>).listDiscovery;
  delete (legacy as Partial<CrawlJob>).listNextUrl;
  await lfStore.saveJob(legacy);
  const lfPublish = new PublishService(lfStore);
  const legacyDecision = await lfPublish.evaluate(legacy.jobId, RULE_V1);
  check('漏页作业被发布闸门拒绝（重放发现仍有下一页未采集）',
    !legacyDecision.allowed && legacyDecision.reasons.some((r) => r.includes('仍有下一页未采集')),
    legacyDecision.reasons.find((r) => r.includes('重放')) ?? '');
  const lfOk = await lfPublish.evaluate(lfJob.jobId, RULE_V1);
  check('补齐后的完整批次评估通过（离线重放 + 夹具回归）', lfOk.allowed, lfOk.reasons.join(';'));

  // 页数上限截断：仍有下一页不允许完成与发布
  const RULE_CAP_LIST: RuleDocument = {
    ...RULE_V1, version: 'cap-list-demo', createdAt: new Date().toISOString(),
    list: { ...RULE_V1.list!, pagination: { ...RULE_V1.list!.pagination!, maxPages: 1 } },
  };
  await lfStore.saveRule(RULE_CAP_LIST);
  const capCrawl = new CrawlService(lfStore, new MockFetcher(createMockState()));
  const capJob = await capCrawl.startOrResume({ sourceId: 'src-list-fault', seedUrl: MOCK_URLS.list, rule: RULE_CAP_LIST });
  const capRun = await capCrawl.run(capJob.jobId);
  check('列表达到页数上限仍有下一页：批次截断（truncated）不置 completed',
    capRun.status === 'failed' && capRun.listDiscovery === 'truncated', capRun.lastError ?? '');
  const capDecision = await lfPublish.evaluate(capJob.jobId, RULE_CAP_LIST);
  check('截断批次禁止发布', !capDecision.allowed);

  /* ---------- 8. 原子发布与闸门 ---------- */
  banner('8. 原子发布：完整批次 + 同规则版本 + 回归通过才生效');
  const decision = await publish.evaluate(job1.jobId, RULE_V1);
  check('完整批次 + RULE_V1 评估通过', decision.allowed, decision.reasons.join('; '));
  const pub1 = await publish.publish(job1.jobId, RULE_V1, '首次完整发布');
  const current1 = await publish.current('mock-source');
  check('发布后 current 指向新版本，规则与整批结果一起生效',
    current1?.publicationId === pub1.publicationId && current1.records.length === 5);

  const regressedDecision = await publish.evaluate(job1.jobId, RULE_REGRESSED);
  check('退化规则发布被闸门拒绝', !regressedDecision.allowed &&
    regressedDecision.reasons.some((r) => r.includes('回归')));
  const currentAfterReject = await publish.current('mock-source');
  check('拒绝后上一完整发布仍然保留可读', currentAfterReject?.publicationId === pub1.publicationId);

  const ruleMismatch = await publish.evaluate(job1.jobId, RULE_V2);
  check('规则版本与作业不一致时拒绝发布', !ruleMismatch.allowed &&
    ruleMismatch.reasons.some((r) => r.includes('规则版本不一致')));

  // 第二次发布（同来源、同修订的新批次），验证历史累积、current 原子切换
  const job2 = await crawl.startOrResume({ sourceId: 'mock-source', seedUrl: MOCK_URLS.list, rule: RULE_V1 });
  const run2 = await crawl.run(job2.jobId);
  check('第二批次完整采集', run2.status === 'completed');
  const pub2 = await publish.publish(job2.jobId, RULE_V1, '第二次发布');
  const history = await publish.history('mock-source');
  const current2 = await publish.current('mock-source');
  check('current 原子切换到新发布，历史发布仍可查询',
    current2?.publicationId === pub2.publicationId && history.length === 2 && history[1]?.publicationId === pub1.publicationId);

  /* ---------- 汇总 ---------- */
  banner('演示汇总');
  console.log(`  通过 ${pass} 项，失败 ${fail} 项`);
  if (failures.length) console.log('  失败项:\n' + failures.map((x) => `   - ${x}`).join('\n'));
  console.log(`\n  数据目录: ${dataDir}`);
  console.log('  网页界面: npm start 后访问 http://localhost:8080');
  await rm(dataDir, { recursive: true, force: true });
  await store.close();
  await switchStore.close();
  await faultStore.close();
  await lfStore.close();
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error('演示异常中断:', e);
  process.exit(1);
});
