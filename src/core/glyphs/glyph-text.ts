import type { SKRSContext2D } from '@napi-rs/canvas';
import type { Node, Snapshot } from '../model.js';
import { isGlyphProblem, type ComposedGlyph } from './compose.js';
import { drawComposedGlyph, drawTofu } from './glyph-draw.js';
import { sharedGlyphSets, type GlyphSetResolver, type PreparedGlyphSet } from './glyph-resources.js';
import type { GlyphFallback, GlyphSetDocument } from './glyph-schema.js';
import { GlyphComposer } from './compose.js';

const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const whitespace = /^\s+$/u;
export type CharKind = 'glyph' | 'font' | 'tofu' | 'none' | 'space';
export type TextSegment = { kind: CharKind; text: string; x: number; width: number; glyph?: ComposedGlyph };

/** What a text node needs to know about its glyph set at layout/draw time. */
export type GlyphTextSource = {
  /** Undefined when the node has no glyph set, or the set could not be resolved. */
  set?: { document: GlyphSetDocument; composer: GlyphComposer; hash: string };
  /** The node requested a set that could not be resolved (validation reports it). */
  unresolved?: boolean;
  fallback: GlyphFallback;
};
export const noGlyphs: GlyphTextSource = { fallback: 'font' };

export function glyphSourceFor(
  node: Pick<Node, 'glyphSet' | 'glyphFallback'>,
  snapshot?: Pick<Snapshot, 'files'>,
  resolver: GlyphSetResolver = sharedGlyphSets,
): GlyphTextSource {
  if (!node.glyphSet) return noGlyphs;
  const fallback = node.glyphFallback ?? 'font';
  const prepared: PreparedGlyphSet | undefined = resolver.tryResolve(snapshot ?? { files: {} }, node.glyphSet);
  return prepared ? { set: prepared, fallback } : { unresolved: true, fallback };
}
/** For SDK callers that pass a document directly (e.g. imported JSON). */
export function glyphSourceFromDocument(document: GlyphSetDocument, fallback: GlyphFallback = 'font'): GlyphTextSource {
  return { set: { document, composer: new GlyphComposer(document), hash: 'inline' }, fallback };
}
export const glyphSourceKey = (s: GlyphTextSource) =>
  s.set ? `${s.set.hash}:${s.fallback}` : s.unresolved ? `missing:${s.fallback}` : '';

/**
 * Width/segment measurement for strings that mix composed glyphs and font text. Font
 * runs are measured together (preserving font kerning/shaping); composed glyphs use their
 * advance plus set kerning. ctx.font must already be the node's font.
 */
