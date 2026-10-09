import { FillType, Path2D, type SKRSContext2D } from '@napi-rs/canvas';
import type { ComposedGlyph } from './compose.js';
import type { GlyphSetDocument } from './glyph-schema.js';

type Geometry = { strokes: Array<{ path: Path2D; width: number }>; fills: Path2D[] };
const geometry = new WeakMap<ComposedGlyph, Geometry>();
function prepared(glyph: ComposedGlyph): Geometry {
  let g = geometry.get(glyph);
  if (!g) {
    g = {
      strokes: glyph.strokes.map((s) => ({ path: new Path2D(s.d), width: s.width })),
      fills: glyph.fills.map((f) => {
        const p = new Path2D(f.d);
        if (f.rule === 'evenodd') p.setFillType(FillType.EvenOdd);
        return p;
      }),
    };
    geometry.set(glyph, g);
  }
  return g;
}

/**
 * Draw a composed glyph whose em box top-left is at (0,0) in the current transform,
 * scaled so that em → size px. Uses the context's fillStyle for strokes and fills so that
 * fills/gradients/animator colours behave like font text. `outline` > 0 draws the text
 * stroke (context strokeStyle) first, matching strokeText-under-fillText order.
 */
export function drawComposedGlyph(
  ctx: SKRSContext2D,
  glyph: ComposedGlyph,
  set: GlyphSetDocument,
  size: number,
  outline = 0,
  progress = 1,
) {
  const k = size / set.metrics.em,
    g = prepared(glyph),
    style = set.style;
  ctx.save();
  ctx.scale(k, k);
  ctx.lineCap = style.cap;
  ctx.lineJoin = style.join;
  const strokes = progress >= 1 ? g.strokes : g.strokes.slice(0, Math.ceil(g.strokes.length * progress));
  if (outline > 0) {
    const extra = outline / k;
    for (const s of strokes) {
      ctx.lineWidth = s.width + extra;
      ctx.stroke(s.path);
    }
    ctx.lineWidth = extra;
    for (const f of g.fills) ctx.stroke(f);
  }
  const fill = ctx.fillStyle;
  ctx.strokeStyle = fill as string;
  for (const s of strokes) {
    ctx.lineWidth = s.width;
    ctx.stroke(s.path);
  }
  for (const f of g.fills) ctx.fill(f);
  ctx.restore();
}

/** Missing-glyph box (tofu) in the em box. */
export function drawTofu(ctx: SKRSContext2D, set: GlyphSetDocument | undefined, size: number, advance: number) {
  const em = set?.metrics.em ?? 1000,
    k = size / em,
    w = (set?.style.strokeWidth ?? 60) * 0.6;
  ctx.save();
  ctx.scale(k, k);
  ctx.strokeStyle = ctx.fillStyle as string;
  ctx.lineWidth = w;
  ctx.lineJoin = 'miter';
  ctx.strokeRect(advance * 0.15, em * 0.12, advance * 0.7, em * 0.76);
  ctx.restore();
}
