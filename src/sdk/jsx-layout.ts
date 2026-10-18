/*
 * Flexbox / grid layout for JSX elements. CSS layout keys in `style` are parsed here and
 * encoded for the taffy engine (src/core/layout/taffy.ts); the JSX lowering collects every
 * element inside a display:flex/grid group into one tree per frame, runs taffy once, and
 * writes the boxes back as plain x/y/width/height, so the renderer is unchanged.
 */
import { VmotionError } from '../core/model.js';

const fail = (code: string, message: string, details: Record<string, unknown>): never => {
  throw new VmotionError(code, message, details);
};

/** Keys that only make sense on a flex/grid container. */
export const containerKeys = new Set([
  'flexDirection',
  'flexWrap',
  'flexFlow',
  'justifyContent',
  'alignItems',
  'alignContent',
  'justifyItems',
  'placeItems',
  'placeContent',
  'gap',
  'rowGap',
  'columnGap',
  'gridGap',
  'gridTemplateColumns',
  'gridTemplateRows',
  'gridAutoColumns',
  'gridAutoRows',
  'gridAutoFlow',
]);
/** Keys that only make sense on a child of a flex/grid container. */
export const itemKeys = new Set([
  'flex',
  'flexGrow',
  'flexShrink',
  'flexBasis',
  'alignSelf',
  'justifySelf',
  'placeSelf',
  'gridColumn',
  'gridRow',
  'gridColumnStart',
  'gridColumnEnd',
  'gridRowStart',
  'gridRowEnd',
  'margin',
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'marginInline',
  'marginBlock',
]);
/** Box keys usable on any element that takes part in layout. */
export const boxKeys = new Set([
  'padding',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'paddingInline',
  'paddingBlock',
  'minWidth',
  'minHeight',
  'maxWidth',
  'maxHeight',
  'aspectRatio',
]);
export const layoutStyleKeys = new Set([...containerKeys, ...itemKeys, ...boxKeys]);

export type Spec = [kind: number, value: number];
const AUTO: Spec = [0, 0];
/** CSS length → [kind, value]: 0 auto, 1 px, 2 fraction of the parent (percent / 100). */
export function lengthSpec(value: unknown, where: string, at: string, allowAuto = true): Spec {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JSX_STYLE_VALUE', `${where} must be finite`, { at });
    return [1, value];
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === 'auto' && allowAuto) return AUTO;
    const m = /^(-?\d*\.?\d+(?:e-?\d+)?)\s*(px|%)?$/i.exec(s);
    if (m) return m[2] === '%' ? [2, Number(m[1]) / 100] : [1, Number(m[1])];
  }
  return fail(
    'JSX_STYLE_VALUE',
    `${where}: "${String(value)}" is not a supported length; use a number (px), "12px", "50%"${allowAuto ? ' or "auto"' : ''}`,
    { at, key: where },
  );
}
const words = (value: unknown) =>
  typeof value === 'number' ? [value] : String(value).trim().split(/\s+/);
/** 1–4 value shorthand (CSS order top right bottom left) → [left, right, top, bottom]. */
function sides(value: unknown, where: string, at: string, allowAuto: boolean): Spec[] {
  const parts = words(value).map((w) => lengthSpec(typeof w === 'string' && /^-?[\d.]+$/.test(w) ? Number(w) : w, where, at, allowAuto));
  if (parts.length < 1 || parts.length > 4)
    fail('JSX_STYLE_VALUE', `${where} takes 1-4 lengths`, { at, key: where });
  const [t, r = t, b = t, l = r] = parts;
  return [l, r, t, b];
}

const alignItemsMap: Record<string, number> = {
  normal: 0,
  start: 1,
  'self-start': 1,
  left: 1,
  end: 2,
  'self-end': 2,
  right: 2,
  'flex-start': 3,
  'flex-end': 4,
  center: 5,
  baseline: 6,
  'first baseline': 6,
  stretch: 7,
};
const alignContentMap: Record<string, number> = {
  normal: 0,
  start: 1,
  left: 1,
  end: 2,
  right: 2,
  'flex-start': 3,
  'flex-end': 4,
  center: 5,
  stretch: 6,
  'space-between': 7,
  'space-evenly': 8,
  'space-around': 9,
};
const enumValue = (map: Record<string, number>, value: unknown, key: string, at: string) => {
  const v = map[String(value).trim()];
  if (v === undefined)
    fail(
      'JSX_STYLE_VALUE',
      `${key}: "${String(value)}" is not supported; use ${Object.keys(map).join(', ')}`,
      { at, key },
    );
  return v as number;
};

