/**
 * 回归比对：记录级新增/删除、字段级变化、类型不兼容、失败统计，
 * 并区分来源内容变化 vs 规则抽取行为变化（双变归因）。
 */
import { canonicalKey } from './normalize.js';
import { isPrimaryFragment } from './report-paging.js';
import type {
  BusinessRecord,
  CanonicalValue,
  Evidence,
  FieldChange,
  RecordChange,
  RecordChangePart,
  RegressionReportSummary,
  Attribution,
  FieldType,
} from './types.js';

const TYPE_OF_VALUE: Record<string, FieldType> = {
  string: 'string',
  number: 'number',
  boolean: 'boolean',
};

function isTypeIncompatible(before: CanonicalValue, after: CanonicalValue): boolean {
  if (before.status !== 'ok' || after.status !== 'ok') return false;
  const tb = TYPE_OF_VALUE[typeof before.value];
  const ta = TYPE_OF_VALUE[typeof after.value];
  return tb !== undefined && ta !== undefined && tb !== ta;
}

function diffField(
  recordIdentity: string,
  field: string,
  b: CanonicalValue | undefined,
  a: CanonicalValue | undefined,
  evidence: Evidence[],
): FieldChange | null {
  const before = b ?? null;
  const after = a ?? null;
  if (!before && after) {
    return { kind: 'added', recordIdentity, field, before: null, after, evidence };
  }
  if (before && !after) {
    return { kind: 'removed', recordIdentity, field, before, after: null, evidence };
  }
  if (!before || !after) return null;
  if (canonicalKey(before) === canonicalKey(after)) return null;

  if (before.status === 'error' && after.status !== 'error') {
    return { kind: 'failure_fixed', recordIdentity, field, before, after, evidence };
  }
  if (before.status !== 'error' && after.status === 'error') {
    return { kind: 'new_failure', recordIdentity, field, before, after, evidence };
  }
  if (isTypeIncompatible(before, after)) {
    return { kind: 'type_incompatible', recordIdentity, field, before, after, evidence };
  }
  if (before.status !== after.status) {
    return { kind: 'status_changed', recordIdentity, field, before, after, evidence };
  }
  if (before.unit !== after.unit) {
    return { kind: 'unit_changed', recordIdentity, field, before, after, evidence };
  }
  return { kind: 'value_changed', recordIdentity, field, before, after, evidence };
}

function collectEvidence(rec: BusinessRecord | undefined, field: string): Evidence[] {
  if (!rec) return [];
  const ev: Evidence[] = [];
  if (rec.fields[field]) ev.push(...rec.fields[field]!.evidence);
  for (const list of Object.values(rec.nested)) {
    for (const item of list.items) {
      if (item.fields[field]) ev.push(...item.fields[field]!.evidence);
    }
  }
  return ev;
}

function allFieldNames(recs: BusinessRecord[]): Set<string> {
  const s = new Set<string>();
  for (const r of recs) {
    Object.keys(r.fields).forEach((f) => s.add(f));
    for (const list of Object.values(r.nested)) {
      for (const item of list.items) Object.keys(item.fields).forEach((f) => s.add(f));
    }
  }
  return s;
}

function* diffNestedSeq(
  identity: string,
  before: BusinessRecord | undefined,
  after: BusinessRecord | undefined,
): Generator<FieldChange> {
  const names = new Set([...Object.keys(before?.nested ?? {}), ...Object.keys(after?.nested ?? {})]);
  for (const name of names) {
    const bItems = before?.nested[name]?.items ?? [];
    const aItems = after?.nested[name]?.items ?? [];
    const bMap = new Map(bItems.map((i) => [`${identity}#${name}[${i.identity ?? fingerprint(i)}]`, i]));
    const aMap = new Map(aItems.map((i) => [`${identity}#${name}[${i.identity ?? fingerprint(i)}]`, i]));
    const keys = new Set([...bMap.keys(), ...aMap.keys()]);
    for (const key of keys) {
      const bi = bMap.get(key);
      const ai = aMap.get(key);
      const subId = key;
      if (!bi && ai) {
        for (const f of Object.keys(ai.fields)) {
          yield {
            kind: 'added',
            recordIdentity: subId,
            field: f,
            before: null,
            after: ai.fields[f]!.value,
            evidence: ai.fields[f]!.evidence,
          };
        }
        continue;
      }
      if (bi && !ai) {
        for (const f of Object.keys(bi.fields)) {
          yield {
            kind: 'removed',
            recordIdentity: subId,
            field: f,
            before: bi.fields[f]!.value,
            after: null,
            evidence: bi.fields[f]!.evidence,
          };
        }
        continue;
      }
      if (!bi || !ai) continue;
      for (const f of new Set([...Object.keys(bi.fields), ...Object.keys(ai.fields)])) {
        // 证据取自嵌套条目本身（带表格行列定位），而非顶层同名字段
        const nestedEv = [...(ai.fields[f]?.evidence ?? []), ...(bi.fields[f]?.evidence ?? [])];
        const c = diffField(subId, f, bi.fields[f]?.value, ai.fields[f]?.value, nestedEv);
        if (c) yield c;
      }
    }
  }
}

