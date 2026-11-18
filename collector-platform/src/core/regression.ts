/**
 * 回归比对：记录级新增/删除、字段级变化、类型不兼容、失败统计，
 * 并区分来源内容变化 vs 规则抽取行为变化（双变归因）。
 */
import { canonicalKey } from './normalize.js';
import type {
  BusinessRecord,
  CanonicalValue,
  Evidence,
  FieldChange,
  RecordChange,
  RegressionReport,
  Attribution,
  FieldType,
} from './types.js';

export interface DiffInput {
  before: BusinessRecord[];
  after: BusinessRecord[];
}

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

function diffNested(
  identity: string,
  before: BusinessRecord | undefined,
  after: BusinessRecord | undefined,
  changes: FieldChange[],
): void {
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
          changes.push({
            kind: 'added',
            recordIdentity: subId,
            field: f,
            before: null,
            after: ai.fields[f]!.value,
            evidence: ai.fields[f]!.evidence,
          });
        }
        continue;
      }
      if (bi && !ai) {
        for (const f of Object.keys(bi.fields)) {
          changes.push({
            kind: 'removed',
            recordIdentity: subId,
            field: f,
            before: bi.fields[f]!.value,
            after: null,
            evidence: bi.fields[f]!.evidence,
          });
        }
        continue;
      }
      if (!bi || !ai) continue;
      for (const f of new Set([...Object.keys(bi.fields), ...Object.keys(ai.fields)])) {
        // 证据取自嵌套条目本身（带表格行列定位），而非顶层同名字段
        const nestedEv = [...(ai.fields[f]?.evidence ?? []), ...(bi.fields[f]?.evidence ?? [])];
        const c = diffField(subId, f, bi.fields[f]?.value, ai.fields[f]?.value, nestedEv);
        if (c) changes.push(c);
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

export function diffRecords(before: BusinessRecord[], after: BusinessRecord[]): RecordChange[] {
  const beforeMap = new Map(before.map((r) => [r.identity, r]));
  const afterMap = new Map(after.map((r) => [r.identity, r]));
  const result: RecordChange[] = [];

  for (const rec of after) {
    const old = beforeMap.get(rec.identity);
    if (!old) {
      const fieldChanges: FieldChange[] = [];
      for (const f of allFieldNames([rec])) {
        const c = diffField(rec.identity, f, undefined, rec.fields[f]?.value, collectEvidence(rec, f));
        if (c) fieldChanges.push(c);
      }
      diffNested(rec.identity, undefined, rec, fieldChanges);
      result.push({
        identity: rec.identity,
        kind: 'added',
        fieldChanges,
        pagesMergedBefore: [],
        pagesMergedAfter: rec.pagesMerged,
      });
      continue;
    }
    const fieldChanges: FieldChange[] = [];
    for (const f of new Set([...Object.keys(old.fields), ...Object.keys(rec.fields)])) {
      const c = diffField(rec.identity, f, old.fields[f]?.value, rec.fields[f]?.value, collectEvidence(rec, f));
      if (c) fieldChanges.push(c);
    }
    diffNested(rec.identity, old, rec, fieldChanges);
    result.push({
      identity: rec.identity,
      kind: fieldChanges.length ? 'changed' : 'unchanged',
      fieldChanges,
      pagesMergedBefore: old.pagesMerged,
      pagesMergedAfter: rec.pagesMerged,
    });
  }

  for (const rec of before) {
    if (!afterMap.has(rec.identity)) {
      const fieldChanges: FieldChange[] = [];
      for (const f of Object.keys(rec.fields)) {
        fieldChanges.push({
          kind: 'removed',
          recordIdentity: rec.identity,
          field: f,
          before: rec.fields[f]!.value,
          after: null,
          evidence: rec.fields[f]!.evidence,
        });
      }
      result.push({
        identity: rec.identity,
        kind: 'removed',
        fieldChanges,
        pagesMergedBefore: rec.pagesMerged,
        pagesMergedAfter: [],
      });
    }
  }
  return result;
}

/** 夹具期望比对（顺序无关，按 identity 对齐） */
export function compareExpectations(expected: BusinessRecord[], actual: BusinessRecord[]): string[] {
  const mismatches: string[] = [];
  const actualMap = new Map(actual.map((r) => [r.identity, r]));
  const expectedMap = new Map(expected.map((r) => [r.identity, r]));

  for (const exp of expected) {
    const act = actualMap.get(exp.identity);
    if (!act) {
      mismatches.push(`缺少期望记录: ${exp.identity}`);
      continue;
    }
    for (const [f, ef] of Object.entries(exp.fields)) {
      const af = act.fields[f];
      if (!af) {
        mismatches.push(`${exp.identity}.${f}: 实际缺失该字段`);
      } else if (canonicalKey(ef.value) !== canonicalKey(af.value)) {
        mismatches.push(
          `${exp.identity}.${f}: 期望 ${canonicalKey(ef.value)} 实际 ${canonicalKey(af.value)}`,
        );
      }
    }
    for (const [name, el] of Object.entries(exp.nested)) {
      const al = act.nested[name];
      if (!al) {
        mismatches.push(`${exp.identity}.nested.${name}: 实际缺失`);
        continue;
      }
      const expItems = new Map(el.items.map((i) => [i.identity ?? fingerprint(i), i]));
      const actItems = new Map(al.items.map((i) => [i.identity ?? fingerprint(i), i]));
      if (expItems.size !== actItems.size) {
        mismatches.push(`${exp.identity}.nested.${name}: 条目数期望 ${expItems.size} 实际 ${actItems.size}`);
      }
      for (const [key, ei] of expItems) {
        const ai = actItems.get(key);
        if (!ai) {
          mismatches.push(`${exp.identity}.nested.${name}[${key}]: 实际缺失`);
          continue;
        }
        for (const [f, ef2] of Object.entries(ei.fields)) {
          const af2 = ai.fields[f];
          if (!af2 || canonicalKey(ef2.value) !== canonicalKey(af2.value)) {
            mismatches.push(
              `${exp.identity}.nested.${name}[${key}].${f}: 期望 ${canonicalKey(ef2.value)} 实际 ${af2 ? canonicalKey(af2.value) : '<缺失>'}`,
            );
          }
        }
      }
    }
  }
  for (const act of actual) {
    if (!expectedMap.has(act.identity)) mismatches.push(`出现非期望记录: ${act.identity}`);
  }
  return mismatches;
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
 */
export function attributeChanges(input: AttributionInput): {
  attribution: Attribution;
  reason: string;
  /** 规则行为变化：旧快照上 旧规则 -> 新规则 的差异 */
  ruleChanges: RecordChange[];
  /** 来源内容变化：新规则下 旧快照 -> 新快照 的差异 */
  sourceChanges: RecordChange[];
} {
  const ruleSide = diffRecords(input.baseline, input.oldSnapshotNewRule);
  const sourceSide = diffRecords(input.oldSnapshotNewRule, input.newSnapshotNewRule);
  const ruleChanged = ruleSide.some((r) => r.kind !== 'unchanged');
  const sourceChanged = sourceSide.some((r) => r.kind !== 'unchanged');

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
      ruleChanges: ruleSide,
      sourceChanges: sourceSide,
    };
  }
  if (ruleChanged && sourceChanged) {
    return { attribution: 'both', reason: '旧快照上规则重放有差异，且新快照在同一规则下也有差异', ruleChanges: ruleSide, sourceChanges: sourceSide };
  }
  if (ruleChanged) return { attribution: 'rule_behavior_change', reason: '快照内容未变，仅规则重放结果变化', ruleChanges: ruleSide, sourceChanges: sourceSide };
  if (sourceChanged) return { attribution: 'source_change', reason: '同一规则下，新旧快照抽取结果不同', ruleChanges: ruleSide, sourceChanges: sourceSide };
  return { attribution: 'none', reason: '两侧重放均无差异', ruleChanges: ruleSide, sourceChanges: sourceSide };
}

