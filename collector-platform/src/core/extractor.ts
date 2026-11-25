/**
 * 声明式抽取引擎。
 * 同一份 RuleDocument 可作用于任意来源页面；不存在为单个夹具编写的解析代码。
 * 支持：字段选择、嵌套列表、跨行跨列表格映射、类型单位归一、业务身份、续页合并。
 */
import { parse, HTMLElement } from 'node-html-parser';
import { sanitizeHtml } from './html-sanitizer.js';
import {
  coerce,
  missingValue,
  errorValue,
  normalizeText,
  canonicalKey,
} from './normalize.js';
import type { FieldType } from './types.js';
import { buildGrid, resolveColumns, type GridCell } from './table-grid.js';
import type {
  RuleDocument,
  FieldRule,
  NestedListRule,
  TableRule,
  ExtractedField,
  Evidence,
  BusinessRecord,
  NestedRecord,
  CanonicalValue,
  Snapshot,
} from './types.js';

export interface PageDocument {
  url: string;
  html: string;
  page: number;
}

export interface ListEntry {
  url: string;
  prefetch: Record<string, ExtractedField>;
}

const EVIDENCE_TEXT_LIMIT = 160;

/** 统一解析入口：先做通用容错修复（未闭合标签/表格单元格），再交给 HTML 解析器 */
export function parseHtml(html: string): HTMLElement {
  return parse(sanitizeHtml(html));
}

function makeEvidence(url: string, selector: string, text: string, page: number, row?: number, col?: number): Evidence {
  return {
    url,
    selector,
    text: normalizeText(text).slice(0, EVIDENCE_TEXT_LIMIT),
    page,
    row: row ?? null,
    col: col ?? null,
  };
}

function extractField(root: HTMLElement, rule: FieldRule, url: string, page: number): ExtractedField {
  let el: HTMLElement | null = null;
  try {
    el = root.querySelector(rule.selector);
  } catch (e) {
    return {
      field: rule.field,
      value: errorValue(`选择器异常: ${(e as Error).message}`),
      evidence: [makeEvidence(url, rule.selector, '', page)],
    };
  }
  if (!el) {
    return { field: rule.field, value: missingValue(), evidence: [] };
  }
  const raw = rule.attr ? (el.getAttribute(rule.attr) ?? '') : el.text;
  const value = coerce(raw, rule.type, {
    noneMarkers: rule.noneMarkers,
    unit: rule.unit,
    precision: rule.precision,
    booleanTrue: rule.booleanTrue,
    booleanFalse: rule.booleanFalse,
  });
  return {
    field: rule.field,
    value,
    evidence: [makeEvidence(url, rule.selector, raw, page)],
  };
}

function extractNestedList(root: HTMLElement, rule: NestedListRule, url: string, page: number): NestedRecord[] {
  const items = root.querySelectorAll(rule.itemSelector);
  return items.map((item) => {
    const fields: Record<string, ExtractedField> = {};
    for (const fr of rule.itemFields) {
      fields[fr.field] = extractField(item, fr, url, page);
    }
    const identity = buildItemIdentity(fields, rule.itemIdentity);
    return { identity, fields };
  });
}

function buildItemIdentity(fields: Record<string, ExtractedField>, identityFields?: string[]): string | null {
  if (!identityFields || identityFields.length === 0) return null;
  const parts: string[] = [];
  for (const f of identityFields) {
    const v = fields[f]?.value;
    if (!v || v.status !== 'ok') return null;
    parts.push(`${f}=${String(v.value)}`);
  }
  return parts.join('|');
}

