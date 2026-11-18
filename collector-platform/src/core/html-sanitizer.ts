/**
 * 容错 HTML 预处理。
 * node-html-parser 对未闭合块级标签（如 <h1>..<p>..<table>）的容错有限，
 * 这里在解析前做通用修复：按 HTML 内容模型为块级元素补闭标签、为表格单元格补闭。
 * 规则是通用的标签栈处理，不针对任何具体页面/夹具。
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 表格/列表元素的同组互斥闭合 */
const AUTO_CLOSE_GROUPS: Record<string, string[]> = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  option: ['option'],
  tr: ['tr', 'td', 'th', 'thead', 'tbody', 'tfoot'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['thead', 'tbody', 'tfoot', 'tr'],
  tbody: ['thead', 'tbody', 'tfoot', 'tr'],
  tfoot: ['thead', 'tbody', 'tfoot', 'tr'],
  table: ['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
};

const INLINE_TAGS = new Set([
  'a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd',
  'label', 'mark', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'small', 'span', 'strong',
  'sub', 'sup', 'time', 'u', 'var', 'wbr',
]);

const BLOCK_TAGS = new Set([
  'html', 'body', 'article', 'section', 'nav', 'aside', 'header', 'footer', 'main',
  'div', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'form', 'blockquote', 'pre', 'figure',
  'figcaption', 'fieldset', 'details', 'summary',
]);

interface Token {
  type: 'open' | 'close' | 'text' | 'comment';
  tag?: string;
  raw: string;
  selfClosing: boolean;
}

const TOKEN_RE = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/[a-zA-Z][\w-]*\s*>|<[a-zA-Z][^>]*>|[^<]+/g;

function tokenize(html: string): Token[] {
  const tokens: Token[] = [];
  const matches = html.matchAll(TOKEN_RE);
  for (const m of matches) {
    const raw = m[0];
    if (raw.startsWith('<!--')) {
      tokens.push({ type: 'comment', raw, selfClosing: true });
    } else if (raw.startsWith('</')) {
      tokens.push({ type: 'close', tag: raw.slice(2, -1).trim().toLowerCase(), raw, selfClosing: false });
    } else if (raw.startsWith('<')) {
      const tagMatch = raw.match(/^<([a-zA-Z][\w-]*)/);
      const tag = tagMatch?.[1]?.toLowerCase();
      if (!tag) {
        tokens.push({ type: 'text', raw, selfClosing: true });
        continue;
      }
      const selfClosing = /\/\s*>$/.test(raw) || VOID_TAGS.has(tag);
      tokens.push({ type: 'open', tag, raw: selfClosing && !raw.endsWith('/>') ? `${raw.slice(0, -1)} />` : raw, selfClosing });
    } else {
      tokens.push({ type: 'text', raw, selfClosing: true });
    }
  }
  return tokens;
}

/**
 * 输出修复后的 HTML：补全缺失闭标签；多余闭标签丢弃；属性引号等解析器自身能容错的问题不处理。
 */
export function sanitizeHtml(html: string): string {
  const tokens = tokenize(html);
  const stack: Token[] = [];
  const out: string[] = [];

  const closeTop = (): void => {
    const t = stack.pop();
    if (t) out.push(`</${t.tag}>`);
  };

  for (const tok of tokens) {
    if (tok.type === 'text' || tok.type === 'comment') {
      out.push(tok.raw);
      continue;
    }
    if (tok.type === 'close') {
      const idx = stack.map((t) => t.tag).lastIndexOf(tok.tag);
      if (idx === -1) continue; // 多余闭标签
      while (stack.length > idx) closeTop();
      continue;
    }
    // open
    // 1) 表格/列表同组互斥闭合
    const group = AUTO_CLOSE_GROUPS[tok.tag!];
    if (group) {
      while (stack.length && group.includes(stack[stack.length - 1]!.tag!)) closeTop();
    }
    // 1b) 同级行内元素自动闭合：未闭合的 <span> 遇到下一个 <span> 等（脏 HTML 常见）
    if (INLINE_TAGS.has(tok.tag!)) {
      while (stack.length && stack[stack.length - 1]!.tag === tok.tag) closeTop();
    }
    // 2) 块级开标签：自动闭合栈顶未关闭的行内元素、p 与标题（HTML 内容模型）
    if (BLOCK_TAGS.has(tok.tag!)) {
      while (
        stack.length &&
        (INLINE_TAGS.has(stack[stack.length - 1]!.tag!) ||
          stack[stack.length - 1]!.tag === 'p' ||
          /^h[1-6]$/.test(stack[stack.length - 1]!.tag!))
      ) {
        closeTop();
      }
    }
    out.push(tok.raw);
    if (!tok.selfClosing) stack.push(tok);
  }
  while (stack.length) closeTop();
  return out.join('');
}
