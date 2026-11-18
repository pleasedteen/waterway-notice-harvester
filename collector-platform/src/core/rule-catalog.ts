/**
 * 模拟来源的声明式抽取规则。
 * 同一规则作用于列表中所有公告（含异常公告），不为任何页面写专用解析代码。
 * 规则版本不可变：v1 -> v2 只新增版本文档，旧版本永久保留可重放。
 */
import type { RuleDocument } from './types.js';

const commonTable = {
  kind: 'table' as const,
  field: 'limitRows',
  selector: 'table.limit-table',
  headerRows: 2,
  repeatHeaderMarkers: ['航段', '车型'],
  skipRowIf: 'text:注：',
  columns: {
    航段: 'segment',
    车型: 'vehicleType',
    限重: 'weightLimit',
    限高: 'heightLimit',
    是否限行: 'restricted',
    备注: 'remark',
  },
  fieldRules: {
    segment: { type: 'string' as const },
    vehicleType: { type: 'string' as const },
    weightLimit: { type: 'number' as const, noneMarkers: ['无限制', '—', '-', '/'] },
    heightLimit: { type: 'number' as const, noneMarkers: ['无限制', '—', '-', '/'] },
    restricted: { type: 'boolean' as const, booleanTrue: ['限行'], booleanFalse: ['不限行'] },
    remark: { type: 'string' as const, noneMarkers: ['—', '-', ''] },
  },
  itemIdentity: ['segment', 'vehicleType'],
};

const timeWindowList = {
  kind: 'list' as const,
  field: 'timeWindows',
  itemSelector: 'ul.time-window li',
  itemIdentity: ['windowRange'],
  itemFields: [
    { field: 'windowRange', type: 'string' as const, selector: '.window-range' },
    { field: 'windowNote', type: 'string' as const, selector: '.window-note', noneMarkers: ['', '—'] },
  ],
};

/** v1：基础规则 */
export const RULE_V1: RuleDocument = {
  ruleId: 'rule-mock-notice',
  version: '1.0.0',
  name: '通行限制公告通用抽取规则',
  createdAt: '2026-11-01T00:00:00.000Z',
  identity: ['noticeNo', 'segmentName'],
  list: {
    itemLinkSelector: 'a.notice-link',
    linkAttr: 'href',
    itemRootSelector: 'li.notice-item',
    pagination: {
      nextSelector: 'nav.pager a.next',
      disabledSelector: 'nav.pager span.next.disabled',
      maxPages: 5,
    },
    prefetchFields: [
      { field: 'listNoticeNo', type: 'string', selector: '.notice-no' },
      { field: 'listTitle', type: 'string', selector: '.notice-link' },
    ],
  },
  pagination: {
    nextSelector: 'nav.pager a.next',
    disabledSelector: 'nav.pager span.next.disabled',
    maxPages: 10,
  },
  fields: [
    { field: 'noticeNo', type: 'string', selector: '#notice-no' },
    { field: 'publishDept', type: 'string', selector: '#publish-dept' },
    { field: 'effectiveDate', type: 'date', selector: '#effective-date' },
    { field: 'segmentName', type: 'string', selector: '.segment-name' },
    // 站点没有该元素：演示 missing（选择器不命中），与 none/error 严格区分
    { field: 'contactPhone', type: 'string', selector: '#contact-phone' },
  ],
  nested: [commonTable, timeWindowList],
};

/**
 * v2：规则"进化"示例——新增窗口数量字段。
 * 回归演示中还会构造一个"退化"候选规则（改坏选择器），验证新增失败被捕获。
 */
export const RULE_V2: RuleDocument = {
  ...RULE_V1,
  version: '2.0.0',
  name: '通行限制公告通用抽取规则（增加窗口备注规范化）',
  createdAt: '2026-11-12T00:00:00.000Z',
  fields: [
    ...RULE_V1.fields,
    { field: 'crawlChannel', type: 'string', selector: 'meta[name=channel]', attr: 'content' },
  ],
};

/** 退化规则：把 noticeNo 选择器改坏 -> 身份字段抽取失败，回归必须报警 */
export const RULE_REGRESSED: RuleDocument = {
  ...RULE_V1,
  version: '9.9.9-bad',
  name: '退化候选规则（故意改坏，用于回归演示）',
  createdAt: '2026-11-15T00:00:00.000Z',
  fields: RULE_V1.fields.map((f) =>
    f.field === 'noticeNo' ? { ...f, selector: '#notice-no-renamed-and-missing' } : f,
  ),
};