export function summarizeChanges(changes: RecordChange[]): {
  recordsAdded: number;
  recordsRemoved: number;
  fieldsChanged: number;
  typeIncompatibilities: number;
  failures: number;
} {
  let recordsAdded = 0;
  let recordsRemoved = 0;
  let fieldsChanged = 0;
  let typeIncompatibilities = 0;
  let failures = 0;
  for (const rc of changes) {
    if (rc.kind === 'added') recordsAdded += 1;
    if (rc.kind === 'removed') recordsRemoved += 1;
    for (const fc of rc.fieldChanges) {
      fieldsChanged += 1;
      if (fc.kind === 'type_incompatible') typeIncompatibilities += 1;
      if (fc.kind === 'new_failure') failures += 1;
    }
  }
  return { recordsAdded, recordsRemoved, fieldsChanged, typeIncompatibilities, failures };
}

export function buildRegressionReport(opts: {
  reportId: string;
  fixtureId: string;
  ruleId: string;
  ruleVersion: string;
  recordChanges: RecordChange[];
  expectationMismatches: string[];
  attribution?: Attribution;
  attributionReason?: string;
  sourceChanges?: RecordChange[];
  ruleChanges?: RecordChange[];
  /** 期望内本就失败的记录身份（这些是夹具素材，不算回归失败） */
  expectedBrokenIdentities?: Set<string>;
}): RegressionReport {
  const s = summarizeChanges(opts.recordChanges);
  // 记录级失败：实际结果中身份被打坏、且不属于夹具期望内的坏记录
  const unexpectedBroken = opts.recordChanges
    .map((rc) => rc.identity)
    .filter((id) => id.startsWith('__broken_identity__') && !opts.expectedBrokenIdentities?.has(id));
  const totalFailures = s.failures + unexpectedBroken.length;
  const passed =
    opts.expectationMismatches.length === 0 &&
    s.typeIncompatibilities === 0 &&
    totalFailures === 0 &&
    opts.attribution !== 'undeterminable';
  return {
    reportId: opts.reportId,
    fixtureId: opts.fixtureId,
    ruleId: opts.ruleId,
    ruleVersion: opts.ruleVersion,
    ranAt: new Date().toISOString(),
    passed,
    recordChanges: opts.recordChanges,
    recordsAdded: s.recordsAdded,
    recordsRemoved: s.recordsRemoved,
    fieldsChanged: s.fieldsChanged,
    typeIncompatibilities: s.typeIncompatibilities,
    failures: totalFailures,
    expectationMatches: opts.expectationMismatches.length === 0,
    expectationMismatches: opts.expectationMismatches,
    attribution: opts.attribution,
    attributionReason: opts.attributionReason,
    sourceChanges: opts.sourceChanges,
    ruleChanges: opts.ruleChanges,
  };
}