function extractTable(root: HTMLElement, rule: TableRule, url: string, page: number): { items: NestedRecord[]; evidence: Evidence[] } {
  const table = root.querySelector(rule.selector) as HTMLElement | null;
  const evidence: Evidence[] = [];
  if (!table) {
    return { items: [], evidence: [makeEvidence(url, rule.selector, '', page)] };
  }
  const grid = buildGrid(table as unknown as Parameters<typeof buildGrid>[0], rule.headerRows, rule.repeatHeaderMarkers ?? []);
  const colMap = resolveColumns(grid, rule.columns);
  evidence.push(makeEvidence(url, rule.selector, `表格 ${grid.rows.length} 行, 映射列 ${colMap.size} 个`, page));

  const items: NestedRecord[] = [];
  for (let r = grid.headerRowCount; r < grid.rows.length; r += 1) {
    if (grid.repeatedHeader[r]) continue; // 续表重复表头：保留在网格中供列解析，数据迭代跳过
    const row = grid.rows[r]!;
    // 跳过汇总/备注行（声明式文本匹配，不写夹具专用代码）
    if (rule.skipRowIf?.startsWith('text:')) {
      const marker = rule.skipRowIf.slice(5);
      const rowText = row.filter((c): c is GridCell => c !== null).map((c) => c.text).join(' ');
      if (rowText.includes(marker)) continue;
    }
    const fields: Record<string, ExtractedField> = {};
    for (const [colNum, fieldName] of colMap) {
      const cell = row[colNum];
      if (!cell) continue;
      const fr = rule.fieldRules?.[fieldName];
      const type: FieldType = fr?.type ?? 'string';
      const value = coerce(cell.text, type, {
        noneMarkers: fr?.noneMarkers,
        unit: fr?.unit,
        unitFromFieldText: fr?.unitFromField ? rowTextOf(row, colMap, fr.unitFromField) : null,
        precision: fr?.precision,
        booleanTrue: fr?.booleanTrue,
        booleanFalse: fr?.booleanFalse,
      });
      fields[fieldName] = {
        field: fieldName,
        value,
        evidence: [makeEvidence(url, rule.selector, cell.text, page, r + 1, colNum + 1)],
      };
    }
    if (Object.keys(fields).length === 0) continue;
    items.push({ identity: buildItemIdentity(fields, rule.itemIdentity), fields });
  }
  return { items, evidence };
}

function rowTextOf(row: (GridCell | null)[], colMap: Map<number, string>, fieldName: string): string | null {
  for (const [col, name] of colMap) {
    if (name === fieldName) return normalizeText(row[col]?.text ?? '');
  }
  return null;
}

/** 从列表页抽取条目链接与预取字段 */
export function extractListEntries(html: string, rule: RuleDocument, url: string): ListEntry[] {
  if (!rule.list) return [];
  const doc = parseHtml(html);
  const links = doc.querySelectorAll(rule.list.itemLinkSelector);
  const entries: ListEntry[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const href = link.getAttribute(rule.list.linkAttr ?? 'href') ?? '';
    const resolved = resolveUrl(url, href);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    const prefetch: Record<string, ExtractedField> = {};
    if (rule.list.prefetchFields && rule.list.itemRootSelector) {
      const root = link.closest(rule.list.itemRootSelector) ?? doc;
      for (const fr of rule.list.prefetchFields) {
        prefetch[fr.field] = extractField(root, fr, url, 1);
      }
    } else if (rule.list.prefetchFields) {
      for (const fr of rule.list.prefetchFields) {
        prefetch[fr.field] = extractField(link, fr, url, 1);
      }
    }
    entries.push({ url: resolved, prefetch });
  }
  return entries;
}

