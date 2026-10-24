import { describe, it, expect } from 'vitest';
import { h, toNodes, type ComponentContext } from '../src/sdk/index.js';
import { measureTextBlock } from '../src/core/text-layout.js';
import { newNode } from '../src/core/model.js';
import { TypographyLayout } from '../src/core/typography.js';
import { createCanvas } from '@napi-rs/canvas';

const ctx: ComponentContext = { frame: 0, seconds: 0, fps: 30, width: 1280, height: 720, seed: 1 };
const lines = (text: string, whiteSpace?: 'normal' | 'pre' | 'pre-wrap', width = 2000) =>
  measureTextBlock(text, { fontSize: 20, width, ...(whiteSpace ? { whiteSpace } : {}) }).lines;

describe('text whitespace (bug: leading spaces were dropped)', () => {
  it('keeps the legacy normal behaviour by default but no longer drops NBSP', () => {
    expect(lines('    return x')).toEqual(['return x']);
    expect(lines('a    b')).toEqual(['a    b']);
    expect(lines('one\n    two')).toEqual(['one', 'two']);
    expect(lines('\u00a0\u00a0return x')).toEqual(['\u00a0\u00a0return x']);
    expect(newNode({ id: 't', type: 'text', text: 'x' }).whiteSpace).toBeUndefined();
  });
  it('pre and pre-wrap preserve leading and repeated spaces', () => {
    const code = 'function f() {\n    if (x) {\n        return  y;\n    }\n}';
    expect(lines(code, 'pre')).toEqual(code.split('\n'));
    expect(lines(code, 'pre-wrap')).toEqual(code.split('\n'));
    expect(lines('  a   b', 'pre-wrap')).toEqual(['  a   b']);
  });
  it('pre never wraps while pre-wrap wraps without dropping spaces', () => {
    const long = '    alpha beta gamma delta epsilon';
    expect(lines(long, 'pre', 120)).toEqual([long]);
    const wrapped = lines(long, 'pre-wrap', 120);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped[0].startsWith('    alpha')).toBe(true);
    expect(wrapped.join('')).toBe(long);
    const normal = lines(long, 'normal', 120);
    expect(normal[0].startsWith('alpha')).toBe(true);
  });
  it('maps JSX style/prop whiteSpace onto the text node and rejects it elsewhere', () => {
    const [styled] = toNodes(h('text', { id: 'code', style: { whiteSpace: 'pre' } }, '  indented'), ctx),
      [prop] = toNodes(h('text', { id: 'code', whiteSpace: 'pre-wrap' }, '  indented'), ctx),
      [alias] = toNodes(h('text', { id: 'code', style: { whiteSpace: 'nowrap' } }, 'x'), ctx),
      [plain] = toNodes(h('text', { id: 'code' }, '  indented'), ctx);
    expect(styled.whiteSpace).toBe('pre');
    expect(styled.text).toBe('  indented');
    expect(prop.whiteSpace).toBe('pre-wrap');
    expect(alias.whiteSpace).toBe('pre');
    expect(plain.whiteSpace).toBeUndefined();
    expect(() => toNodes(h('rect', { id: 'r', style: { whiteSpace: 'pre' } }), ctx)).toThrow(/whiteSpace/);
    expect(() => toNodes(h('text', { id: 't', style: { whiteSpace: 'pre-line' } }, 'x'), ctx)).toThrow(/whiteSpace/);
  });
  it('separates typography layout cache entries by whiteSpace', () => {
    const engine = new TypographyLayout(),
      c = createCanvas(10, 10).getContext('2d'),
      base = newNode({ id: 't', type: 'text', text: '   x', width: 500, fontSize: 20 });
    expect(engine.lines(c, base)).toEqual(['x']);
    expect(engine.lines(c, { ...base, whiteSpace: 'pre' })).toEqual(['   x']);
  });
});