function fingerprint(item: { identity: string | null; fields: Record<string, { value: CanonicalValue }> }): string {
  return Object.keys(item.fields)
    .sort()
    .map((k) => `${k}:${canonicalKey(item.fields[k]!.value)}`)
    .join('||');
}

/**
 * 字段级流式记录差异：逐条字段变化产出，附带其所属记录元信息。
 * 这是报告分页写入的底层流；内存占用与单条记录大小无关。
 */
export function* diffRecordPartsSeq(
  before: BusinessRecord[],
  after: BusinessRecord[],
): Generator<RecordChangePart> {
  const beforeMap = new Map(before.map((r) => [r.identity, r]));
  const afterMap = new Map(after.map((r) => [r.identity, r]));
  let recordIndex = 0;

  for (const rec of after) {
    const old = beforeMap.get(rec.identity);
    if (!old) {
      yield* emitRecord(
        { recordIndex: recordIndex++, identity: rec.identity, kind: 'added', pagesMergedBefore: [], pagesMergedAfter: rec.pagesMerged },
        undefined,
        rec,
      );
      continue;
    }
    const meta = {
      recordIndex: recordIndex++,
      identity: rec.identity,
      kind: 'changed' as const,
      pagesMergedBefore: old.pagesMerged,
      pagesMergedAfter: rec.pagesMerged,
    };
    let any = false;
    for (const f of new Set([...Object.keys(old.fields), ...Object.keys(rec.fields)])) {
      const c = diffField(rec.identity, f, old.fields[f]?.value, rec.fields[f]?.value, collectEvidence(rec, f));
      if (c) {
        any = true;
        yield { ...meta, fieldChange: c };
      }
    }
    for (const c of diffNestedSeq(rec.identity, old, rec)) {
      any = true;
      yield { ...meta, fieldChange: c };
    }
    if (!any) yield { ...meta, kind: 'unchanged', fieldChange: null };
  }

  for (const rec of before) {
    if (!afterMap.has(rec.identity)) {
      const meta = {
        recordIndex: recordIndex++,
        identity: rec.identity,
        kind: 'removed' as const,
        pagesMergedBefore: rec.pagesMerged,
        pagesMergedAfter: [],
      };
      let any = false;
      for (const f of Object.keys(rec.fields)) {
        any = true;
        yield {
          ...meta,
          fieldChange: {
            kind: 'removed',
            recordIdentity: rec.identity,
            field: f,
            before: rec.fields[f]!.value,
            after: null,
            evidence: rec.fields[f]!.evidence,
          },
        };
      }
      if (!any) yield { ...meta, fieldChange: null };
    }
  }
}

function* emitRecord(
  meta: Omit<RecordChangePart, 'fieldChange'>,
  before: BusinessRecord | undefined,
  after: BusinessRecord,
): Generator<RecordChangePart> {
  let any = false;
  for (const f of allFieldNames([after])) {
    const c = diffField(after.identity, f, before?.fields[f]?.value, after.fields[f]?.value, collectEvidence(after, f));
    if (c) {
      any = true;
      yield { ...meta, fieldChange: c };
    }
  }
  for (const c of diffNestedSeq(after.identity, before, after)) {
    any = true;
    yield { ...meta, fieldChange: c };
  }
  if (!any) yield { ...meta, fieldChange: null };
}

/**
 * 流式记录差异：逐条产出完整 RecordChange（字段变化数组内联）。
 * 报告生成请优先使用 diffRecordPartsSeq，避免单条超大记录占用内存。
 */
export function* diffRecordsSeq(before: BusinessRecord[], after: BusinessRecord[]): Generator<RecordChange> {
  let current: { meta: Omit<RecordChangePart, 'fieldChange'>; fieldChanges: FieldChange[] } | null = null;
  for (const part of diffRecordPartsSeq(before, after)) {
    const { fieldChange, ...meta } = part;
    if (!current || current.meta.recordIndex !== part.recordIndex) {
      if (current) yield { ...current.meta, fieldChanges: current.fieldChanges };
      current = { meta, fieldChanges: [] };
    }
    if (fieldChange) current.fieldChanges.push(fieldChange);
  }
  if (current) yield { ...current.meta, fieldChanges: current.fieldChanges };
}

/** 完整数组形式的差异（测试/小数据集使用；报告生成请用 diffRecordPartsSeq） */
export function diffRecords(before: BusinessRecord[], after: BusinessRecord[]): RecordChange[] {
  return [...diffRecordsSeq(before, after)];
}

