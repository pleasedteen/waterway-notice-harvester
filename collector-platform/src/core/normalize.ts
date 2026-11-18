/**
 * 文本/类型/单位归一化。
 * 等价表示（全角数字、同义单位、不同写法日期）归一后不产生业务差异。
 */
import type { CanonicalValue, FieldType } from './types.js';


const CJK_PUNCT = ['，', '。', '：', '；', '？', '！', '（', '）', '【', '】', '《', '》', '、', '“', '”', '‘', '’'];
const SENT_BEGIN = '\u0001';
const SENT_END = '\u0002';

export function normalizeText(raw: string): string {
  let s = raw;
  const restore: string[] = [];
  for (const p of CJK_PUNCT) {
    s = s.split(p).join(`${SENT_BEGIN}${restore.length}${SENT_END}`);
    restore.push(p);
  }
  s = s.normalize('NFKC');
  s = s.replace(/\u0001(\d+)\u0002/g, (_m, i: string) => restore[Number(i)] ?? '');
  return s
    .replace(/[　\s]+/g, ' ')
    .trim();
}


/** 单位别名 -> 规范单位（同一量纲统一到基准单位） */
const UNIT_ALIASES: Record<string, string> = {
  'kg': 'kg', '千克': 'kg', '公斤': 'kg',
  'g': 'g', '克': 'g',
  't': 't', '吨': 't',
  'm': 'm', '米': 'm',
  'cm': 'cm', '厘米': 'cm',
  'mm': 'mm', '毫米': 'mm',
  'km': 'km', '千米': 'km', '公里': 'km',
  '%': '%', '％': '%',
};

/** 换算到量纲基准：重量->kg，长度->m */
const TO_BASE: Record<string, { base: string; factor: number }> = {
  kg: { base: 'kg', factor: 1 },
  g: { base: 'kg', factor: 0.001 },
  t: { base: 'kg', factor: 1000 },
  m: { base: 'm', factor: 1 },
  cm: { base: 'm', factor: 0.01 },
  mm: { base: 'm', factor: 0.001 },
  km: { base: 'm', factor: 1000 },
};

export function normalizeUnit(rawUnit: string | null | undefined): string | null {
  if (!rawUnit) return null;
  const u = normalizeText(rawUnit).toLowerCase();
  return UNIT_ALIASES[u] ?? u;
}

/**
 * 把 (value, unit) 换算到量纲基准单位。
 * 例如 2 t -> 2000 kg；450 cm -> 4.5 m。无单位或不可换算单位原样返回。
 */
export function toBaseUnit(value: number, unit: string | null): { value: number; unit: string | null } {
  if (!unit) return { value, unit };
  const conv = TO_BASE[unit];
  if (!conv) return { value, unit };
  let v = value * conv.factor;
  // 去除浮点尾巴
  v = Number(v.toPrecision(12));
  return { value: v, unit: conv.base };
}

