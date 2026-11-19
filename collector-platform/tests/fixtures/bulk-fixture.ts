/**
 * 离线大夹具：构造一万条记录，每条一个字段变化 => 一万条变化明细。
 *
 * 不依赖模拟站点，纯快照：每个条目是一个极小的详情页，规则只抽两个字段。
 * 用于验证"大量变化时报告分页"的内存与读写上限，而不是解析能力。
 */
import type { BusinessRecord, RegressionFixture, RuleDocument, Snapshot } from '../../src/core/types.js';

export const BULK_RULE_ID = 'rule-bulk-notice';
export const BULK_RULE_VERSION = '1.0.0';

export const BULK_RULE: RuleDocument = {
  ruleId: BULK_RULE_ID,
  version: BULK_RULE_VERSION,
  name: '大夹具回归规则（两字段）',
  createdAt: '2026-11-01T00:00:00.000Z',
  identity: ['noticeNo'],
  fields: [
    { field: 'noticeNo', type: 'string', selector: '#no' },
    { field: 'limit', type: 'number', selector: '#limit', unit: 't' },
  ],
};

function recordHtml(no: string, limit: string): string {
  return `<html><body><article><span id="no">${no}</span><span id="limit">${limit}</span></article></body></html>`;
}

export interface BulkFixtureOptions {
  /** 条目数（= 预期变化条数），默认 10000 */
  size?: number;
  /** 快照修订，默认 'bulk-v1' */
  revision?: string;
  /** 快照 id 前缀，避免与其他夹具冲突 */
  tag?: string;
  sourceId?: string;
}

export interface BulkFixtureData {
  fixture: RegressionFixture;
  /** 每条一个快照；调用方先 saveSnapshot 再 createFixture 更直观，这里直接返回 Snapshot[] */
  snapshots: Snapshot[];
}

/**
 * 生成载体快照与期望记录。
 * 期望里 limit 为 10 吨；实际抽取时全部为 20 吨 => 每条一个 value_changed 明细。
 */
export function buildBulkFixture(opts: BulkFixtureOptions = {}): BulkFixtureData {
  const size = opts.size ?? 10000;
  const revision = opts.revision ?? 'bulk-v1';
  const tag = opts.tag ?? 'bulk';
  const sourceId = opts.sourceId ?? 'bulk-source';
  const snapshots: Snapshot[] = [];
  const expectedRecords: BusinessRecord[] = [];
  const entries: RegressionFixture['entries'] = [];
  for (let i = 0; i < size; i += 1) {
    const no = `B-${String(i).padStart(6, '0')}`;
    const url = `http://bulk.local/notice/${no}`;
    const snapshotId = `${tag}_${i}`;
    snapshots.push({
      snapshotId,
      sourceId,
      revision,
      url,
      fetchedAt: '2026-11-01T00:00:00.000Z',
      statusCode: 200,
      contentType: 'text/html; charset=utf-8',
      // 实际抽取得到 20 t，与期望 10 t 不同 => 一万条字段变化
      html: recordHtml(no, '20 吨'),
    });
    entries.push({ entryUrl: url, snapshotIds: [snapshotId], urls: [url] });
    expectedRecords.push(expectedRecord(no, 10));
  }
  return {
    snapshots,
    fixture: {
      fixtureId: `${tag}-fixture`,
      name: `一万条变化离线夹具（${size} 条）`,
      sourceId,
      listSnapshotIds: [],
      entries,
      expectedRevision: revision,
      expectedRecords,
      note: '离线性回归分页压力夹具',
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  };
}

function expectedRecord(no: string, limitTons: number): BusinessRecord {
  return {
    identity: `noticeNo=${no}`,
    identityParts: { noticeNo: no },
    fields: {
      noticeNo: {
        field: 'noticeNo',
        value: { status: 'ok', value: no, unit: null },
        evidence: [],
      },
      limit: {
        field: 'limit',
        value: { status: 'ok', value: limitTons * 1000, unit: 'kg' },
        evidence: [],
      },
    },
    nested: {},
    pagesMerged: [1],
  };
}

/**
 * 单条记录携带大量字段变化：用于验证"单条记录也不超一页"。
 * 期望记录含 fieldCount 个字段（val0..valN），实际页面只给出不同的值。
 */
export function buildWideRecordFixture(fieldCount: number, tag = 'wide'): BulkFixtureData {
  const no = 'W-000001';
  const url = `http://bulk.local/notice/${no}`;
  const snapshotId = `${tag}_0`;
  const expectedFields: BusinessRecord['fields'] = {
    noticeNo: { field: 'noticeNo', value: { status: 'ok', value: no, unit: null }, evidence: [] },
  };
  const htmlFields = [`<span id="no">${no}</span>`];
  for (let i = 0; i < fieldCount; i += 1) {
    expectedFields[`val${i}`] = {
      field: `val${i}`,
      value: { status: 'ok', value: 'before', unit: null },
      evidence: [],
    };
    htmlFields.push(`<span class="v${i}">after</span>`);
  }
  const snapshot: Snapshot = {
    snapshotId,
    sourceId: 'bulk-source',
    revision: 'wide-v1',
    url,
    fetchedAt: '2026-11-01T00:00:00.000Z',
    statusCode: 200,
    contentType: 'text/html; charset=utf-8',
    html: `<html><body><article>${htmlFields.join('')}</article></body></html>`,
  };
  return {
    snapshots: [snapshot],
    fixture: {
      fixtureId: `${tag}-fixture`,
      name: `单条宽记录夹具（${fieldCount} 个字段变化）`,
      sourceId: 'bulk-source',
      listSnapshotIds: [],
      entries: [{ entryUrl: url, snapshotIds: [snapshotId], urls: [url] }],
      expectedRevision: 'wide-v1',
      expectedRecords: [
        { identity: `noticeNo=${no}`, identityParts: { noticeNo: no }, fields: expectedFields, nested: {}, pagesMerged: [1] },
      ],
      note: '单条记录字段变化超过一页',
      createdAt: '2026-11-01T00:00:00.000Z',
    },
  };
}

/** 宽记录规则：noticeNo + val0..valN */
export function wideRule(fieldCount: number): RuleDocument {
  return {
    ruleId: 'rule-wide-notice',
    version: '1.0.0',
    name: '宽记录规则',
    createdAt: '2026-11-01T00:00:00.000Z',
    identity: ['noticeNo'],
    fields: [
      { field: 'noticeNo', type: 'string', selector: '#no' },
      ...Array.from({ length: fieldCount }, (_, i) => ({
        field: `val${i}`,
        type: 'string' as const,
        selector: `.v${i}`,
      })),
    ],
  };
}