/* ---------------------------------------------------------------- grid tracks */
type Track = [minKind: number, min: number, maxKind: number, max: number];
type TemplateItem = { repeat?: number; tracks: Track[] };
const splitTop = (text: string, sep: RegExp) => {
  const out: string[] = [];
  let depth = 0,
    cur = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && sep.test(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
};
function trackBreadth(token: string, at: string, key: string, side: 'min' | 'max'): Spec {
  const t = token.trim();
  if (t === 'auto') return [0, 0];
  if (t === 'min-content') return [3, 0];
  if (t === 'max-content') return [4, 0];
  const fr = /^(\d*\.?\d+)fr$/.exec(t);
  if (fr) {
    if (side === 'min')
      fail('JSX_STYLE_VALUE', `${key}: fr is not allowed as a minmax() minimum`, { at, key });
    return [5, Number(fr[1])];
  }
  const s = lengthSpec(/^-?[\d.]+$/.test(t) ? Number(t) : t, key, at, false);
  return [s[0], s[1]];
}
function track(token: string | number, at: string, key: string): Track {
  if (typeof token === 'number') return [1, token, 1, token];
  const t = token.trim();
  let m = /^minmax\((.*)\)$/.exec(t);
  if (m) {
    const [a, b] = splitTop(m[1], /,/);
    if (b === undefined) fail('JSX_STYLE_VALUE', `${key}: minmax() needs two values`, { at, key });
    const min = trackBreadth(a, at, key, 'min'),
      max = trackBreadth(b, at, key, 'max');
    return [min[0], min[1], max[0], max[1]];
  }
  m = /^fit-content\((.*)\)$/.exec(t);
  if (m) {
    const s = lengthSpec(/^-?[\d.]+$/.test(m[1].trim()) ? Number(m[1]) : m[1], key, at, false);
    return [0, 0, s[0] === 2 ? 7 : 6, s[1]];
  }
  const b = trackBreadth(t, at, key, 'max');
  // A bare flexible track is minmax(auto, Nfr) in CSS.
  if (b[0] === 5) return [0, 0, 5, b[1]];
  return [b[0], b[1], b[0], b[1]];
}
/** Parse gridTemplateColumns/Rows: "repeat(3, 1fr)", "200px 1fr auto", [120, "1fr"] or a count. */
export function parseTemplate(value: unknown, key: string, at: string): TemplateItem[] {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 1 || value > 1000)
      fail('JSX_STYLE_VALUE', `${key}: a number means that many equal 1fr tracks (1-1000)`, { at, key });
    return [{ repeat: value, tracks: [[0, 0, 5, 1]] }];
  }
  const tokens = Array.isArray(value) ? value : splitTop(String(value), /\s/);
  const out: TemplateItem[] = [];
  for (const token of tokens) {
    if (typeof token === 'string' && /^\[.*\]$/.test(token.trim()))
      fail('JSX_STYLE_UNSUPPORTED', `${key}: named grid lines are not supported; place items by line number or span`, { at, key });
    const m = typeof token === 'string' ? /^repeat\((.*)\)$/.exec(token.trim()) : null;
    if (m) {
      const [count, ...rest] = splitTop(m[1], /,/);
      const c = count.trim(),
        repeat = c === 'auto-fill' ? -1 : c === 'auto-fit' ? -2 : Number(c);
      if (repeat !== -1 && repeat !== -2 && (!Number.isInteger(repeat) || repeat < 1))
        fail('JSX_STYLE_VALUE', `${key}: repeat() count must be a positive integer, auto-fill or auto-fit`, { at, key });
      out.push({ repeat, tracks: splitTop(rest.join(','), /\s/).map((t) => track(t, at, key)) });
    } else out.push({ tracks: [track(token as string | number, at, key)] });
  }
  return out;
}
function placement(value: unknown, key: string, at: string): [Spec, Spec] {
  if (value === undefined) return [AUTO, AUTO];
  const one = (v: string | number): Spec => {
    if (typeof v === 'number') return [1, v];
    const t = v.trim();
    if (t === 'auto') return AUTO;
    const span = /^span\s+(\d+)$/.exec(t);
    if (span) return [2, Number(span[1])];
    if (/^-?\d+$/.test(t)) return [1, Number(t)];
    return fail('JSX_STYLE_UNSUPPORTED', `${key}: "${t}" is not supported; use a line number, "span N" or "auto" (no named areas)`, { at, key });
  };
  if (typeof value === 'number') return [[1, value], AUTO];
  const [a, b] = String(value).split('/');
  return [one(a), b === undefined ? AUTO : one(b)];
}

