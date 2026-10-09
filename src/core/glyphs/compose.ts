import { VmotionError } from '../model.js';
import type {
  GlyphAdjust,
  GlyphComponent,
  GlyphEntry,
  GlyphFill,
  GlyphSetDocument,
  GlyphStroke,
  IdsOperator,
} from './glyph-schema.js';
import { formatIds, idsLeaves, parseIds, type IdsNode } from './ids.js';
import { fmt, identity, multiply, polylinePath, transformPathData, type Affine } from './path-transform.js';

export type Box = { x: number; y: number; w: number; h: number };
/** A stroke centerline or fill outline placed in em space (y down, 0 = em top). */
export type PlacedStroke = { d: string; width: number; order: number; source: string };
export type PlacedFill = { d: string; rule: 'nonzero' | 'evenodd'; source: string };
export type ComposedGlyph = {
  char: string;
  advance: number;
  strokes: PlacedStroke[];
  fills: PlacedFill[];
  /** Normalized IDS when composed, undefined for explicit paths. */
  ids?: string;
  /** Leaf component boxes in em units (for previews and inspection). */
  parts: Array<{ ref: string; path: string; box: Box }>;
};
export type GlyphProblem = { char: string; code: string; message: string; missing?: string[] };

/** Default operator layouts; sets may override via document.operators. */
export const defaultOperatorLayout: Record<IdsOperator, { ratio?: number | number[]; inner?: [number, number, number, number] }> = {
  '⿰': { ratio: 0.5 },
  '⿱': { ratio: 0.5 },
  '⿲': { ratio: [1 / 3, 1 / 3, 1 / 3] },
  '⿳': { ratio: [1 / 3, 1 / 3, 1 / 3] },
  '⿴': { inner: [0.2, 0.2, 0.6, 0.6] },
  '⿵': { inner: [0.2, 0.3, 0.6, 0.64] },
  '⿶': { inner: [0.2, 0.06, 0.6, 0.62] },
  '⿷': { inner: [0.26, 0.2, 0.68, 0.6] },
  '⿸': { inner: [0.3, 0.3, 0.68, 0.68] },
  '⿹': { inner: [0.04, 0.3, 0.62, 0.68] },
  '⿺': { inner: [0.32, 0.04, 0.64, 0.64] },
  '⿻': {},
};

const clampShare = (v: number) => Math.max(0.05, Math.min(0.95, v));
const inBox = (b: Box, r: readonly number[]): Box => ({
  x: b.x + r[0] * b.w,
  y: b.y + r[1] * b.h,
  w: r[2] * b.w,
  h: r[3] * b.h,
});

