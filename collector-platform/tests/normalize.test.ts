/**
 * 归一化与容错单元测试：四态、0 限值、等价单位、全角数字、中文标点保护、脏 HTML。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeText, parseNumber, coerce, parseDate, parseBoolean, canonicalKey, toBaseUnit,
} from '../src/core/normalize.js';
import { sanitizeHtml } from '../src/core/html-sanitizer.js';
import { parseHtml } from '../src/core/extractor.js';

test('normalizeText: 全角数字/字母归一，中文全角标点保留', () => {
  assert.equal(normalizeText('１５吨'), '15吨');
  assert.equal(normalizeText('零限值=禁止，明确无值'), '零限值=禁止，明确无值');
  assert.equal(normalizeText('  多行\n  空白\t折叠 '), '多行 空白 折叠');
});

test('数字解析：千分位、全角、中文数字、单位尾巴', () => {
  assert.equal(parseNumber('1,234.5'), 1234.5);
  assert.equal(parseNumber('１５'), 15);
  assert.equal(parseNumber('三十'), 30);
  assert.equal(parseNumber('限重 4.5米'), 4.5);
});

test('单位换算到量纲基准', () => {
  assert.deepEqual(toBaseUnit(2, 't'), { value: 2000, unit: 'kg' });
  assert.deepEqual(toBaseUnit(450, 'cm'), { value: 4.5, unit: 'm' });
  assert.deepEqual(toBaseUnit(15000, 'kg'), { value: 15000, unit: 'kg' });
});

test('coerce number：0 是有效 ok 值，不是 none/error', () => {
  const v = coerce('0 吨', 'number', {});
  assert.equal(v.status, 'ok');
  assert.equal(v.value, 0);
  assert.equal(v.unit, 'kg');
});

test('coerce number：等价单位写法 canonical 相同', () => {
  const a = coerce('１５吨', 'number', {});
  const b = coerce('15000 千克', 'number', {});
  assert.equal(canonicalKey(a), canonicalKey(b));
  assert.equal(a.value, 15000);
  assert.equal(a.unit, 'kg');
});

test('四态区分：missing / none / error / ok', () => {
  assert.equal(coerce('无限制', 'number', { noneMarkers: ['无限制'] }).status, 'none');
  assert.equal(coerce('—', 'number', { noneMarkers: ['—'] }).status, 'none');
  assert.equal(coerce('abc', 'number', {}).status, 'error');
  assert.equal(coerce('12', 'number', {}).status, 'ok');
});

test('布尔精确匹配：不限行不等于限行', () => {
  assert.equal(parseBoolean('不限行', ['限行'], ['不限行']), false);
  assert.equal(parseBoolean('限行', ['限行'], ['不限行']), true);
  assert.equal(parseBoolean('未知', ['限行'], ['不限行']), null);
});

test('日期多写法归一为 ISO', () => {
  assert.equal(parseDate('2026年11月3日'), '2026-11-03');
  assert.equal(parseDate('2026/11/06'), '2026-11-06');
  assert.equal(parseDate('2026.11.10'), '2026-11-10');
  assert.equal(parseDate('不是日期'), null);
});

test('sanitizeHtml：未闭合 h1/p/span/td 被补全，后续内容不被吞', () => {
  const dirty = '<h1 class=title>标题<span id=x>x<span id=y>y<p class=seg>段<table><tr><td>a<td>b<tr><td>c<td>d</table>';
  const doc = parseHtml(dirty);
  assert.equal(doc.querySelector('#x')?.text, 'x');
  assert.equal(doc.querySelector('#y')?.text, 'y');
  assert.equal(doc.querySelector('.seg')?.text, '段');
  assert.equal(doc.querySelectorAll('table').length, 1);
  assert.equal(doc.querySelectorAll('td').length, 4);
});

test('sanitizeHtml：正常闭合文档不被破坏', () => {
  const ok = '<table><thead><tr><th rowspan="2">航段</th><th colspan="2">限值</th></tr><tr><th>限重</th><th>限高</th></tr></thead><tbody><tr><td>x</td><td>1</td><td>2</td></tr></tbody></table>';
  const doc = parseHtml(ok);
  assert.equal(doc.querySelectorAll('th').length, 4);
  assert.equal(doc.querySelectorAll('td').length, 3);
});