/** 夹具期望比对（顺序无关，按 identity 对齐）；流式产出失配文本 */
export function* compareExpectationsSeq(expected: BusinessRecord[], actual: BusinessRecord[]): Generator<string> {
  const actualMap = new Map(actual.map((r) => [r.identity, r]));
  const expectedMap = new Map(expected.map((r) => [r.identity, r]));

  for (const exp of expected) {
    const act = actualMap.get(exp.identity);
    if (!act) {
      yield `缺少期望记录: ${exp.identity}`;
      continue;
    }
    for (const [f, ef] of Object.entries(exp.fields)) {
      const af = act.fields[f];
      if (!af) {
        yield `${exp.identity}.${f}: 实际缺失该字段`;
      } else if (canonicalKey(ef.value) !== canonicalKey(af.value)) {
        yield `${exp.identity}.${f}: 期望 ${canonicalKey(ef.value)} 实际 ${canonicalKey(af.value)}`;
      }
    }
    for (const [name, el] of Object.entries(exp.nested)) {
      const al = act.nested[name];
      if (!al) {
        yield `${exp.identity}.nested.${name}: 实际缺失`;
        continue;
      }
      const expItems = new Map(el.items.map((i) => [i.identity ?? fingerprint(i), i]));
      const actItems = new Map(al.items.map((i) => [i.identity ?? fingerprint(i), i]));
      if (expItems.size !== actItems.size) {
        yield `${exp.identity}.nested.${name}: 条目数期望 ${expItems.size} 实际 ${actItems.size}`;
      }
      for (const [key, ei] of expItems) {
        const ai = actItems.get(key);
        if (!ai) {
          yield `${exp.identity}.nested.${name}[${key}]: 实际缺失`;
          continue;
        }
        for (const [f, ef2] of Object.entries(ei.fields)) {
          const af2 = ai.fields[f];
          if (!af2 || canonicalKey(ef2.value) !== canonicalKey(af2.value)) {
            yield `${exp.identity}.nested.${name}[${key}].${f}: 期望 ${canonicalKey(ef2.value)} 实际 ${af2 ? canonicalKey(af2.value) : '<缺失>'}`;
          }
        }
      }
    }
  }
  for (const act of actual) {
    if (!expectedMap.has(act.identity)) yield `出现非期望记录: ${act.identity}`;
  }
}

/** 夹具期望比对（数组形式，测试与小数据集使用） */
export function compareExpectations(expected: BusinessRecord[], actual: BusinessRecord[]): string[] {
  return [...compareExpectationsSeq(expected, actual)];
}

export interface AttributionInput {
  /** 旧快照用旧规则的抽取结果（基线） */
  baseline: BusinessRecord[];
  /** 旧快照用新规则的抽取结果（隔离规则行为变化） */
  oldSnapshotNewRule: BusinessRecord[];
  /** 新快照用新规则的抽取结果（当前结果） */
  newSnapshotNewRule: BusinessRecord[];
  /** 夹具期望内本就失败的记录身份（素材型失败，不构成"证据不足"） */
  expectedBrokenIdentities?: Set<string>;
}

/**
 * 双变归因：
 * - baseline -> oldSnapshotNewRule 的差异只能来自规则（快照未变）=> 规则行为变化
 * - oldSnapshotNewRule -> newSnapshotNewRule 的差异只能来自来源（规则未变）=> 来源内容变化
 * - 两侧都有差异 => both；两侧都无差异 => none；
 * - 任一侧抽取失败导致无法隔离 => undeterminable
 *
 * 只做判定，不产出变化明细（明细由报告生成时流式产出、按页写入）。
 */
export function classifyAttribution(input: AttributionInput): { attribution: Attribution; reason: string } {
  let ruleChanged = false;
  for (const rc of diffRecordsSeq(input.baseline, input.oldSnapshotNewRule)) {
    if (rc.kind !== 'unchanged') {
      ruleChanged = true;
      break;
    }
  }
  let sourceChanged = false;
  for (const rc of diffRecordsSeq(input.oldSnapshotNewRule, input.newSnapshotNewRule)) {
    if (rc.kind !== 'unchanged') {
      sourceChanged = true;
      break;
    }
  }

  const hasFailure = (recs: BusinessRecord[]): boolean =>
    recs
      .filter((r) => !input.expectedBrokenIdentities?.has(r.identity))
      .some(
        (r) =>
          r.recordError !== undefined ||
          Object.values(r.fields).some((f) => f.value.status === 'error') ||
          Object.values(r.nested).some((l) =>
            l.items.some((i) => Object.values(i.fields).some((f) => f.value.status === 'error')),
          ),
      );

  if (hasFailure(input.oldSnapshotNewRule) || hasFailure(input.newSnapshotNewRule)) {
    return {
      attribution: 'undeterminable',
      reason: '对照抽取中存在记录级或字段级失败，无法可靠隔离来源变化与规则行为变化',
    };
  }
  if (ruleChanged && sourceChanged) {
    return { attribution: 'both', reason: '旧快照上规则重放有差异，且新快照在同一规则下也有差异' };
  }
  if (ruleChanged) return { attribution: 'rule_behavior_change', reason: '快照内容未变，仅规则重放结果变化' };
  if (sourceChanged) return { attribution: 'source_change', reason: '同一规则下，新旧快照抽取结果不同' };
  return { attribution: 'none', reason: '两侧重放均无差异' };
}

