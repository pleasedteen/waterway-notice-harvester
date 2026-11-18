/**
 * 黄金期望记录：手工构造的 canonical 期望值，作为回归夹具的"期望结果"。
 * 覆盖：四态（ok/missing/none/error）、0 是有效限值、等价单位归一、续页合并、身份失败。
 */
import type { BusinessRecord, CanonicalValue, Evidence, ExtractedField } from '../core/types.js';

const ev = (selector: string, text: string, row?: number, col?: number, page = 1): Evidence[] => [
  { url: 'fixture', selector, text, page, row: row ?? null, col: col ?? null },
];

const ok = (value: string | number | boolean, unit: string | null = null): CanonicalValue => ({
  status: 'ok',
  value,
  unit,
});
const none = (marker: string): CanonicalValue => ({ status: 'none', value: null, unit: null, noneMarker: marker });
const missing = (): CanonicalValue => ({ status: 'missing', value: null, unit: null });
const err = (error: string): CanonicalValue => ({ status: 'error', value: null, unit: null, error });

const f = (field: string, value: CanonicalValue, evidence: Evidence[] = []): ExtractedField => ({
  field,
  value,
  evidence,
});

export interface GoldenNestedItem {
  identity: string | null;
  fields: Record<string, CanonicalValue>;
}

function buildRecord(opts: {
  identity: string;
  identityParts: Record<string, string>;
  top: Record<string, CanonicalValue>;
  tables?: Record<string, GoldenNestedItem[]>;
  lists?: Record<string, GoldenNestedItem[]>;
  pagesMerged?: number[];
  recordError?: string;
}): BusinessRecord {
  const fields: Record<string, ExtractedField> = {};
  for (const [k, v] of Object.entries(opts.top)) fields[k] = f(k, v);
  const nested: BusinessRecord['nested'] = {};
  for (const [name, items] of Object.entries(opts.tables ?? {})) {
    nested[name] = {
      items: items.map((it) => ({
        identity: it.identity,
        fields: Object.fromEntries(Object.entries(it.fields).map(([k, v]) => [k, f(k, v)])),
      })),
      evidence: [],
    };
  }
  for (const [name, items] of Object.entries(opts.lists ?? {})) {
    nested[name] = {
      items: items.map((it) => ({
        identity: it.identity,
        fields: Object.fromEntries(Object.entries(it.fields).map(([k, v]) => [k, f(k, v)])),
      })),
      evidence: [],
    };
  }
  const rec: BusinessRecord = {
    identity: opts.identity,
    identityParts: opts.identityParts,
    fields,
    nested,
    pagesMerged: opts.pagesMerged ?? [1],
  };
  if (opts.recordError) rec.recordError = opts.recordError;
  return rec;
}

