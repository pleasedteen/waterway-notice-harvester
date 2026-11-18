/**
 * 抓取抽象。生产用 HTTP 实现，验证用内存模拟实现（无 socket、无真实浏览器、无外站访问）。
 */
import { createHash } from 'node:crypto';

export interface FetchedPage {
  url: string;
  statusCode: number;
  contentType: string;
  html: string;
  /** 来源修订：优先取响应头 x-site-revision，否则回退为内容哈希 */
  revision: string;
}

export interface Fetcher {
  fetch(url: string): Promise<FetchedPage>;
}

export function contentHash(html: string): string {
  return createHash('sha256').update(html).digest('hex').slice(0, 16);
}

/** 生产 HTTP 抓取器（仅在显式配置真实来源时使用） */
export class HttpFetcher implements Fetcher {
  constructor(private readonly timeoutMs = 15000) {}

  async fetch(url: string): Promise<FetchedPage> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'user-agent': 'traffic-restriction-collector/1.0' },
      });
      const html = await res.text();
      const headerRev = res.headers.get('x-site-revision');
      return {
        url: res.url || url,
        statusCode: res.status,
        contentType: res.headers.get('content-type') ?? 'text/html',
        html,
        revision: headerRev ?? contentHash(html),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