/** 记录级/字段级全量计数（与是否分页无关） */
export interface ChangeCounts {
  recordsAdded: number;
  recordsRemoved: number;
  fieldsChanged: number;
  typeIncompatibilities: number;
  failures: number;
  /** 身份被打坏、且不在期望坏记录内的记录数 */
  unexpectedBrokenRecords: number;
}

/**
 * 统计工具：报告生成走 `diffRecordPartsSeq` 边产出边计数（见 RegressionService），
 * 这里提供等价的小数据集/测试入口，保证计数口径一致。
 */
export function emptyChangeCounts(): ChangeCounts {
  return {
    recordsAdded: 0,
    recordsRemoved: 0,
    fieldsChanged: 0,
    typeIncompatibilities: 0,
    failures: 0,
    unexpectedBrokenRecords: 0,
  };
}

/** 把一条记录变化计入全量计数（只认首个片段，避免片段重复计数） */
export function accumulateCounts(
  counts: ChangeCounts,
  rc: RecordChange,
  expectedBroken?: Set<string>,
): void {
  if (isPrimaryFragment(rc)) {
    if (rc.kind === 'added') counts.recordsAdded += 1;
    if (rc.kind === 'removed') counts.recordsRemoved += 1;
    if (rc.identity.startsWith('__broken_identity__') && !expectedBroken?.has(rc.identity)) {
      counts.unexpectedBrokenRecords += 1;
    }
  }
  for (const fc of rc.fieldChanges) {
    counts.fieldsChanged += 1;
    if (fc.kind === 'type_incompatible') counts.typeIncompatibilities += 1;
    if (fc.kind === 'new_failure') counts.failures += 1;
  }
}

/** 数组形式的计数（测试与小数据集使用） */
export function summarizeChanges(changes: RecordChange[]): ChangeCounts {
  const counts = emptyChangeCounts();
  for (const rc of changes) accumulateCounts(counts, rc);
  return counts;
}

/** 由全量计数与归因得出发布结论（门禁只看摘要，不看明细） */
export function decidePassed(opts: {
  counts: ChangeCounts;
  expectationMismatchCount: number;
  attribution?: Attribution;
}): boolean {
  return (
    opts.expectationMismatchCount === 0 &&
    opts.counts.typeIncompatibilities === 0 &&
    opts.counts.failures + opts.counts.unexpectedBrokenRecords === 0 &&
    opts.attribution !== 'undeterminable'
  );
}

/** 全量摘要的可读计数口径：失败数 = 字段级新失败 + 意外坏身份记录（兼容旧字段） */
export function totalFailures(counts: ChangeCounts): number {
  return counts.failures + counts.unexpectedBrokenRecords;
}

export function buildRegressionReportSummary(opts: {
  reportId: string;
  fixtureId: string;
  ruleId: string;
  ruleVersion: string;
  ranAt?: string;
  counts: ChangeCounts;
  expectationMismatchCount: number;
  streams: RegressionReportSummary['streams'];
  attribution?: Attribution;
  attributionReason?: string;
}): RegressionReportSummary {
  return {
    reportId: opts.reportId,
    fixtureId: opts.fixtureId,
    ruleId: opts.ruleId,
    ruleVersion: opts.ruleVersion,
    ranAt: opts.ranAt ?? new Date().toISOString(),
    passed: decidePassed({
      counts: opts.counts,
      expectationMismatchCount: opts.expectationMismatchCount,
      attribution: opts.attribution,
    }),
    recordsAdded: opts.counts.recordsAdded,
    recordsRemoved: opts.counts.recordsRemoved,
    fieldsChanged: opts.counts.fieldsChanged,
    typeIncompatibilities: opts.counts.typeIncompatibilities,
    failures: totalFailures(opts.counts),
    attribution: opts.attribution,
    attributionReason: opts.attributionReason,
    expectationMatches: opts.expectationMismatchCount === 0,
    expectationMismatchCount: opts.expectationMismatchCount,
    streams: opts.streams,
  };
}

