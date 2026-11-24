/**
 * 内置模拟站点（内存路由，无 socket）。
 * 覆盖：嵌套续表、跨行跨列表头、脏/残缺 HTML、全角数字与等价单位、
 * 采集中换版（edition 切换）、分页/页面故障注入、真实业务变化、规则退化素材。
 * 全程不访问真实外站。
 */
import { contentHash, type FetchedPage, type Fetcher } from '../fetch/fetcher.js';

export type Edition = 'v1' | 'v2';

export interface MockState {
  edition: Edition;
  /** 注入故障的 URL 后缀 -> 故障类型 */
  faults: Map<string, 'error' | 'slow' | 'garbled'>;
  /** 已服务请求计数（用于演示"抓到一半换版"） */
  requests: number;
  /** 达到该请求数后自动切到 v2（模拟采集中换版） */
  switchAfter: number | null;
  /** slow 故障的挂起时长（毫秒），默认 10 分钟：足以在请求途中强杀进程 */
  slowDelayMs?: number;
}

export function createMockState(): MockState {
  return { edition: 'v1', faults: new Map(), requests: 0, switchAfter: null };
}

const BASE = 'http://mock.local';

export const MOCK_URLS = {
  base: BASE,
  list: `${BASE}/notice/list`,
  listP2: `${BASE}/notice/list?page=2`,
  detailA1: `${BASE}/notice/G2026-018?page=1`,
  detailA2: `${BASE}/notice/G2026-018?page=2`,
  detailB: `${BASE}/notice/G2026-021`,
  detailC: `${BASE}/notice/G2026-030`,
  detailBad: `${BASE}/notice/G2026-999`,
  revisionHeader: 'x-site-revision',
} as const;

/* ---------------------------------- 页面构造 ---------------------------------- */

function listPage(state: MockState): string {
  // v2 中 A 公告的业务值真实变化（限重 30t -> 28t），条目本身不增删
  const aWeight = state.edition === 'v1' ? '30吨' : '28吨';
  return `<!doctype html><html><head><meta charset="utf-8"><title>通行限制公示列表</title></head>
<body>
<h1>通行限制公告</h1>
<ul class="notice-list">
  <li class="notice-item">
    <span class="notice-no">G2026-018</span>
    <a class="notice-link" href="/notice/G2026-018?page=1">锦江大桥限行公告（含续表）</a>
    <span class="notice-dept">市公路局</span>
    <span class="notice-date">2026年11月2日</span>
  </li>
  <li class="notice-item">
    <span class="notice-no">G2026-021</span>
    <a class="notice-link" href="/notice/G2026-021">云岭隧道限行公告（脏HTML/全角单位）</a>
    <span class="notice-dept">县交通局</span>
    <span class="notice-date">2026/11/05</span>
  </li>
  <li class="notice-item">
    <span class="notice-no">G2026-030</span>
    <a class="notice-link" href="/notice/G2026-030">东港立交限行公告（单行/无值/零限值）</a>
    <span class="notice-dept">港务集团</span>
    <span class="notice-date">2026-11-10</span>
  </li>
  <li class="notice-item">
    <span class="notice-no">G2026-999</span>
    <a class="notice-link" href="/notice/G2026-999">格式异常公告（抽取失败素材）</a>
    <span class="notice-dept">未知</span>
  </li>
</ul>
<!-- 列表页本身也有分页 -->
<nav class="pager"><a class="next" href="/notice/list?page=2">下一页</a></nav>
<!-- 供回归断言的业务变化锚点（v2 变化）：当前列表预告值 -->
<data id="preview-weight" value="${aWeight}"></data>
</body></html>`;
}

function listPage2(): string {
  return `<!doctype html><html><body>
<ul class="notice-list">
  <li class="notice-item">
    <span class="notice-no">G2026-018</span>
    <a class="notice-link" href="/notice/G2026-018?page=1">锦江大桥限行公告（续页入口，同号不同航段在详情内区分）</a>
  </li>
</ul>
<nav class="pager"><span class="next disabled">下一页</span></nav>
</body></html>`;
}

/**
 * 公告 G2026-018：两个航段（北岸/南岸），表格跨行跨列表头 + 续页重复表头。
 */