export function resolveUrl(base: string, href: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** 抽取下一页链接；返回 null 表示终止 */
export function extractNextPage(html: string, pagination: NonNullable<RuleDocument['pagination']>, currentUrl: string): string | null {
  const doc = parseHtml(html);
  if (pagination.disabledSelector && doc.querySelector(pagination.disabledSelector)) return null;
  const el = doc.querySelector(pagination.nextSelector);
  if (!el) return null;
  const href = el.getAttribute('href') ?? '';
  if (!href || href === '#' || href.startsWith('javascript:')) return null;
  return resolveUrl(currentUrl, href);
}

/** 从单个详情分页抽取一条未合并记录（归并流程的单页步骤，在线/离线共用） */
export function extractDetailPage(page: PageDocument, rule: RuleDocument): BusinessRecord {
  const doc = parseHtml(page.html);
  const fields: Record<string, ExtractedField> = {};
  for (const fr of rule.fields) {
    fields[fr.field] = extractField(doc, fr, page.url, page.page);
  }
  const nested: BusinessRecord['nested'] = {};
  for (const nr of rule.nested ?? []) {
    if (nr.kind === 'list') {
      nested[nr.field] = {
        items: extractNestedList(doc, nr, page.url, page.page),
        evidence: [makeEvidence(page.url, nr.itemSelector, '', page.page)],
      };
    } else {
      const t = extractTable(doc, nr, page.url, page.page);
      nested[nr.field] = { items: t.items, evidence: t.evidence };
    }
  }
  const { identity, parts, error } = composeIdentity(fields, rule.identity);
  const rec: BusinessRecord = {
    identity,
    identityParts: parts,
    fields,
    nested,
    pagesMerged: [page.page],
  };
  if (error) rec.recordError = error;
  return rec;
}

function composeIdentity(
  fields: Record<string, ExtractedField>,
  identityFields: string[],
): { identity: string; parts: Record<string, string>; error: string | null } {
  const parts: Record<string, string> = {};
  const bad: string[] = [];
  for (const f of identityFields) {
    const v = fields[f]?.value;
    if (!v || v.status !== 'ok' || v.value === null) {
      bad.push(f);
      continue;
    }
    parts[f] = String(v.value);
  }
  if (bad.length) {
    return {
      identity: `__broken_identity__:${bad.join(',')}`,
      parts,
      error: `业务身份字段缺失或失败: ${bad.join(', ')}`,
    };
  }
  return { identity: identityFields.map((f) => `${f}=${parts[f]}`).join('|'), parts, error: null };
}

/**
 * 逐页归并状态（monoid 折叠器）。
 * 在线采集：每抓到一页 -> extractDetailPage -> mergeFragmentIntoState -> 提交分片/游标；
 * 离线回放：extractFromSnapshots -> mergeDetailPages 反复调用同一个 mergePageIntoState。
 * 因此两条链路的归并与证据语义完全一致。
 */
export interface DetailMergeState {
  /** 已归并的累计记录；尚无页时为 null */
  record: BusinessRecord | null;
  /** 已归并分页序号（升序、去重） */
  pageNumbers: number[];
  /** 已归并页数 */
  pageCount: number;
}

export function createDetailMergeState(): DetailMergeState {
  return { record: null, pageNumbers: [], pageCount: 0 };
}

/** 将一个已抽取的单页片段折叠进归并状态（幂等性由调用方保证不重复折叠同一页） */
export function mergeFragmentIntoState(state: DetailMergeState, fragment: BusinessRecord): BusinessRecord {
  if (!state.record) {
    state.record = fragment;
  } else {
    mergeInto(state.record, fragment);
  }
  for (const p of fragment.pagesMerged) {
    if (!state.pageNumbers.includes(p)) state.pageNumbers.push(p);
  }
  state.pageNumbers.sort((a, b) => a - b);
  state.pageCount += 1;
  state.record.pagesMerged = [...state.pageNumbers];
  return state.record;
}

/** 抽取单页并折叠进归并状态（在线逐页归并与离线整批归并共用这一步） */
export function mergePageIntoState(
  state: DetailMergeState,
  page: PageDocument,
  rule: RuleDocument,
): BusinessRecord {
  return mergeFragmentIntoState(state, extractDetailPage(page, rule));
}

/**
 * 有状态的逐页归并器（便于调用方以类形式持有检查点折叠状态）。
 * 与函数式 DetailMergeState 完全等价。
 */
export class DetailPageMerger {
  readonly state = createDetailMergeState();

  /** 抽取并归并一页原页面 */
  addPage(page: PageDocument, rule: RuleDocument): BusinessRecord {
    return mergePageIntoState(this.state, page, rule);
  }

  /** 归并一个从检查点分片读回的单页片段 */
  addFragment(fragment: BusinessRecord): BusinessRecord {
    return mergeFragmentIntoState(this.state, fragment);
  }

  get record(): BusinessRecord | null {
    return this.state.record;
  }

  get pageNumbers(): number[] {
    return this.state.pageNumbers;
  }
}

/**
 * 合并同一航段的续页：
 * - 顶层字段：第一页的 ok 值优先，missing 用后续页补齐；
 * - 嵌套列表/表格：按 itemIdentity 合并，无身份项按内容指纹去重，保持页码与行序；
 * - 重复表头在 buildGrid 阶段已剔除；页面排序由 pages 数组顺序决定。
 *
 * 实现就是对共享逐页归并器的一次折叠，保证离线整批回放与在线逐页提交结果一致。
 */
export function mergeDetailPages(pages: PageDocument[], rule: RuleDocument): BusinessRecord {
  const ordered = pages.slice().sort((a, b) => a.page - b.page);
  if (ordered.length === 0) {
    throw new Error('mergeDetailPages: 无可用分页');
  }
  const state = createDetailMergeState();
  for (const p of ordered) mergePageIntoState(state, p, rule);
  // 与历史行为严格一致：pagesMerged 取入参分页序号（升序去重）
  state.record!.pagesMerged = [...new Set(ordered.map((p) => p.page))].sort((a, b) => a - b);
  return state.record!;
}

/** 单数命名别名：逐页归并一步（部分调用方按 mergeDetailPage 命名使用） */
export const mergeDetailPage = mergePageIntoState;

/** 归并检查点状态别名（逐页提交/恢复语义） */
export type DetailMergeCheckpoint = DetailMergeState;
export const createMergeCheckpoint = createDetailMergeState;

/** reduce 命名别名：把有序分页一次性归并为记录 */
export const reduceDetailPages = mergeDetailPages;

function mergeInto(target: BusinessRecord, other: BusinessRecord): void {
  // 顶层字段
  for (const [name, otherField] of Object.entries(other.fields)) {
    const cur = target.fields[name];
    if (!cur) {
      target.fields[name] = otherField;
      continue;
    }
    if (cur.value.status === 'missing' && otherField.value.status !== 'missing') {
      target.fields[name] = otherField;
    } else if (cur.value.status === 'none' && otherField.value.status === 'ok') {
      // 明确无值优先于后补 ok，保留 none（业务语义更明确）
    }
    cur.evidence = mergeEvidence(cur.evidence, otherField.evidence);
  }
  // 嵌套
  for (const [name, otherList] of Object.entries(other.nested)) {
    const curList = target.nested[name];
    if (!curList) {
      target.nested[name] = otherList;
      continue;
    }
    curList.evidence = mergeEvidence(curList.evidence, otherList.evidence);
    const byIdentity = new Map<string, number>();
    curList.items.forEach((item, idx) => {
      if (item.identity) byIdentity.set(item.identity, idx);
    });
    const seenFingerprints = new Set(curList.items.map((i) => fingerprint(i)));
    for (const item of otherList.items) {
      if (item.identity && byIdentity.has(item.identity)) {
        const existing = curList.items[byIdentity.get(item.identity)!]!;
        mergeNestedFields(existing, item);
      } else {
        const fp = fingerprint(item);
        if (seenFingerprints.has(fp)) continue; // 等价行/重复行不产生差异
        seenFingerprints.add(fp);
        curList.items.push(item);
      }
    }
  }
}

function mergeNestedFields(target: NestedRecord, other: NestedRecord): void {
  for (const [name, of2] of Object.entries(other.fields)) {
    const cur = target.fields[name];
    if (!cur) {
      target.fields[name] = of2;
    } else if (cur.value.status === 'missing' && of2.value.status !== 'missing') {
      target.fields[name] = of2;
    } else if (cur) {
      cur.evidence = mergeEvidence(cur.evidence, of2.evidence);
    }
  }
}

function fingerprint(item: NestedRecord): string {
  return Object.keys(item.fields)
    .sort()
    .map((k) => `${k}:${canonicalKey(item.fields[k]!.value)}`)
    .join('||');
}

function mergeEvidence(a: Evidence[], b: Evidence[]): Evidence[] {
  const seen = new Set(a.map((e) => `${e.url}|${e.selector}|${e.row}|${e.col}|${e.text}`));
  const out = [...a];
  for (const e of b) {
    const key = `${e.url}|${e.selector}|${e.row}|${e.col}|${e.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(e);
    }
  }
  return out;
}

/** 离线重放入口：基于快照分页抽取并合并 */
export function extractFromSnapshots(snapshots: Snapshot[], rule: RuleDocument): BusinessRecord {
  const pages: PageDocument[] = snapshots.map((s, i) => ({ url: s.url, html: s.html, page: i + 1 }));
  return mergeDetailPages(pages, rule);
}

/** 顶层字段值的便捷读取 */
export function fieldValue(rec: BusinessRecord, field: string): CanonicalValue | null {
  return rec.fields[field]?.value ?? null;
}
