import { VmotionError } from '../model.js';
import { idsOperators, type IdsOperator } from './glyph-schema.js';

/**
 * Unicode Ideographic Description Sequences with two small extensions:
 *   ⿰[0.3]氵⿱木口   — optional [ratio] / [a,b,c] / [x,y,w,h] after an operator
 *   ⿰{left-water}可  — {name} references a multi-character component ID
 */
export type IdsNode =
  | { kind: 'leaf'; ref: string; offset: number }
  | {
      kind: 'op';
      op: IdsOperator;
      params?: number[];
      children: IdsNode[];
      offset: number;
    };

const ternary = new Set<string>(['⿲', '⿳']);
const operatorSet = new Set<string>(idsOperators);
/** Unicode 15.1 operators that this renderer does not lay out yet. */
const unsupported = new Set(['⿼', '⿽', '⿾', '⿿', '㇯']);
export const MAX_IDS_DEPTH = 16;
export const isIdsOperator = (c: string): c is IdsOperator => operatorSet.has(c);
export const operatorArity = (op: IdsOperator) => (ternary.has(op) ? 3 : 2);

const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });

function fail(message: string, expression: string, offset: number): never {
  throw new VmotionError('GLYPH_IDS', `${message} (at ${offset} in "${expression}")`, {
    expression,
    offset,
  });
}

export function parseIds(expression: string): IdsNode {
  const chars = Array.from(graphemes.segment(expression.trim()), (s) => s.segment);
  if (!chars.length) fail('Empty IDS expression', expression, 0);
  let at = 0;
  const node = (depth: number): IdsNode => {
    if (depth > MAX_IDS_DEPTH) fail(`IDS nesting exceeds ${MAX_IDS_DEPTH}`, expression, at);
    while (at < chars.length && /^\s$/.test(chars[at])) at++;
    if (at >= chars.length) fail('IDS expression ended early; an operator is missing a part', expression, at);
    const offset = at,
      c = chars[at++];
    if (unsupported.has(c)) fail(`IDS operator ${c} is not supported yet`, expression, offset);
    if (isIdsOperator(c)) {
      let params: number[] | undefined;
      if (chars[at] === '[') {
        const close = chars.indexOf(']', at);
        if (close < 0) fail('Missing ] after operator parameters', expression, at);
        const text = chars.slice(at + 1, close).join('');
        params = text.split(',').map((v) => Number(v.trim()));
        if (!text.trim() || params.some((v) => !Number.isFinite(v) || v <= 0 || v > 1))
          fail('Operator parameters must be numbers in (0, 1]', expression, at);
        if (params.length > 4) fail('At most 4 operator parameters', expression, at);
        at = close + 1;
      }
      const children = Array.from({ length: operatorArity(c) }, () => node(depth + 1));
      return { kind: 'op', op: c, params, children, offset };
    }
    if (c === '{') {
      const close = chars.indexOf('}', at);
      if (close < 0) fail('Missing } after component name', expression, at);
      const ref = chars.slice(at, close).join('').trim();
      if (!ref || ref.length > 40) fail('Component name must be 1–40 characters', expression, at);
      at = close + 1;
      return { kind: 'leaf', ref, offset };
    }
    if (c === '[' || c === ']' || c === '}' || c === ',')
      fail(`Unexpected "${c}"`, expression, offset);
    return { kind: 'leaf', ref: c, offset };
  };
  const root = node(0);
  while (at < chars.length && /^\s$/.test(chars[at])) at++;
  if (at < chars.length)
    fail('Extra characters after a complete IDS expression; add an operator', expression, at);
  return root;
}

/** Canonical text form; parseIds(formatIds(x)) round-trips. */
export function formatIds(node: IdsNode): string {
  if (node.kind === 'leaf') return Array.from(node.ref).length === 1 ? node.ref : `{${node.ref}}`;
  return (
    node.op +
    (node.params ? `[${node.params.map((v) => +v.toFixed(4)).join(',')}]` : '') +
    node.children.map(formatIds).join('')
  );
}

export function idsLeaves(node: IdsNode, out: string[] = []): string[] {
  if (node.kind === 'leaf') out.push(node.ref);
  else for (const child of node.children) idsLeaves(child, out);
  return out;
}

/** Look up a node by its dotted child path ("" is the root). */
export function idsNodeAt(root: IdsNode, path: string): IdsNode | undefined {
  let current: IdsNode | undefined = root;
  for (const part of path ? path.split('.') : []) {
    if (!current || current.kind !== 'op') return undefined;
    current = current.children[Number(part)];
  }
  return current;
}