function detailAPage1(state: MockState): string {
  const weight = state.edition === 'v1' ? '30吨' : '28吨';
  return `<!doctype html><html><head><meta charset="utf-8"></head><body>
<article class="notice-detail">
  <h1 class="title">锦江大桥通行限制公告</h1>
  <span id="notice-no">G2026-018</span>
  <span id="publish-dept">市公路局</span>
  <span id="effective-date">2026年11月3日</span>
  <p class="segment-name">北岸接线段</p>
  <table class="limit-table">
    <thead>
      <tr>
        <th rowspan="2">航段</th>
        <th rowspan="2">车型</th>
        <th colspan="2">限值</th>
        <th rowspan="2">是否限行</th>
        <th rowspan="2">备注</th>
      </tr>
      <tr><th>限重</th><th>限高</th></tr>
    </thead>
    <tbody>
      <tr><td>北岸接线段</td><td>货车</td><td>${weight}</td><td>4.5米</td><td>限行</td><td>早晚高峰</td></tr>
      <tr><td>北岸接线段</td><td>挂车</td><td>20t</td><td>4米</td><td>限行</td><td>—</td></tr>
      <tr><td>北岸接线段</td><td>小型车</td><td>无限制</td><td>无限制</td><td>不限行</td><td>&nbsp;</td></tr>
    </tbody>
  </table>
  <ul class="time-window">
    <li><span class="window-range">07:00-09:00</span><span class="window-note">早高峰</span></li>
    <li><span class="window-range">17:00-19:00</span><span class="window-note">晚高峰</span></li>
  </ul>
  <nav class="pager"><a class="next" href="/notice/G2026-018?page=2">下一页（续表）</a></nav>
</article>
</body></html>`;
}

function detailAPage2(): string {
  return `<!doctype html><html><body>
<article class="notice-detail">
  <span id="notice-no">G2026-018</span>
  <p class="segment-name">南岸引桥段</p>
  <table class="limit-table">
    <thead>
      <!-- 续页重复表头（跨行跨列原样重复，应被识别并跳过） -->
      <tr>
        <th rowspan="2">航段</th><th rowspan="2">车型</th>
        <th colspan="2">限值</th><th rowspan="2">是否限行</th><th rowspan="2">备注</th>
      </tr>
      <tr><th>限重</th><th>限高</th></tr>
    </thead>
    <tbody>
      <tr><td>南岸引桥段</td><td>货车</td><td>25 吨</td><td>4.2米</td><td>限行</td><td>全天候</td></tr>
      <tr><td>南岸引桥段</td><td>危险品车</td><td>10t</td><td>—</td><td>限行</td><td>持证通行</td></tr>
      <tr class="summary-row"><td colspan="6">注：本表为第 2 页续表，汇总行应跳过</td></tr>
    </tbody>
  </table>
  <nav class="pager"><span class="next disabled">下一页</span></nav>
</article>
</body></html>`;
}

/**
 * 公告 G2026-021：残缺/脏 HTML（未闭合标签、错位嵌套、全角数字、等价单位写法）。
 */
function detailB(): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<body class="broken">
<article class="notice-detail">
  <h1 class=title>云岭隧道通行限制公告
  <span id="notice-no">G2026-021</span>
  <span id="publish-dept">县交通局
  <span id="effective-date">2026/11/06</span>
  <p class="segment-name">隧道主段
  <table class="limit-table">
    <thead><tr><th>航段</th><th>车型</th><th>限重</th><th>限高</th><th>是否限行</th><th>备注</th></tr></thead>
    <tbody>
      <tr><td>隧道主段</td><td>货车</td><td>１５吨</td><td>４５０厘米</td><td>限行</td><td>全角数字等价写法
      <tr><td>隧道主段</td><td>挂车</td><td>15000 千克</td><td>4.5 m</td><td>限行</td><td>与上一行等价单位
      <!-- 残缺：tr/td 未闭合，解析器需容错 -->
      <tr><td>隧道主段<td>小型车<td>无限制<td>无限制<td>不限行<td>
    </tbody>
  </table>
  <ul class="time-window">
    <li><span class="window-range">全天</span><span class="window-note">隧道限速 60km/h</span></li>
  </ul>
</article>`;
}

/**
 * 公告 G2026-030：单页；零是有效限值；明确无值；选择器缺失字段（missing）。
 */
function detailC(): string {
  return `<!doctype html><html><body>
