/**
 * 批次离线重放（发布闸门用）：
 * 不访问网络，仅用作业落盘的快照，按候选规则完整重放
 *   1. 列表发现（含列表分页链）——证明条目集完整、没有漏页；
 *   2. 列表预取字段——证明预取结果可复现；
 *   3. 详情续页合并——证明每条记录可由快照离线复现，且续页已采到最后一页。
 * 任何一项与作业检查点不一致都视为"漏页/证据不足"，阻断发布，上一版本继续生效。
 */
import {
  applyPrefetch,
  extractFromSnapshots,
  extractListEntries,
  extractNextPage,
} from '../core/extractor.js';
import { canonicalKey } from '../core/normalize.js';
import { diffRecords } from '../core/regression.js';
import type {
  CrawlJob,
  ExtractedField,
  RuleDocument,
  Snapshot,
  Store,
} from '../core/types.js';

export interface BatchReplayResult {
  ok: boolean;
  /** 逐条问题描述（含 URL 证据），空数组表示重放通过 */
  problems: string[];
  /** 列表重放发现的条目 URL（有序、去重） */
  discoveredEntryUrls: string[];
  /** 成功重放详情的条目数 */
  replayedRecords: number;
}

async function loadSnapshots(store: Store, ids: string[], problems: string[], label: string): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  for (const id of ids) {
    const s = await store.getSnapshot(id);
    if (!s) {
      problems.push(`${label}引用的快照缺失: ${id}（证据不足，禁止发布）`);
      continue;
    }
    out.push(s);
  }
  return out;
}

/** 用候选规则离线重放整个批次，返回全部不一致点 */
export async function replayBatch(job: CrawlJob, rule: RuleDocument, store: Store): Promise<BatchReplayResult> {
  const problems: string[] = [];
  const discovered = new Map<string, Record<string, ExtractedField>>();

  /* ---------- 1. 列表发现 + 预取重放 ---------- */
  if (rule.list) {
    const listSnaps = await loadSnapshots(store, job.listSnapshotIds, problems, '列表发现');
    if (listSnaps.length === 0 && job.listSnapshotIds.length === 0) {
      problems.push('作业没有任何列表页快照，无法重放列表发现（证据不足）');
    }
    let expectNext: string | null = null;
    for (const snap of listSnaps) {
      if (expectNext && snap.url !== expectNext) {
        problems.push(`列表快照链断裂: 上一页指向 ${expectNext}，实际快照为 ${snap.url}`);
      }
      for (const e of extractListEntries(snap.html, rule, snap.url)) {
        if (!discovered.has(e.url)) discovered.set(e.url, e.prefetch);
      }
      expectNext = rule.list.pagination
        ? extractNextPage(snap.html, rule.list.pagination, snap.url)
        : null;
    }
    if (expectNext) {
      problems.push(`列表重放显示仍有下一页未采集: ${expectNext}（漏页风险，批次不完整）`);
    }
    const jobUrls = new Set(job.entries.map((e) => e.entryUrl));
    for (const url of discovered.keys()) {
      if (!jobUrls.has(url)) problems.push(`列表重放发现作业未采集的条目（漏公告）: ${url}`);
    }
    for (const e of job.entries) {
      if (!discovered.has(e.entryUrl)) problems.push(`作业条目不在列表重放结果中: ${e.entryUrl}`);
    }
    // 预取字段逐条比对（canonical 级）
    for (const e of job.entries) {
      const replayed = discovered.get(e.entryUrl);
      if (!replayed) continue;
      const keys = new Set([...Object.keys(e.prefetch), ...Object.keys(replayed)]);
      for (const k of keys) {
        const a = e.prefetch[k]?.value;
        const b = replayed[k]?.value;
        if (!a || !b) {
          if (a !== b) problems.push(`条目 ${e.entryUrl} 预取字段 ${k} 与列表重放不一致（一侧缺失）`);
          continue;
        }
        if (canonicalKey(a) !== canonicalKey(b)) {
          problems.push(`条目 ${e.entryUrl} 预取字段 ${k} 与列表重放不一致: 作业 ${canonicalKey(a)} vs 重放 ${canonicalKey(b)}`);
        }
      }
    }
  }

  /* ---------- 2. 详情续页重放 ---------- */
  let replayedRecords = 0;
  for (const entry of job.entries) {
    if (entry.status !== 'done' || !entry.record) {
      problems.push(`条目 ${entry.entryUrl} 未完成（${entry.status}），批次不完整`);
      continue;
    }
    const snaps = await loadSnapshots(store, entry.snapshotIds, problems, `条目 ${entry.entryUrl}`);
    if (snaps.length === 0) {
      problems.push(`条目 ${entry.entryUrl} 没有可用详情快照，无法重放（证据不足）`);
      continue;
    }
    if (snaps.length !== entry.snapshotIds.length) continue; // 快照缺失已在上面记录，跳过重放避免误报
    // 续页完整性：最后一页不应再指向下一页
    if (rule.pagination) {
      const last = snaps[snaps.length - 1]!;
      const more = extractNextPage(last.html, rule.pagination, last.url);
      if (more) problems.push(`条目 ${entry.entryUrl} 详情续页未采完，仍有下一页: ${more}`);
    }
    const replayed = applyPrefetch(
      extractFromSnapshots(snaps, rule),
      discovered.get(entry.entryUrl) ?? entry.prefetch,
    );
    replayedRecords += 1;
    const changes = diffRecords([entry.record], [replayed]).filter((c) => c.kind !== 'unchanged');
    if (changes.length > 0) {
      const kinds = changes.map((c) => `${c.identity}(${c.kind})`).join(', ');
      problems.push(`条目 ${entry.entryUrl} 详情重放与作业记录不一致: ${kinds}`);
    }
    if (JSON.stringify(entry.record.pagesMerged) !== JSON.stringify(replayed.pagesMerged)) {
      problems.push(
        `条目 ${entry.entryUrl} 合并页码不一致: 作业 [${entry.record.pagesMerged}] vs 重放 [${replayed.pagesMerged}]`,
      );
    }
    if ((entry.record.recordError ?? null) !== (replayed.recordError ?? null)) {
      problems.push(
        `条目 ${entry.entryUrl} 记录级错误不一致: 作业 ${entry.record.recordError ?? '无'} vs 重放 ${replayed.recordError ?? '无'}`,
      );
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    discoveredEntryUrls: [...discovered.keys()],
    replayedRecords,
  };
}
