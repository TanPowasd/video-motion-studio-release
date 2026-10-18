/*
 * Lightweight TS/TSX highlighting and completion for the code workspace (no editor library):
 * a single-pass tokenizer good enough for component files, and context-aware word lists for
 * Vmotion JSX (intrinsic tags, node props, style keys, SDK helpers).
 */
import { nodeBaseSchema } from '../core/model.js';
import { supportedStyleKeys } from '../sdk/jsx-style.js';

export type TokenKind =
  | 'plain'
  | 'comment'
  | 'string'
  | 'number'
  | 'keyword'
  | 'tag'
  | 'attr'
  | 'fn'
  | 'punct';
export interface Token {
  text: string;
  kind: TokenKind;
}
const keywords = new Set(
  'import export from default const let var function return if else for while do switch case break continue new typeof instanceof in of as type interface extends implements class this null undefined true false void try catch finally throw async await yield readonly keyof enum declare namespace satisfies'.split(
    ' ',
  ),
);

/** Tokenize TS/TSX source. JSX tags and their attribute names get their own kinds. */
export function tokenize(src: string, tsx = true): Token[] {
  const out: Token[] = [];
  let i = 0,
    inTag = false;
  const push = (text: string, kind: TokenKind) => {
    if (!text) return;
    const last = out.at(-1);
    if (last && last.kind === kind) last.text += text;
    else out.push({ text, kind });
  };
  while (i < src.length) {
    const c = src[i],
      rest = src.slice(i, i + 2);
    if (rest === '//') {
      const end = src.indexOf('\n', i);
      const j = end < 0 ? src.length : end;
      push(src.slice(i, j), 'comment');
      i = j;
      continue;
    }
    if (rest === '/*') {
      const end = src.indexOf('*/', i + 2),
        j = end < 0 ? src.length : end + 2;
      push(src.slice(i, j), 'comment');
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break;
        j++;
      }
      push(src.slice(i, j + 1), 'string');
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0x[0-9a-f]+|\d*\.?\d+(e[+-]?\d+)?)/i.exec(src.slice(i))!;
      push(m[0], 'number');
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i))!,
        word = m[0],
        opensTag = src[i - 1] === '<' || (src[i - 1] === '/' && src[i - 2] === '<');
      let kind: TokenKind = 'plain';
      if (tsx && opensTag) {
        kind = 'tag';
        inTag = true;
      } else if (inTag && src[i + word.length] === '=') kind = 'attr';
      else if (keywords.has(word)) kind = 'keyword';
      else if (src[i + word.length] === '(') kind = 'fn';
      push(word, kind);
      i += word.length;
      continue;
    }
    if (c === '>' && inTag) inTag = false;
    push(c, /[{}()[\];,.<>=+\-*/!?:&|]/.test(c) ? 'punct' : 'plain');
    i++;
  }
  return out;
}

const intrinsicTags = [
  'group',
  'rect',
  'ellipse',
  'path',
  'text',
  'formula',
  'image',
  'video',
  'chart',
  'drawing',
  'scene',
  'component',
  'scene3d',
  'program',
  'node',
];
const containers = ['Stage', 'LocalTime', 'Steps', 'Step'];
const nodeProps = [
  ...Object.keys(nodeBaseSchema.shape).filter(
    (k) => !['id', 'type', 'parentId', 'overrides'].includes(k),
  ),
  'id',
  'key',
  'style',
  'scale',
  'origin',
  'skewX',
  'skewY',
  'zIndex',
  'd',
  'src',
  'asset',
  'tex',
  'trimStart',
  'playbackRate',
  'background',
  'start',
  'duration',
  'offset',
];
const sdk = [
  'defineComponent',
  'useClock',
  'remap',
  'springTo',
  'springSettle',
  'beatClock',
  'mixColor',
  'cycle',
  'toFrames',
  'random',
  'easings',
  'progress',
  'tween',
  'stagger',
  'measureTextBlock',
  ...containers,
];

export type CompletionContext = 'tag' | 'prop' | 'style' | 'code';
/** What kind of word the caret is in, and its prefix. */
export function completionContext(src: string, caret: number): { kind: CompletionContext; prefix: string; start: number } {
  const before = src.slice(0, caret),
    m = /[A-Za-z_$][\w$]*$/.exec(before),
    prefix = m?.[0] ?? '',
    start = caret - prefix.length,
    head = before.slice(0, start);
  if (/<\/?$/.test(head)) return { kind: 'tag', prefix, start };
  const styleOpen = head.lastIndexOf('style={{');
  if (styleOpen >= 0) {
    const inner = head.slice(styleOpen + 8);
    let depth = 0;
    for (const ch of inner) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    // Still inside the style object, at a key position (no ':' since the last ',' or '{').
    if (depth >= 0 && !inner.includes('}}') && !/:[^,{]*$/.test(inner)) return { kind: 'style', prefix, start };
  }
  const lt = head.lastIndexOf('<'),
    gt = head.lastIndexOf('>');
  if (lt > gt && /^<[A-Za-z]/.test(head.slice(lt)) && /\s$/.test(head)) {
    // Inside an opening tag, at an attribute position (not inside {...}).
    const tagText = head.slice(lt);
    let depth = 0;
    for (const ch of tagText) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) return { kind: 'prop', prefix, start };
  }
  return { kind: 'code', prefix, start };
}
export function completions(src: string, caret: number, limit = 8) {
  const ctx = completionContext(src, caret);
  if (!ctx.prefix && ctx.kind === 'code') return { ...ctx, items: [] as string[] };
  const pool =
    ctx.kind === 'tag'
      ? [...intrinsicTags, ...containers]
      : ctx.kind === 'prop'
        ? nodeProps
        : ctx.kind === 'style'
          ? supportedStyleKeys
          : sdk;
  const p = ctx.prefix.toLowerCase();
  const items = [...new Set(pool)]
    .filter((w) => w.toLowerCase().startsWith(p) && w !== ctx.prefix)
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .slice(0, limit);
  return { ...ctx, items };
}