/* ---------------------------------------------------------------- encoding */
export type BoxKind = 'container' | 'free' | 'leaf' | 'text';
export interface LayoutInput {
  kind: BoxKind;
  display: 'flex' | 'grid' | 'block' | 'none';
  absolute: boolean;
  /** Size specs ([kind, value]) after defaults. */
  width: Spec;
  height: Spec;
  /** Margin [left, right, top, bottom]. */
  margin?: Spec[];
  /** Grid cell for free-group children (all children share cell 1/1). */
  cell?: boolean;
  style: Record<string, unknown>;
  at: string;
}
const overflowCode = (v: unknown) => (v === 'clip' ? 1 : v === 'hidden' ? 2 : 0);

/** Encode one box for the wasm stream (format in crates/vmotion-layout/src/lib.rs). */
export function encodeBox(parent: number, box: LayoutInput, out: number[]) {
  const s = box.style,
    at = box.at;
  const free = box.kind === 'free';
  out.push(parent, box.kind === 'text' ? 1 : 0);
  out.push(free ? 1 : { flex: 0, grid: 1, block: 2, none: 3 }[box.display]);
  out.push(box.absolute ? 1 : 0);
  // flex-flow shorthand
  let direction = s.flexDirection,
    wrap = s.flexWrap;
  if (s.flexFlow !== undefined)
    for (const w of String(s.flexFlow).split(/\s+/))
      if (/wrap/.test(w)) wrap ??= w;
      else direction ??= w;
  const dirCode =
    direction === undefined
      ? 0
      : enumValue({ row: 0, column: 1, 'row-reverse': 2, 'column-reverse': 3 }, direction, 'flexDirection', at);
  const wrapCode =
    wrap === undefined ? 0 : enumValue({ nowrap: 0, wrap: 1, 'wrap-reverse': 2 }, wrap, 'flexWrap', at);
  out.push(dirCode, wrapCode);
  const [placeAlign, placeJustify] =
    s.placeItems !== undefined ? String(s.placeItems).split(/\s+(?![^(]*\))/) : [];
  const [placeAC, placeJC] =
    s.placeContent !== undefined ? String(s.placeContent).split(/\s+/) : [];
  const [selfAlign, selfJustify] =
    s.placeSelf !== undefined ? String(s.placeSelf).split(/\s+/) : [];
  const jc = s.justifyContent ?? placeJC ?? placeAC;
  out.push(jc === undefined ? 0 : enumValue(alignContentMap, jc, 'justifyContent', at));
  const ai = s.alignItems ?? placeAlign;
  out.push(free ? 1 : ai === undefined ? 0 : enumValue(alignItemsMap, ai, 'alignItems', at));
  const as = s.alignSelf ?? selfAlign;
  out.push(box.cell ? 1 : as === undefined || as === 'auto' ? 0 : enumValue(alignItemsMap, as, 'alignSelf', at));
  const ac = s.alignContent ?? placeAC;
  out.push(ac === undefined ? 0 : enumValue(alignContentMap, ac, 'alignContent', at));
  const ji = s.justifyItems ?? placeJustify ?? placeAlign;
  out.push(free ? 1 : ji === undefined ? 0 : enumValue(alignItemsMap, ji, 'justifyItems', at));
  const js = s.justifySelf ?? selfJustify ?? selfAlign;
  out.push(box.cell ? 1 : js === undefined || js === 'auto' ? 0 : enumValue(alignItemsMap, js, 'justifySelf', at));
  out.push(
    s.gridAutoFlow === undefined
      ? 0
      : enumValue({ row: 0, column: 1, 'row dense': 2, dense: 2, 'column dense': 3 }, s.gridAutoFlow, 'gridAutoFlow', at),
  );
  const [ox, oy = ox] = s.overflow === undefined ? [undefined] : String(s.overflow).split(/\s+/);
  out.push(overflowCode(s.overflowX ?? ox), overflowCode(s.overflowY ?? oy));
  const dim = (v: unknown, key: string) => (v === undefined ? AUTO : lengthSpec(v, key, at));
  out.push(...box.width, ...box.height);
  out.push(...dim(s.minWidth, 'minWidth'), ...dim(s.minHeight, 'minHeight'));
  out.push(...dim(s.maxWidth, 'maxWidth'), ...dim(s.maxHeight, 'maxHeight'));
  // flex shorthand: number → grow 1 basis 0; "none"; "auto"; "g s basis"
  let grow = 0,
    shrink = 1,
    basis: Spec = AUTO;
  if (s.flex !== undefined) {
    const f = s.flex;
    if (typeof f === 'number') {
      grow = f;
      basis = [1, 0];
    } else if (f === 'none') shrink = 0;
    else if (f === 'auto') grow = 1;
    else {
      const parts = String(f).trim().split(/\s+/);
      grow = Number(parts[0]);
      if (parts[1] !== undefined && /^[\d.]+$/.test(parts[1])) shrink = Number(parts[1]);
      const b = parts.length === 3 ? parts[2] : parts[1] !== undefined && !/^[\d.]+$/.test(parts[1]) ? parts[1] : '0';
      basis = lengthSpec(/^[\d.]+$/.test(b) ? Number(b) : b, 'flex', at);
      if (!Number.isFinite(grow) || !Number.isFinite(shrink))
        fail('JSX_STYLE_VALUE', `flex: "${f}" is not supported; use a number, "none", "auto" or "grow shrink basis"`, { at, key: 'flex' });
    }
  }
  if (s.flexGrow !== undefined) grow = Number(s.flexGrow);
  if (s.flexShrink !== undefined) shrink = Number(s.flexShrink);
  if (s.flexBasis !== undefined) basis = lengthSpec(s.flexBasis, 'flexBasis', at);
  out.push(...basis);
  // inset (absolute children): left right top bottom
  const inset = ['left', 'right', 'top', 'bottom'].map((k) =>
    box.absolute && s[k] !== undefined ? lengthSpec(s[k], k, at) : AUTO,
  );
  for (const v of inset) out.push(...v);
  // margin
  let margin = box.margin ?? [AUTO, AUTO, AUTO, AUTO].map(() => [1, 0] as Spec);
  if (s.margin !== undefined) margin = sides(s.margin, 'margin', at, true);
  const inline = (key: string, a: number, b: number, into: Spec[], allowAuto: boolean) => {
    if (s[key] === undefined) return;
    const parts = words(s[key]).map((w) => lengthSpec(typeof w === 'string' && /^-?[\d.]+$/.test(w) ? Number(w) : w, key, at, allowAuto));
    into[a] = parts[0];
    into[b] = parts[1] ?? parts[0];
  };
  inline('marginInline', 0, 1, margin, true);
  inline('marginBlock', 2, 3, margin, true);
  (['marginLeft', 'marginRight', 'marginTop', 'marginBottom'] as const).forEach((k, i) => {
    if (s[k] !== undefined) margin[i] = lengthSpec(s[k], k, at);
  });
  for (const v of margin) out.push(...v);
  let padding: Spec[] = [[1, 0], [1, 0], [1, 0], [1, 0]];
  if (s.padding !== undefined) padding = sides(s.padding, 'padding', at, false);
  inline('paddingInline', 0, 1, padding, false);
  inline('paddingBlock', 2, 3, padding, false);
  (['paddingLeft', 'paddingRight', 'paddingTop', 'paddingBottom'] as const).forEach((k, i) => {
    if (s[k] !== undefined) padding[i] = lengthSpec(s[k], k, at, false);
  });
  for (const v of padding) out.push(...v);
  out.push(1, 0, 1, 0, 1, 0, 1, 0); // border widths are drawn as strokes, not laid out
  const gapParts = s.gap ?? s.gridGap;
  let rowGap: Spec = [1, 0],
    columnGap: Spec = [1, 0];
  if (gapParts !== undefined) {
    const parts = words(gapParts).map((w) => lengthSpec(typeof w === 'string' && /^-?[\d.]+$/.test(w) ? Number(w) : w, 'gap', at, false));
    rowGap = parts[0];
    columnGap = parts[1] ?? parts[0];
  }
  if (s.rowGap !== undefined) rowGap = lengthSpec(s.rowGap, 'rowGap', at, false);
  if (s.columnGap !== undefined) columnGap = lengthSpec(s.columnGap, 'columnGap', at, false);
  out.push(...columnGap, ...rowGap);
  if (!Number.isFinite(grow) || !Number.isFinite(shrink))
    fail('JSX_STYLE_VALUE', 'flexGrow/flexShrink must be numbers', { at });
  out.push(grow, shrink);
  let ratio = NaN;
  if (s.aspectRatio !== undefined) {
    const r = s.aspectRatio;
    ratio =
      typeof r === 'number'
        ? r
        : (() => {
            const [a, b = '1'] = String(r).split('/');
            return Number(a) / Number(b);
          })();
    if (!(ratio > 0)) fail('JSX_STYLE_VALUE', 'aspectRatio must be a positive number or "w / h"', { at, key: 'aspectRatio' });
  }
  out.push(ratio);
  const col = box.cell ? ([[1, 1], [1, 2]] as [Spec, Spec]) : placement(s.gridColumn, 'gridColumn', at);
  const row = box.cell ? ([[1, 1], [1, 2]] as [Spec, Spec]) : placement(s.gridRow, 'gridRow', at);
  if (s.gridColumnStart !== undefined) col[0] = placement(s.gridColumnStart, 'gridColumnStart', at)[0];
  if (s.gridColumnEnd !== undefined) col[1] = placement(s.gridColumnEnd, 'gridColumnEnd', at)[0];
  if (s.gridRowStart !== undefined) row[0] = placement(s.gridRowStart, 'gridRowStart', at)[0];
  if (s.gridRowEnd !== undefined) row[1] = placement(s.gridRowEnd, 'gridRowEnd', at)[0];
  out.push(...col[0], ...col[1], ...row[0], ...row[1]);
  const template = (items: TemplateItem[]) => {
    out.push(items.length);
    for (const item of items)
      if (item.repeat !== undefined) {
        out.push(1, item.repeat, item.tracks.length);
        for (const t of item.tracks) out.push(...t);
      } else out.push(0, ...item.tracks[0]);
  };
  const freeTemplate: TemplateItem[] = [{ tracks: [[0, 0, 5, 1]] }];
  template(free ? freeTemplate : s.gridTemplateColumns === undefined ? [] : parseTemplate(s.gridTemplateColumns, 'gridTemplateColumns', at));
  template(free ? freeTemplate : s.gridTemplateRows === undefined ? [] : parseTemplate(s.gridTemplateRows, 'gridTemplateRows', at));
  const autoTracks = (value: unknown, key: string) => {
    if (value === undefined) return out.push(0);
    const items = parseTemplate(typeof value === 'number' ? [value] : value, key, at);
    if (items.some((i) => i.repeat !== undefined))
      fail('JSX_STYLE_VALUE', `${key} takes plain track sizes (no repeat())`, { at, key });
    out.push(items.length);
    for (const i of items) out.push(...i.tracks[0]);
  };
  autoTracks(s.gridAutoColumns, 'gridAutoColumns');
  autoTracks(s.gridAutoRows, 'gridAutoRows');
}