/** G2026-018：同号公告两个航段，5 条表格行（含续页 2 行），时间窗嵌套列表 */
export function goldenNoticeA(): BusinessRecord {
  return buildRecord({
    identity: 'noticeNo=G2026-018|segmentName=北岸接线段',
    identityParts: { noticeNo: 'G2026-018', segmentName: '北岸接线段' },
    pagesMerged: [1, 2],
    top: {
      noticeNo: ok('G2026-018'),
      publishDept: ok('市公路局'),
      effectiveDate: ok('2026-11-03'),
      segmentName: ok('北岸接线段'),
      contactPhone: missing(),
      listNoticeNo: ok('G2026-018'),
      listTitle: ok('锦江大桥限行公告（含续表）'),
    },
    tables: {
      limitRows: [
        {
          identity: 'segment=北岸接线段|vehicleType=货车',
          fields: {
            segment: ok('北岸接线段'),
            vehicleType: ok('货车'),
            weightLimit: ok(30000, 'kg'),
            heightLimit: ok(4.5, 'm'),
            restricted: ok(true),
            remark: ok('早晚高峰'),
          },
        },
        {
          identity: 'segment=北岸接线段|vehicleType=挂车',
          fields: {
            segment: ok('北岸接线段'),
            vehicleType: ok('挂车'),
            weightLimit: ok(20000, 'kg'),
            heightLimit: ok(4, 'm'),
            restricted: ok(true),
            remark: none('—'),
          },
        },
        {
          identity: 'segment=北岸接线段|vehicleType=小型车',
          fields: {
            segment: ok('北岸接线段'),
            vehicleType: ok('小型车'),
            weightLimit: none('无限制'),
            heightLimit: none('无限制'),
            restricted: ok(false),
            remark: none(''),
          },
        },
        {
          identity: 'segment=南岸引桥段|vehicleType=货车',
          fields: {
            segment: ok('南岸引桥段'),
            vehicleType: ok('货车'),
            weightLimit: ok(25000, 'kg'),
            heightLimit: ok(4.2, 'm'),
            restricted: ok(true),
            remark: ok('全天候'),
          },
        },
        {
          identity: 'segment=南岸引桥段|vehicleType=危险品车',
          fields: {
            segment: ok('南岸引桥段'),
            vehicleType: ok('危险品车'),
            weightLimit: ok(10000, 'kg'),
            heightLimit: none('—'),
            restricted: ok(true),
            remark: ok('持证通行'),
          },
        },
      ],
    },
    lists: {
      timeWindows: [
        { identity: 'windowRange=07:00-09:00', fields: { windowRange: ok('07:00-09:00'), windowNote: ok('早高峰') } },
        { identity: 'windowRange=17:00-19:00', fields: { windowRange: ok('17:00-19:00'), windowNote: ok('晚高峰') } },
      ],
    },
  });
}

/** G2026-021：脏 HTML + 全角数字；等价单位归一后两行限值完全相等 */
export function goldenNoticeB(): BusinessRecord {
  return buildRecord({
    identity: 'noticeNo=G2026-021|segmentName=隧道主段',
    identityParts: { noticeNo: 'G2026-021', segmentName: '隧道主段' },
    top: {
      noticeNo: ok('G2026-021'),
      publishDept: ok('县交通局'),
      effectiveDate: ok('2026-11-06'),
      segmentName: ok('隧道主段'),
      contactPhone: missing(),
      listNoticeNo: ok('G2026-021'),
      listTitle: ok('云岭隧道限行公告（脏HTML/全角单位）'),
    },
    tables: {
      limitRows: [
        {
          identity: 'segment=隧道主段|vehicleType=货车',
          fields: {
            segment: ok('隧道主段'),
            vehicleType: ok('货车'),
            weightLimit: ok(15000, 'kg'), // １５吨 -> 15000 kg
            heightLimit: ok(4.5, 'm'), // ４５０厘米 -> 4.5 m
            restricted: ok(true),
            remark: ok('全角数字等价写法'),
          },
        },
        {
          identity: 'segment=隧道主段|vehicleType=挂车',
          fields: {
            segment: ok('隧道主段'),
            vehicleType: ok('挂车'),
            weightLimit: ok(15000, 'kg'), // 15000 千克，与上一行 canonical 相等
            heightLimit: ok(4.5, 'm'), // 4.5 m
            restricted: ok(true),
            remark: ok('与上一行等价单位'),
          },
        },
        {
          identity: 'segment=隧道主段|vehicleType=小型车',
          fields: {
            segment: ok('隧道主段'),
            vehicleType: ok('小型车'),
            weightLimit: none('无限制'),
            heightLimit: none('无限制'),
            restricted: ok(false),
            remark: none(''),
          },
        },
      ],
    },
    lists: {
      timeWindows: [
        { identity: 'windowRange=全天', fields: { windowRange: ok('全天'), windowNote: ok('隧道限速 60km/h') } },
      ],
    },
  });
}