<article class="notice-detail">
  <h1 class="title">东港立交通行限制公告</h1>
  <span id="notice-no">G2026-030</span>
  <span id="publish-dept">港务集团</span>
  <span id="effective-date">2026-11-11</span>
  <p class="segment-name">立交匝道段</p>
  <table class="limit-table">
    <thead><tr><th>航段</th><th>车型</th><th>限重</th><th>限高</th><th>是否限行</th><th>备注</th></tr></thead>
    <tbody>
      <tr><td>立交匝道段</td><td>非机动车</td><td>0 吨</td><td>—</td><td>限行</td><td>零限值=禁止，明确无值=未规定</td></tr>
      <tr><td>立交匝道段</td><td>小型车</td><td>10t</td><td>无限制</td><td>不限行</td><td></td></tr>
    </tbody>
  </table>
  <!-- 页面没有 #contact-phone 元素：该字段应为 missing 而非 error/none -->
</article>
</body></html>`;
}

/**
 * 公告 G2026-999：结构异常，身份字段缺失 -> 记录级失败。
 */
function detailBad(): string {
  return `<html><body>
<article><h1>临时通知</h1><p>本公告格式调整中，编号信息缺失。</p>
<table><tr><td>未知航段</td><td>未知车型</td></tr></table>
</article></body></html>`;
}

/* ---------------------------------- 路由 ---------------------------------- */

function render(url: string, state: MockState): string {
  const u = new URL(url);
  const path = u.pathname;
  if (path === '/notice/list' && u.searchParams.get('page') === '2') return listPage2();
  if (path === '/notice/list') return listPage(state);
  if (path === '/notice/G2026-018' && u.searchParams.get('page') === '2') return detailAPage2();
  if (path === '/notice/G2026-018') return detailAPage1(state);
  if (path === '/notice/G2026-021') return detailB();
  if (path === '/notice/G2026-030') return detailC();
  if (path === '/notice/G2026-999') return detailBad();
  return '<html><body><h1>404</h1></body></html>';
}

/** 内存模拟抓取器：支持故障注入与换版 */
export class MockFetcher implements Fetcher {
  constructor(private readonly state: MockState) {}

  async fetch(url: string): Promise<FetchedPage> {
    this.state.requests += 1;
    if (this.state.switchAfter !== null && this.state.requests >= this.state.switchAfter) {
      this.state.edition = 'v2';
    }
    const faultKey = [...this.state.faults.keys()].find((k) => url.includes(k));
    if (faultKey) {
      const kind = this.state.faults.get(faultKey)!;
      if (kind === 'error') throw new Error(`模拟网络故障: ${url}`);
      if (kind === 'slow') {
        // 请求挂起：模拟"请求途中"，外部可在此窗口内强杀进程
        await new Promise<void>((resolve) => setTimeout(resolve, this.state.slowDelayMs ?? 600_000));
      }
      if (kind === 'garbled') {
        return { url, statusCode: 200, contentType: 'text/html', html: '<html><body>@@@乱码@@@', revision: 'garbled' };
      }
    }
    const html = render(url, this.state);
    const statusCode = html.includes('<h1>404</h1>') ? 404 : 200;
    return {
      url,
      statusCode,
      contentType: 'text/html; charset=utf-8',
      html,
      // 来源级修订标识：换版（edition 切换）才变化；页内业务变化归入新版
      revision: this.state.edition,
    };
  }
}

/** 独立的静态夹具站点：按固定快照提供，用于离线重放（不依赖可变 state） */
export class StaticFetcher implements Fetcher {
  private readonly pages = new Map<string, FetchedPage>();

  add(url: string, html: string, revision: string): this {
    this.pages.set(url, { url, statusCode: 200, contentType: 'text/html', html, revision });
    return this;
  }

  async fetch(url: string): Promise<FetchedPage> {
    const p = this.pages.get(url);
    if (!p) throw new Error(`StaticFetcher 未收录 URL: ${url}`);
    return { ...p };
  }
}

export function buildMockFixtures(): { url: string; html: string; revision: string }[] {
  const v1 = createMockState();
  const v2 = createMockState();
  v2.edition = 'v2';
  const urls = [MOCK_URLS.list, MOCK_URLS.listP2, MOCK_URLS.detailA1, MOCK_URLS.detailA2, MOCK_URLS.detailB, MOCK_URLS.detailC, MOCK_URLS.detailBad];
  return urls.map((url) => ({ url, html: render(url, v1), revision: 'v1' }))
    .concat(urls.map((url) => ({ url, html: render(url, v2), revision: 'v2' })));
}