export class MixedTextMeasurer {
  private readonly kinds = new Map<string, CharKind>();
  private readonly scale: number;
  readonly active: boolean;
  constructor(
    private readonly ctx: SKRSContext2D,
    readonly source: GlyphTextSource,
    readonly fontSize: number,
  ) {
    this.active = Boolean(source.set) || Boolean(source.unresolved);
    this.scale = source.set ? fontSize / source.set.document.metrics.em : fontSize / 1000;
  }
  kind(char: string): CharKind {
    if (!this.active) return 'font';
    let k = this.kinds.get(char);
    if (k) return k;
    const set = this.source.set;
    if (whitespace.test(char)) k = this.source.fallback === 'font' && !set?.composer.has(char) ? 'font' : 'space';
    else if (set && set.composer.has(char) && !isGlyphProblem(set.composer.glyph(char))) k = 'glyph';
    else k = this.source.fallback;
    this.kinds.set(char, k);
    return k;
  }
  glyph(char: string) {
    const g = this.source.set?.composer.glyph(char);
    return g && !isGlyphProblem(g) ? g : undefined;
  }
  private advance(char: string, kind: CharKind) {
    const doc = this.source.set?.document;
    if (kind === 'glyph') return this.source.set!.composer.advance(char) * this.scale;
    if (kind === 'tofu') return (doc?.metrics.advance ?? 1000) * this.scale;
    if (kind === 'space')
      return char === '\u3000'
        ? (doc?.metrics.advance ?? 1000) * this.scale
        : (doc?.metrics.space ?? 320) * this.scale * Array.from(char).length;
    return 0;
  }
  /** Split into kind runs with x offsets (font runs merged). */
  segments(text: string): TextSegment[] {
    if (!this.active) {
      const width = this.ctx.measureText(text).width;
      return [{ kind: 'font', text, x: 0, width }];
    }
    const out: TextSegment[] = [];
    let x = 0,
      previous: string | undefined;
    for (const { segment: char } of graphemes.segment(text)) {
      const kind = this.kind(char);
      if (kind === 'font') {
        const last = out.at(-1);
        if (last?.kind === 'font') {
          last.text += char;
          const w = this.ctx.measureText(last.text).width;
          x += w - last.width;
          last.width = w;
        } else {
          const w = this.ctx.measureText(char).width;
          out.push({ kind, text: char, x, width: w });
          x += w;
        }
        previous = undefined;
        continue;
      }
      if (kind === 'glyph' && previous) x += this.source.set!.composer.kerning(previous, char) * this.scale;
      const w = this.advance(char, kind);
      out.push({ kind, text: char, x, width: w, ...(kind === 'glyph' ? { glyph: this.glyph(char) } : {}) });
      x += w;
      previous = kind === 'glyph' ? char : undefined;
    }
    return out;
  }
  width(text: string) {
    if (!this.active) return this.ctx.measureText(text).width;
    const s = this.segments(text),
      last = s.at(-1);
    return last ? last.x + last.width : 0;
  }
  /** x of the grapheme starting at UTF-16 index `index` within `line` (kerning included). */
  offset(line: string, index: number) {
    if (!this.active || index <= 0) return this.ctx.measureText(line.slice(0, index)).width;
    const head = line.slice(0, index),
      tail = Array.from(graphemes.segment(line.slice(index)), (s) => s.segment)[0];
    if (!tail) return this.width(head);
    const s = this.segments(head + tail),
      last = s.at(-1)!;
    // If the next char merged into a font run, fall back to the prefix width.
    return last.kind === 'font' && last.text.length > tail.length ? this.width(head) : last.x;
  }
  /** Ink-ish bounding box for selection/inspection, like TextMetrics.actualBoundingBox*. */
  box(text: string, baseline: 'top' | 'alphabetic') {
    if (!this.active) {
      const m = this.ctx.measureText(text);
      return {
        x: -m.actualBoundingBoxLeft,
        y: -m.actualBoundingBoxAscent,
        width: Math.max(m.width, m.actualBoundingBoxRight) + m.actualBoundingBoxLeft,
        height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
      };
    }
    const segs = this.segments(text),
      doc = this.source.set?.document,
      em = doc?.metrics.em ?? 1000,
      ascent = doc?.metrics.ascent ?? 880;
    let left = Infinity,
      right = -Infinity,
      top = Infinity,
      bottom = -Infinity;
    for (const s of segs) {
      if (s.kind === 'font') {
        const m = this.ctx.measureText(s.text);
        left = Math.min(left, s.x - m.actualBoundingBoxLeft);
        right = Math.max(right, s.x + Math.max(m.width, m.actualBoundingBoxRight));
        top = Math.min(top, -m.actualBoundingBoxAscent);
        bottom = Math.max(bottom, m.actualBoundingBoxDescent);
      } else if (s.kind === 'glyph' || s.kind === 'tofu') {
        const y0 = baseline === 'top' ? 0 : -ascent * this.scale;
        left = Math.min(left, s.x);
        right = Math.max(right, s.x + s.width);
        top = Math.min(top, y0);
        bottom = Math.max(bottom, y0 + em * this.scale);
      }
    }
    if (!Number.isFinite(left)) return { x: 0, y: 0, width: this.width(text), height: 0 };
    return { x: left, y: top, width: right - left, height: bottom - top };
  }
  /** Draw one run at the current origin with the context's text baseline. */
  draw(text: string, strokeWidth: number, progress?: number) {
    const ctx = this.ctx;
    if (!this.active) {
      if (strokeWidth) ctx.strokeText(text, 0, 0);
      ctx.fillText(text, 0, 0);
      return;
    }
    const doc = this.source.set?.document,
      top = ctx.textBaseline === 'top' ? 0 : -(doc?.metrics.ascent ?? 880) * this.scale;
    for (const s of this.segments(text)) {
      if (s.kind === 'font') {
        if (strokeWidth) ctx.strokeText(s.text, s.x, 0);
        ctx.fillText(s.text, s.x, 0);
      } else if (s.kind === 'glyph' && s.glyph) {
        ctx.save();
        ctx.translate(s.x, top);
        drawComposedGlyph(ctx, s.glyph, doc!, this.fontSize, strokeWidth, progress);
        ctx.restore();
      } else if (s.kind === 'tofu') {
        ctx.save();
        ctx.translate(s.x, top);
        drawTofu(ctx, doc, this.fontSize, doc?.metrics.advance ?? 1000);
        ctx.restore();
      }
    }
  }
}