/** G2026-030：0 是有效限值（ok, 0 kg）；限高"—"是明确无值；contactPhone 缺失 */
export function goldenNoticeC(): BusinessRecord {
  return buildRecord({
    identity: 'noticeNo=G2026-030|segmentName=立交匝道段',
    identityParts: { noticeNo: 'G2026-030', segmentName: '立交匝道段' },
    top: {
      noticeNo: ok('G2026-030'),
      publishDept: ok('港务集团'),
      effectiveDate: ok('2026-11-11'),
      segmentName: ok('立交匝道段'),
      contactPhone: missing(),
      listNoticeNo: ok('G2026-030'),
      listTitle: ok('东港立交限行公告（单行/无值/零限值）'),
    },
    tables: {
      limitRows: [
        {
          identity: 'segment=立交匝道段|vehicleType=非机动车',
          fields: {
            segment: ok('立交匝道段'),
            vehicleType: ok('非机动车'),
            weightLimit: ok(0, 'kg'), // 零限值：status=ok，不是 none/error
            heightLimit: none('—'),
            restricted: ok(true),
            remark: ok('零限值=禁止，明确无值=未规定'),
          },
        },
        {
          identity: 'segment=立交匝道段|vehicleType=小型车',
          fields: {
            segment: ok('立交匝道段'),
            vehicleType: ok('小型车'),
            weightLimit: ok(10000, 'kg'),
            heightLimit: none('无限制'),
            restricted: ok(false),
            remark: none(''),
          },
        },
      ],
    },
  });
}

/** G2026-041：仅出现在列表第二页的公告（漏页检测素材），单页、结构规整 */
export function goldenNoticeD(): BusinessRecord {
  return buildRecord({
    identity: 'noticeNo=G2026-041|segmentName=高架主线段',
    identityParts: { noticeNo: 'G2026-041', segmentName: '高架主线段' },
    top: {
      noticeNo: ok('G2026-041'),
      publishDept: ok('区建交委'),
      effectiveDate: ok('2026-11-15'),
      segmentName: ok('高架主线段'),
      contactPhone: missing(),
      listNoticeNo: ok('G2026-041'),
      listTitle: ok('云崖高架限行公告（仅列表第二页）'),
    },
    tables: {
      limitRows: [
        {
          identity: 'segment=高架主线段|vehicleType=货车',
          fields: {
            segment: ok('高架主线段'),
            vehicleType: ok('货车'),
            weightLimit: ok(18000, 'kg'),
            heightLimit: ok(3.8, 'm'),
            restricted: ok(true),
            remark: ok('夜间禁行'),
          },
        },
        {
          identity: 'segment=高架主线段|vehicleType=小型车',
          fields: {
            segment: ok('高架主线段'),
            vehicleType: ok('小型车'),
            weightLimit: none('无限制'),
            heightLimit: none('无限制'),
            restricted: ok(false),
            remark: none('—'),
          },
        },
      ],
    },
    lists: {
      timeWindows: [
        { identity: 'windowRange=22:00-06:00', fields: { windowRange: ok('22:00-06:00'), windowNote: ok('夜间时段') } },
      ],
    },
  });
}

/** G2026-999：身份字段 noticeNo 选择器不命中 -> 记录级失败（error 与 missing 区分演示） */
export function goldenNoticeBad(): BusinessRecord {
  const top: Record<string, CanonicalValue> = {
    noticeNo: missing(),
    segmentName: missing(),
    contactPhone: missing(),
    listNoticeNo: ok('G2026-999'),
    listTitle: ok('格式异常公告（抽取失败素材）'),
  };
  return buildRecord({
    identity: '__broken_identity__:noticeNo,segmentName',
    identityParts: {},
    top,
    recordError: '业务身份字段缺失或失败: noticeNo, segmentName',
  });
}

/** v2 来源的真实业务变化：仅 A 公告货车限重 30t -> 28t（28000 kg），其余与 v1 相同 */
export function goldenNoticeA_v2(): BusinessRecord {
  const rec = goldenNoticeA();
  const truck = rec.nested.limitRows!.items.find(
    (i) => i.identity === 'segment=北岸接线段|vehicleType=货车',
  )!;
  truck.fields.weightLimit = f('weightLimit', ok(28000, 'kg'));
  return rec;
}