const CN_NUM: Record<string, number> = { '〇': 0, '零': 0, '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };

/** 解析数字：容忍全角、单位尾巴、千分位、简单中文数字（十/三十） */
export function parseNumber(raw: string): number | null {
  let s = normalizeText(raw);
  if (s === '') return null;
  // 纯中文短数字
  if (/^[〇零一二两三四五六七八九十]+$/.test(s)) {
    if (s === '十') return 10;
    if (s.startsWith('十')) return 10 + (CN_NUM[s.slice(1)] ?? NaN);
    if (s.endsWith('十')) return (CN_NUM[s[0] ?? ''] ?? NaN) * 10;
    if (s.includes('十')) {
      const [a, b] = s.split('十');
      return (CN_NUM[a ?? ''] ?? NaN) * 10 + (CN_NUM[b ?? ''] ?? NaN);
    }
    const digits = [...s].map((c) => CN_NUM[c]);
    if (digits.some((d) => d === undefined)) return null;
    return Number(digits.join(''));
  }
  s = s.replace(/[,，]/g, '');
  // 取第一个数字串（含小数/正负号），单位文字留在外部由调用方处理
  const m = s.match(/[-+]?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

/** 从文本中拆分数字与残余单位，如 "限高 4.5米" -> [4.5, "米"] */
export function splitNumberAndUnit(raw: string): { num: number; unitText: string | null } | null {
  const s = normalizeText(raw);
  const m = s.match(/[-+]?\d+(?:\.\d+)?/);
  if (!m) return null;
  const num = Number(m[0]);
  if (!Number.isFinite(num)) return null;
  const rest = normalizeText(s.replace(m[0], ' '));
  // 残余中的单位 token
  const unitText = rest ? rest.replace(/^(限[重高宽]?|限值|不超过|大于|小于|[:：])+/g, '').trim() || null : null;
  return { num, unitText };
}

export function parseBoolean(raw: string, trueWords: string[], falseWords: string[]): boolean | null {
  const s = normalizeText(raw).toLowerCase();
  const t = trueWords.length ? trueWords : ['是', 'true', 'yes', '1', '允许', '限行'];
  const f = falseWords.length ? falseWords : ['否', 'false', 'no', '0', '禁止', '不限行'];
  // 精确匹配优先，避免"不限行"子串命中"限行"
  if (t.some((w) => s === w.toLowerCase())) return true;
  if (f.some((w) => s === w.toLowerCase())) return false;
  if (t.some((w) => s.includes(w.toLowerCase()))) return true;
  if (f.some((w) => s.includes(w.toLowerCase()))) return false;
  return null;
}

/** 日期归一为 ISO yyyy-MM-dd；容忍 2026年11月3日 / 2026/11/3 / 2026-11-03 */
export function parseDate(raw: string): string | null {
  const s = normalizeText(raw);
  const m = s.match(/(\d{4})\s*[-/年.]\s*(\d{1,2})\s*[-/月.]\s*(\d{1,2})\s*日?/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(dt.getTime())) return null;
  return iso;
}

export function missingValue(): CanonicalValue {
  return { status: 'missing', value: null, unit: null };
}

export function noneValue(marker: string): CanonicalValue {
  return { status: 'none', value: null, unit: null, noneMarker: marker };
}

export function errorValue(error: string): CanonicalValue {
  return { status: 'error', value: null, unit: null, error };
}

export function okValue(value: string | number | boolean, unit: string | null): CanonicalValue {
  return { status: 'ok', value, unit };
}

/** 按类型把原始文本转换为 CanonicalValue（选择器已命中的前提下） */
export function coerce(
  rawText: string,
  type: FieldType,
  opts: {
    noneMarkers?: string[];
    unit?: string;
    unitFromFieldText?: string | null;
    booleanTrue?: string[];
    booleanFalse?: string[];
    precision?: number;
  },
): CanonicalValue {
  const text = normalizeText(rawText);
  const noneMarkers = opts.noneMarkers ?? ['—', '-', '–', '无', '无限制', '不限', '/', '空', 'N/A', 'NA'];
  if (noneMarkers.some((m) => text === m || text === normalizeText(m))) {
    return noneValue(text);
  }
  switch (type) {
    case 'string':
      return okValue(text, null);
    case 'boolean': {
      const b = parseBoolean(text, opts.booleanTrue ?? [], opts.booleanFalse ?? []);
      return b === null ? errorValue(`无法转换为布尔: "${text}"`) : okValue(b, null);
    }
    case 'date': {
      const iso = parseDate(text);
      return iso === null ? errorValue(`无法解析日期: "${text}"`) : okValue(iso, null);
    }
    case 'number': {
      const split = splitNumberAndUnit(text);
      if (!split) return errorValue(`无法解析数字: "${text}"`);
      let num = split.num;
      if (opts.precision !== undefined) {
        const p = 10 ** opts.precision;
        num = Math.round(num * p) / p;
      }
      const rawUnit = normalizeUnit(opts.unit ?? split.unitText ?? opts.unitFromFieldText ?? null);
      const base = toBaseUnit(num, rawUnit);
      // 0 是有效限值：status=ok, value=0
      return okValue(base.value, base.unit);
    }
  }
}

/** CanonicalValue 的稳定序列化（用于期望夹具比对） */
export function canonicalKey(v: CanonicalValue): string {
  if (v.status !== 'ok') return `${v.status}:${v.noneMarker ?? v.error ?? ''}`;
  return `ok:${typeof v.value === 'number' ? formatNum(v.value) : String(v.value)}${v.unit ? `@${v.unit}` : ''}`;
}

export function formatNum(n: number): string {
  return Number(n.toPrecision(12)).toString();
}