export class GlyphComposer {
  readonly em: number;
  private readonly cache = new Map<string, ComposedGlyph | GlyphProblem>();
  constructor(readonly set: GlyphSetDocument) {
    this.em = set.metrics.em;
  }
  /** Whether the set can (attempt to) draw a character; does not validate it. */
  has(char: string) {
    return char in this.set.glyphs || (char in this.set.components && Array.from(char).length === 1);
  }
  advance(char: string) {
    const entry = this.set.glyphs[char];
    if (entry && typeof entry === 'object' && entry.advance !== undefined) return entry.advance;
    return this.set.metrics.advance;
  }
  kerning(a: string, b: string) {
    return this.set.kerning[a + b] ?? 0;
  }
  /** Compose one character; returns a problem instead of throwing for coverage reports. */
  glyph(char: string): ComposedGlyph | GlyphProblem {
    const hit = this.cache.get(char);
    if (hit) return hit;
    let result: ComposedGlyph | GlyphProblem;
    try {
      result = this.compose(char);
    } catch (e) {
      result = {
        char,
        code: e instanceof VmotionError ? e.code : 'GLYPH_COMPOSE',
        message: (e as Error).message,
        missing: e instanceof VmotionError ? ((e.details as { missing?: string[] })?.missing ?? undefined) : undefined,
      };
    }
    if (this.cache.size > 20000) this.cache.clear();
    this.cache.set(char, result);
    return result;
  }
  /** Compose an arbitrary IDS expression (live preview) with optional root adjustments. */
  composeExpression(
    expression: string,
    options: { adjust?: Record<string, GlyphAdjust>; advance?: number; char?: string } = {},
  ): ComposedGlyph {
    const tree = parseIds(expression),
      advance = options.advance ?? this.set.metrics.advance,
      out = this.empty(options.char ?? expression, advance);
    out.ids = formatIds(tree);
    this.placeTree(tree, this.body(advance), options.adjust ?? {}, '', out, [options.char ?? expression], 0);
    return this.finish(out);
  }
  private empty(char: string, advance: number): ComposedGlyph {
    return { char, advance, strokes: [], fills: [], parts: [] };
  }
  private body(advance: number): Box {
    const m = this.set.metrics.margin;
    return { x: m, y: m, w: Math.max(1, advance - 2 * m), h: Math.max(1, this.em - 2 * m) };
  }
  private compose(char: string): ComposedGlyph {
    const entry: GlyphEntry | undefined = this.set.glyphs[char];
    const advance = this.advance(char);
    if (entry === undefined) {
      const component = this.set.components[char];
      if (!component)
        throw new VmotionError('GLYPH_MISSING', `"${char}" is not in this glyph set`, { missing: [char] });
      const out = this.empty(char, advance);
      this.placeComponent(char, component, this.body(advance), out, [char], 0, '');
      return this.finish(out);
    }
    const spec = typeof entry === 'string' ? { ids: entry } : entry;
    const out = this.empty(char, advance);
    if (spec.ids) {
      const tree = parseIds(spec.ids);
      out.ids = formatIds(tree);
      // A glyph whose IDS is a single leaf naming itself must be a component.
      this.placeTree(tree, this.body(advance), spec.adjust ?? {}, '', out, [char], 0);
    }
    const full: Box = { x: 0, y: 0, w: advance, h: this.em };
    if (spec.strokes?.length || spec.fills?.length)
      this.placeShapes(
        { strokes: spec.strokes ?? [], fills: spec.fills ?? [] },
        full,
        out,
        char,
        0,
        false,
      );
    return this.finish(out);
  }
  private finish(out: ComposedGlyph): ComposedGlyph {
    const slant = this.set.style.slant;
    if (!slant) return out;
    const t = Math.tan((slant * Math.PI) / 180),
      base = this.set.metrics.ascent,
      // x' = x + (base - y)·t
      m: Affine = [1, 0, -t, 1, base * t, 0];
    for (const s of out.strokes) s.d = transformPathData(s.d, m);
    for (const f of out.fills) f.d = transformPathData(f.d, m);
    return out;
  }
  private placeTree(
    node: IdsNode,
    box: Box,
    adjust: Record<string, GlyphAdjust>,
    path: string,
    out: ComposedGlyph,
    stack: string[],
    depth: number,
  ) {
    if (depth > 24) throw new VmotionError('GLYPH_DEPTH', 'Glyph composition is nested deeper than 24 levels');
    const a = adjust[path];
    if (a?.box && path) box = inBox(box, a.box);
    if (a?.scale) {
      const cx = box.x + box.w / 2,
        cy = box.y + box.h / 2;
      box = { x: cx - (box.w * a.scale[0]) / 2, y: cy - (box.h * a.scale[1]) / 2, w: box.w * a.scale[0], h: box.h * a.scale[1] };
    }
    if (a?.offset) box = { ...box, x: box.x + a.offset[0] * box.w, y: box.y + a.offset[1] * box.h };
    if (node.kind === 'leaf') {
      this.placeRef(node.ref, box, out, stack, depth, path);
      return;
    }
    const childPath = (i: number) => (path ? `${path}.${i}` : String(i)),
      boxes = this.split(node, box, a, depth);
    node.children.forEach((child, i) => this.placeTree(child, boxes[i], adjust, childPath(i), out, stack, depth + 1));
  }
  /** Size of the gap between split parts for a box (shrinks with nesting). */
  private gap(box: Box, horizontal: boolean) {
    const size = horizontal ? box.w : box.h,
      ref = horizontal ? this.set.metrics.advance : this.em;
    return this.set.metrics.gap * Math.max(0.35, Math.min(1, size / ref));
  }
  private preferred(node: IdsNode, axis: 'width' | 'height'): number | undefined {
    if (node.kind !== 'leaf') return undefined;
    const c = this.set.components[node.ref];
    return c?.prefer?.[axis];
  }
  private split(node: Extract<IdsNode, { kind: 'op' }>, box: Box, a: GlyphAdjust | undefined, _depth: number): Box[] {
    const op = node.op,
      defaults = { ...defaultOperatorLayout[op], ...(this.set.operators[op] ?? {}) };
    const explicitRatio = a?.ratio ?? (node.params && node.params.length <= 3 ? (node.params.length === 1 ? node.params[0] : node.params) : undefined);
    if (op === '⿰' || op === '⿱') {
      const horizontal = op === '⿰',
        axis = horizontal ? 'width' : 'height';
      let r: number;
      if (typeof explicitRatio === 'number') r = explicitRatio;
      else {
        const first = this.preferred(node.children[0], axis),
          second = this.preferred(node.children[1], axis);
        r = first ?? (second !== undefined ? 1 - second : typeof defaults.ratio === 'number' ? defaults.ratio : 0.5);
      }
      r = clampShare(r);
      const g = this.gap(box, horizontal);
      if (horizontal) {
        const w1 = box.w * r - g / 2;
        return [
          { x: box.x, y: box.y, w: Math.max(1, w1), h: box.h },
          { x: box.x + box.w * r + g / 2, y: box.y, w: Math.max(1, box.w * (1 - r) - g / 2), h: box.h },
        ];
      }
      const h1 = box.h * r - g / 2;
      return [
        { x: box.x, y: box.y, w: box.w, h: Math.max(1, h1) },
        { x: box.x, y: box.y + box.h * r + g / 2, w: box.w, h: Math.max(1, box.h * (1 - r) - g / 2) },
      ];
    }
    if (op === '⿲' || op === '⿳') {
      const horizontal = op === '⿲',
        axis = horizontal ? 'width' : 'height';
      let shares: number[];
      if (Array.isArray(explicitRatio)) shares = [...explicitRatio];
      else {
        const d = Array.isArray(defaults.ratio) ? defaults.ratio : [1 / 3, 1 / 3, 1 / 3];
        shares = node.children.map((c, i) => this.preferred(c, axis) ?? d[i] ?? 1 / 3);
      }
      if (shares.length === 2) shares.push(Math.max(0.05, 1 - shares[0] - shares[1]));
      const total = shares.reduce((s, v) => s + v, 0);
      shares = shares.map((v) => v / total);
      const g = this.gap(box, horizontal),
        span = (horizontal ? box.w : box.h) - 2 * g,
        out: Box[] = [];
      let at = horizontal ? box.x : box.y;
      for (const share of shares) {
        const size = Math.max(1, span * share);
        out.push(horizontal ? { x: at, y: box.y, w: size, h: box.h } : { x: box.x, y: at, w: box.w, h: size });
        at += size + g;
      }
      return out;
    }
    if (op === '⿻') return [box, box];
    // Surround: outer gets the full box, inner gets its region.
    const outer = node.children[0],
      outerComponent = outer.kind === 'leaf' ? this.set.components[outer.ref] : undefined,
      inner =
        a?.inner ??
        (node.params?.length === 4 ? (node.params as [number, number, number, number]) : undefined) ??
        outerComponent?.inner ??
        defaults.inner ?? [0.2, 0.2, 0.6, 0.6];
    return [box, inBox(box, inner)];
  }
  private placeRef(ref: string, box: Box, out: ComposedGlyph, stack: string[], depth: number, path: string) {
    if (stack.includes(ref) && stack.length > 1)
      throw new VmotionError('GLYPH_CYCLE', `Component "${ref}" refers to itself`, { cycle: [...stack, ref] });
    const component = this.set.components[ref];
    if (component) {
      this.placeComponent(ref, component, box, out, stack, depth, path);
      return;
    }
    const entry = ref !== stack[0] ? this.set.glyphs[ref] : undefined;
    if (entry !== undefined) {
      const spec = typeof entry === 'string' ? { ids: entry } : entry;
      // Use another glyph as a component: map its body box into the slot.
      const advance = spec.advance ?? this.set.metrics.advance;
      if (spec.ids) {
        const tree = parseIds(spec.ids),
          sub = this.body(advance),
          scaleX = box.w / sub.w,
          scaleY = box.h / sub.h,
          mapped = (b: Box): Box => ({ x: box.x + (b.x - sub.x) * scaleX, y: box.y + (b.y - sub.y) * scaleY, w: b.w * scaleX, h: b.h * scaleY });
        // Place into a temporary glyph, then copy with the slot mapping.
        const temp = this.empty(ref, advance);
        this.placeTree(tree, sub, spec.adjust ?? {}, '', temp, [...stack, ref], depth + 1);
        const m: Affine = [scaleX, 0, 0, scaleY, box.x - sub.x * scaleX, box.y - sub.y * scaleY],
          k = Math.sqrt(Math.abs(scaleX * scaleY)) ** this.set.style.strokeScaling;
        for (const s of temp.strokes)
          out.strokes.push({ ...s, d: transformPathData(s.d, m), width: s.width * k, order: out.strokes.length });
        for (const f of temp.fills) out.fills.push({ ...f, d: transformPathData(f.d, m) });
        for (const p of temp.parts) out.parts.push({ ...p, path: path ? `${path}/${p.path}` : p.path, box: mapped(p.box) });
      }
      if (spec.strokes?.length || spec.fills?.length) {
        const sub = this.body(advance);
        this.placeShapes(
          { strokes: spec.strokes ?? [], fills: spec.fills ?? [] },
          { x: box.x - (sub.x * box.w) / sub.w, y: box.y - (sub.y * box.h) / sub.h, w: (advance * box.w) / sub.w, h: (this.em * box.h) / sub.h },
          out,
          ref,
          depth,
          true,
        );
      }
      return;
    }
    throw new VmotionError('GLYPH_COMPONENT', `Component "${ref}" is not defined`, { missing: [ref] });
  }
  private placeComponent(
    ref: string,
    component: GlyphComponent,
    box: Box,
    out: ComposedGlyph,
    stack: string[],
    depth: number,
    path: string,
  ) {
    if (component.inset) {
      const [l, t, r, b] = component.inset;
      box = { x: box.x + l * box.w, y: box.y + t * box.h, w: Math.max(1, box.w * (1 - l - r)), h: Math.max(1, box.h * (1 - t - b)) };
    }
    out.parts.push({ ref, path, box: { ...box } });
    if (component.ids) {
      if (stack.includes(ref) && stack.length > 1)
        throw new VmotionError('GLYPH_CYCLE', `Component "${ref}" refers to itself`, { cycle: [...stack, ref] });
      const tree = parseIds(component.ids);
      // Composed components fill the slot directly.
      this.placeTree(tree, box, {}, path ? `${path}/c` : 'c', out, [...stack, ref], depth + 1);
    }
    if (component.strokes.length || component.fills.length)
      this.placeShapes(component, box, out, ref, depth, true);
  }
  /**
   * Components are drawn in a square 0..em design box. With `fit`, the design box maps
   * onto the slot (non-uniform); stroke widths stay uniform and thin with nesting.
   */
  private placeShapes(
    shapes: { strokes: GlyphStroke[]; fills: GlyphFill[] },
    box: Box,
    out: ComposedGlyph,
    source: string,
    _depth: number,
    fit: boolean,
  ) {
    const sx = fit ? box.w / this.em : box.w / (box.w || 1),
      sy = fit ? box.h / this.em : box.h / (box.h || 1),
      m: Affine = fit ? [sx, 0, 0, sy, box.x, box.y] : [1, 0, 0, 1, box.x, box.y];
    const scale = fit ? Math.sqrt(Math.abs(sx * sy)) : 1,
      k = scale ** this.set.style.strokeScaling,
      roundness = this.set.style.roundness;
    for (const stroke of shapes.strokes) {
      let d: string;
      if (stroke.points) {
        const pts = stroke.points.map(([x, y]) => {
          const [tx, ty] = [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
          return [tx, ty] as [number, number];
        });
        d = polylinePath(pts, roundness, stroke.closed);
      } else d = transformPathData(stroke.d!, m);
      out.strokes.push({ d, width: this.set.style.strokeWidth * (stroke.width ?? 1) * k, order: out.strokes.length, source });
    }
    for (const fill of shapes.fills) out.fills.push({ d: transformPathData(fill.d, m), rule: fill.rule, source });
  }
}

export const isGlyphProblem = (v: ComposedGlyph | GlyphProblem): v is GlyphProblem => 'code' in v;

/** Components referenced (transitively, by name) by an IDS expression. */
export function idsReferences(expression: string) {
  return idsLeaves(parseIds(expression));
}
export { identity, multiply, fmt };
